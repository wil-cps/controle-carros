/**
 * AutoManage Toledo - servidor na Cloudflare (Workers + D1 + KV)
 *
 * - D1 (binding DB): banco SQL com usuários, sessões, veículos, despesas, documentos e parcelas
 * - KV (binding ARQUIVOS): conteúdo das fotos e documentos anexados
 * - Assets (binding ASSETS): telas do sistema (pasta public/)
 *
 * Perfis de acesso:
 *  - full:         acesso total, edita dados e gerencia usuários
 *  - visualizacao: somente leitura, apenas dos veículos em que é sócio
 */
import BASE_PLANILHA from './base-planilha.json';

const SESSION_COOKIE = 'automanage_sid';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 horas
const PERFIS = ['full', 'visualizacao'];
// Administrador criado automaticamente quando não há usuários (senha precisa ser trocada no 1º login)
const ADMIN_PADRAO = { nome: 'Administrador', login: 'admin', senha: 'admin' };

// PBKDF2-SHA256. O número de iterações fica gravado em cada senha e pode ser aumentado depois.
// O plano gratuito limita o processamento a ~10 ms por acesso; 30 mil iterações levam ~4 ms.
const PBKDF2_ITERACOES = 30000;
const PBKDF2_MAX_ITERACOES = 100000; // máximo aceito pelo Workers

const MAX_TENTATIVAS = 10;
const JANELA_TENTATIVAS_MS = 15 * 60 * 1000;

// O KV aceita até 25 MiB por valor; o arquivo chega em base64 (≈ 33% maior que o original)
const MAX_ARQUIVO_BYTES = 25 * 1024 * 1024 - 1024;
// Cada comando leva os registros em um único parâmetro JSON (limite do D1: 2 MB por valor)
const MAX_BYTES_POR_COMANDO = 900 * 1024;

const TABELAS_FILHAS = ['despesas', 'documentos', 'pagamentos'];

class ErroHttp extends Error {
  constructor(status, mensagem, extra = {}) {
    super(mensagem);
    this.status = status;
    this.extra = extra;
  }
}

// ----------------------------------------------------------------------------
// Utilitários
// ----------------------------------------------------------------------------
const encoder = new TextEncoder();

function paraHex(bytes) {
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}

function deHex(texto) {
  const pares = String(texto).match(/.{1,2}/g) || [];
  return new Uint8Array(pares.map(p => parseInt(p, 16)));
}

function bytesAleatorios(n) {
  return crypto.getRandomValues(new Uint8Array(n));
}

async function sha256Hex(texto) {
  return paraHex(await crypto.subtle.digest('SHA-256', encoder.encode(texto)));
}

function iguaisTempoConstante(a, b) {
  if (a.length !== b.length) return false;
  let diferenca = 0;
  for (let i = 0; i < a.length; i++) diferenca |= a[i] ^ b[i];
  return diferenca === 0;
}

async function pbkdf2(senha, salt, iteracoes) {
  const chave = await crypto.subtle.importKey('raw', encoder.encode(senha), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iteracoes }, chave, 256);
  return new Uint8Array(bits);
}

async function hashSenha(senha) {
  const salt = bytesAleatorios(16);
  const hash = await pbkdf2(senha, salt, PBKDF2_ITERACOES);
  return `pbkdf2$${PBKDF2_ITERACOES}$${paraHex(salt)}$${paraHex(hash)}`;
}

async function conferirSenha(senha, armazenado) {
  const [algoritmo, iteracoesTxt, saltHex, hashHex] = String(armazenado).split('$');
  const iteracoes = Number(iteracoesTxt);
  if (algoritmo !== 'pbkdf2' || !saltHex || !hashHex || !(iteracoes > 0 && iteracoes <= PBKDF2_MAX_ITERACOES)) {
    return false;
  }
  const calculado = await pbkdf2(senha, deHex(saltHex), iteracoes);
  return iguaisTempoConstante(calculado, deHex(hashHex));
}

// Hash fixo para comparar mesmo quando o login não existe (não revela usuários pelo tempo de resposta)
let hashFicticio = null;
async function obterHashFicticio() {
  if (!hashFicticio) hashFicticio = await hashSenha(paraHex(bytesAleatorios(12)));
  return hashFicticio;
}

function json(status, corpo, headers = {}) {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers }
  });
}

async function lerCorpoJson(request) {
  try {
    return (await request.json()) || {};
  } catch (e) {
    throw new ErroHttp(400, 'Corpo da requisição inválido.');
  }
}

function lerCookie(request, nome) {
  const header = request.headers.get('Cookie') || '';
  for (const parte of header.split(';')) {
    const [chave, ...resto] = parte.trim().split('=');
    if (chave === nome) return decodeURIComponent(resto.join('='));
  }
  return null;
}

function cookieSessao(url, token, maxAgeMs) {
  const atributos = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`
  ];
  if (url.protocol === 'https:') atributos.push('Secure');
  return atributos.join('; ');
}

function ipDoCliente(request) {
  return request.headers.get('CF-Connecting-IP') || 'local';
}

function validarTexto(valor, campo, { min = 1, max = 100 } = {}) {
  const texto = String(valor ?? '').trim();
  if (texto.length < min) return `${campo} é obrigatório.`;
  if (texto.length > max) return `${campo} deve ter no máximo ${max} caracteres.`;
  return null;
}

function validarSenha(senha) {
  if (typeof senha !== 'string' || senha.length < 6) return 'A senha deve ter pelo menos 6 caracteres.';
  if (senha.length > 200) return 'Senha muito longa.';
  return null;
}

// Divide uma lista em partes cujo JSON cabe em um parâmetro do D1
function dividirPorTamanho(itens) {
  const partes = [];
  let atual = [];
  let tamanho = 2;
  for (const item of itens) {
    const t = JSON.stringify(item).length + 1;
    if (atual.length && tamanho + t > MAX_BYTES_POR_COMANDO) {
      partes.push(atual);
      atual = [];
      tamanho = 2;
    }
    atual.push(item);
    tamanho += t;
  }
  if (atual.length) partes.push(atual);
  return partes;
}

// ----------------------------------------------------------------------------
// Banco de dados (D1)
// ----------------------------------------------------------------------------
const USER_COLUMNS = 'id, nome, login, perfil, ativo, trocar_senha, criado_em';

async function todos(stmt) {
  return (await stmt.all()).results || [];
}

async function getMeta(env, chave, padrao = null) {
  const row = await env.DB.prepare('SELECT valor FROM meta WHERE chave = ?').bind(chave).first();
  return row ? row.valor : padrao;
}

function stmtSetMeta(env, chave, valor) {
  return env.DB.prepare('INSERT INTO meta (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor')
    .bind(chave, String(valor));
}

async function listarUsuarios(env) {
  return todos(env.DB.prepare(`SELECT ${USER_COLUMNS} FROM usuarios ORDER BY nome COLLATE NOCASE`));
}

async function buscarUsuario(env, id) {
  return env.DB.prepare(`SELECT ${USER_COLUMNS} FROM usuarios WHERE id = ?`).bind(id).first();
}

async function buscarUsuarioPorLogin(env, login) {
  return env.DB.prepare('SELECT * FROM usuarios WHERE login = ?').bind(login).first();
}

async function contarAdminsAtivos(env, excetoId = 0) {
  const row = await env.DB.prepare("SELECT COUNT(*) AS total FROM usuarios WHERE perfil = 'full' AND ativo = 1 AND id <> ?")
    .bind(excetoId).first();
  return row.total;
}

/**
 * Veículos antigos guardam a sociedade como texto livre (ex: "Lagoa").
 * Quando existe um usuário com o mesmo nome, o veículo passa a ser dele.
 */
async function vincularSociedadeLegada(env, usuarioId, nome) {
  const alvo = String(nome || '').trim().toLowerCase();
  if (!alvo) return 0;
  const candidatos = await todos(env.DB.prepare('SELECT id, dados FROM veiculos WHERE socio_id IS NULL'));
  const ids = candidatos
    .filter(row => String(JSON.parse(row.dados).sociedade || '').trim().toLowerCase() === alvo)
    .map(row => row.id);
  if (ids.length) {
    await env.DB.prepare('UPDATE veiculos SET socio_id = ? WHERE id IN (SELECT value FROM json_each(?))')
      .bind(usuarioId, JSON.stringify(ids)).run();
  }
  return ids.length;
}

async function criarUsuario(env, { nome, login, senhaHash, perfil, trocarSenha = true }) {
  const row = await env.DB.prepare('INSERT INTO usuarios (nome, login, senha_hash, perfil, trocar_senha) VALUES (?, ?, ?, ?, ?) RETURNING id')
    .bind(nome, login, senhaHash, perfil, trocarSenha ? 1 : 0).first();
  await vincularSociedadeLegada(env, row.id, nome);
  return buscarUsuario(env, row.id);
}

let inicializado = false;

// Cria o administrador padrão e o contador de versão na primeira execução
async function garantirInicializacao(env) {
  if (inicializado) return;
  await env.DB.prepare("INSERT OR IGNORE INTO meta (chave, valor) VALUES ('versao', '0')").run();
  const { total } = await env.DB.prepare('SELECT COUNT(*) AS total FROM usuarios').first();
  if (total === 0) {
    await env.DB.prepare("INSERT OR IGNORE INTO usuarios (nome, login, senha_hash, perfil, trocar_senha) VALUES (?, ?, ?, 'full', 1)")
      .bind(ADMIN_PADRAO.nome, ADMIN_PADRAO.login, await hashSenha(ADMIN_PADRAO.senha)).run();
    console.log(`Usuário administrador padrão criado: login "${ADMIN_PADRAO.login}", senha "${ADMIN_PADRAO.senha}".`);
  }
  inicializado = true;
}

// ----------------------------------------------------------------------------
// Sessões e login
// ----------------------------------------------------------------------------
function dadosPublicosUsuario(u) {
  return { id: u.id, nome: u.nome, login: u.login, perfil: u.perfil, trocarSenha: !!u.trocar_senha };
}

async function usuarioDaSessao(request, env) {
  const token = lerCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const sessao = await env.DB.prepare(`
    SELECT s.expira_em, u.id, u.nome, u.login, u.perfil, u.ativo, u.trocar_senha
    FROM sessoes s JOIN usuarios u ON u.id = s.usuario_id
    WHERE s.token_hash = ?
  `).bind(await sha256Hex(token)).first();
  if (!sessao || sessao.expira_em < Date.now() || !sessao.ativo) return null;
  return dadosPublicosUsuario(sessao);
}

async function iniciarSessao(env, url, usuarioId) {
  const token = paraHex(bytesAleatorios(32));
  await env.DB.prepare('INSERT INTO sessoes (token_hash, usuario_id, expira_em) VALUES (?, ?, ?)')
    .bind(await sha256Hex(token), usuarioId, Date.now() + SESSION_TTL_MS).run();
  return cookieSessao(url, token, SESSION_TTL_MS);
}

async function loginBloqueado(env, ip) {
  const row = await env.DB.prepare('SELECT falhas, expira_em FROM tentativas_login WHERE ip = ?').bind(ip).first();
  return !!row && row.expira_em > Date.now() && row.falhas >= MAX_TENTATIVAS;
}

async function registrarFalhaLogin(env, ip) {
  const agora = Date.now();
  await env.DB.prepare(`
    INSERT INTO tentativas_login (ip, falhas, expira_em) VALUES (?1, 1, ?2)
    ON CONFLICT(ip) DO UPDATE SET
      falhas = CASE WHEN tentativas_login.expira_em < ?3 THEN 1 ELSE tentativas_login.falhas + 1 END,
      expira_em = CASE WHEN tentativas_login.expira_em < ?3 THEN ?2 ELSE tentativas_login.expira_em END
  `).bind(ip, agora + JANELA_TENTATIVAS_MS, agora).run();
}

// Exige login; com senha provisória, só a própria troca de senha é permitida
async function exigirLogin(ctx) {
  const usuario = await usuarioDaSessao(ctx.request, ctx.env);
  if (!usuario) throw new ErroHttp(401, 'Sessão expirada. Faça login novamente.');
  if (usuario.trocarSenha && ctx.url.pathname !== '/api/auth/senha') {
    throw new ErroHttp(403, 'Troque a sua senha provisória para continuar.', { trocarSenha: true });
  }
  ctx.usuario = usuario;
  return usuario;
}

async function exigirFull(ctx) {
  const usuario = await exigirLogin(ctx);
  if (usuario.perfil !== 'full') throw new ErroHttp(403, 'Seu perfil é somente de visualização.');
  return usuario;
}

// ----------------------------------------------------------------------------
// Dados do sistema (veículos, despesas, documentos, parcelas)
// ----------------------------------------------------------------------------

/**
 * Retorna os dados visíveis para o usuário. O perfil de visualização recebe
 * somente os veículos em que é sócio e os registros ligados a eles.
 */
async function lerDados(env, usuario) {
  const somenteSocio = usuario.perfil !== 'full';
  const filtro = somenteSocio ? 'WHERE veiculo_id IN (SELECT id FROM veiculos WHERE socio_id = ?1)' : '';
  const consulta = (sql) => somenteSocio ? env.DB.prepare(sql).bind(usuario.id) : env.DB.prepare(sql);

  const [usuarios, veiculoRows, despesas, documentos, pagamentos, versao] = await env.DB.batch([
    env.DB.prepare('SELECT id, nome FROM usuarios'),
    consulta(`SELECT socio_id, dados FROM veiculos ${somenteSocio ? 'WHERE socio_id = ?1' : ''} ORDER BY id`),
    consulta(`SELECT dados FROM despesas ${filtro} ORDER BY id`),
    consulta(`SELECT dados FROM documentos ${filtro} ORDER BY id`),
    consulta(`SELECT dados FROM pagamentos ${filtro} ORDER BY id`),
    env.DB.prepare("SELECT valor FROM meta WHERE chave = 'versao'")
  ]);

  const nomes = new Map(usuarios.results.map(u => [u.id, u.nome]));
  const veiculos = veiculoRows.results.map(row => {
    const v = JSON.parse(row.dados);
    v.socioId = row.socio_id ?? null;
    if (row.socio_id) v.sociedade = nomes.get(row.socio_id) || v.sociedade || '';
    return v;
  });
  const lista = (r) => r.results.map(row => JSON.parse(row.dados));

  return {
    veiculos,
    despesas: lista(despesas),
    documentos: lista(documentos),
    pagamentos: lista(pagamentos),
    versao: Number(versao.results[0] ? versao.results[0].valor : 0)
  };
}

function idValido(valor) {
  const id = Number(valor);
  if (!Number.isSafeInteger(id)) throw new ErroHttp(400, `Registro com identificador inválido: ${valor}`);
  return id;
}

/**
 * Grava os dados enviados pelo perfil full. Só os registros novos, alterados ou
 * removidos são gravados (o plano gratuito do D1 limita as linhas gravadas por dia).
 * Com versaoEsperada, a gravação é recusada se outro usuário salvou antes.
 */
async function salvarDados(env, { veiculos, despesas, documentos, pagamentos }, { versaoEsperada = null, origem = null } = {}) {
  const [usuariosRes, veicAtuais, ...filhosAtuais] = await env.DB.batch([
    env.DB.prepare('SELECT id, nome FROM usuarios'),
    env.DB.prepare('SELECT id, socio_id, dados FROM veiculos'),
    ...TABELAS_FILHAS.map(t => env.DB.prepare(`SELECT id, veiculo_id, dados FROM ${t}`))
  ]);

  const usuarios = usuariosRes.results;
  const idsUsuarios = new Set(usuarios.map(u => u.id));
  const porNome = new Map(usuarios.map(u => [String(u.nome).trim().toLowerCase(), u.id]));

  const comandos = [];
  // Trava de concorrência: a gravação inteira é desfeita se a versão mudou.
  // json() com texto inválido gera erro e aborta o lote (o D1 executa o lote em uma transação).
  if (versaoEsperada !== null) {
    comandos.push(env.DB.prepare(
      "SELECT CASE WHEN CAST(valor AS INTEGER) = ?1 THEN 1 ELSE json(valor || '#conflito_versao') END FROM meta WHERE chave = 'versao'"
    ).bind(Number(versaoEsperada)));
  }

  const planejar = (tabela, atuais, desejados, colunaPai) => {
    const mapaAtual = new Map(atuais.map(r => [r.id, r]));
    const mapaNovo = new Map(desejados.map(r => [r.id, r]));
    const gravar = [];
    for (const [id, r] of mapaNovo) {
      const a = mapaAtual.get(id);
      if (!a || a.dados !== r.d || (a[colunaPai] ?? null) !== (r.p ?? null)) gravar.push(r);
    }
    const remover = [...mapaAtual.keys()].filter(id => !mapaNovo.has(id));

    for (const parte of dividirPorTamanho(remover)) {
      comandos.push(env.DB.prepare(`DELETE FROM ${tabela} WHERE id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(parte)));
    }
    for (const parte of dividirPorTamanho(gravar)) {
      comandos.push(env.DB.prepare(`
        INSERT INTO ${tabela} (id, ${colunaPai}, dados)
        SELECT json_extract(value, '$.id'), json_extract(value, '$.p'), json_extract(value, '$.d') FROM json_each(?) WHERE true
        ON CONFLICT(id) DO UPDATE SET ${colunaPai} = excluded.${colunaPai}, dados = excluded.dados
      `).bind(JSON.stringify(parte)));
    }
    return gravar.length + remover.length;
  };

  const veiculosNovos = veiculos.map(v => {
    let socioId = Number(v.socioId) || null;
    if (socioId && !idsUsuarios.has(socioId)) socioId = null;
    if (!socioId && v.sociedade) socioId = porNome.get(String(v.sociedade).trim().toLowerCase()) || null;
    const { socioId: _ignorado, ...registro } = v;
    return { id: idValido(v.id), p: socioId, d: JSON.stringify(registro) };
  });
  let alteracoes = planejar('veiculos', veicAtuais.results, veiculosNovos, 'socio_id');

  const listasNovas = { despesas, documentos, pagamentos };
  TABELAS_FILHAS.forEach((tabela, i) => {
    const novos = listasNovas[tabela].map(item => ({ id: idValido(item.id), p: Number(item.veiculoId) || 0, d: JSON.stringify(item) }));
    alteracoes += planejar(tabela, filhosAtuais[i].results, novos, 'veiculo_id');
  });

  comandos.push(env.DB.prepare(
    "UPDATE meta SET valor = CAST(CAST(valor AS INTEGER) + 1 AS TEXT) WHERE chave = 'versao' RETURNING valor"
  ));
  if (origem) comandos.push(stmtSetMeta(env, 'origem', origem));

  let resultados;
  try {
    resultados = await env.DB.batch(comandos);
  } catch (err) {
    if (String(err && err.message).includes('malformed JSON')) {
      const atual = Number(await getMeta(env, 'versao', '0'));
      throw new ErroHttp(409, 'Os dados foram alterados por outro usuário.', { versao: atual });
    }
    throw err;
  }
  const versaoRes = resultados[resultados.length - (origem ? 2 : 1)];
  return { versao: Number(versaoRes.results[0].valor), alteracoes };
}

async function restaurarBasePlanilha(env) {
  const base = JSON.parse(JSON.stringify(BASE_PLANILHA));
  const { versao } = await salvarDados(env, {
    veiculos: base.veiculos || [],
    despesas: base.despesas || [],
    documentos: base.documentos || [],
    pagamentos: base.pagamentos || []
  }, { origem: 'planilha' });
  return versao;
}

// ----------------------------------------------------------------------------
// Arquivos anexados (conteúdo no KV, informações no D1)
// ----------------------------------------------------------------------------
const chaveArquivo = (id) => `arquivo:${id}`;

async function documentoVisivel(env, documentoId, usuario) {
  const row = await env.DB.prepare(`
    SELECT d.veiculo_id, v.socio_id
    FROM documentos d LEFT JOIN veiculos v ON v.id = d.veiculo_id
    WHERE d.id = ?
  `).bind(documentoId).first();
  if (!row) return false;
  return usuario.perfil === 'full' || row.socio_id === usuario.id;
}

function lerMetaArquivo(request) {
  const bruto = request.headers.get('X-Arquivo-Meta');
  if (!bruto) return {};
  try {
    const meta = JSON.parse(decodeURIComponent(bruto));
    return meta && typeof meta === 'object' ? meta : {};
  } catch (e) {
    throw new ErroHttp(400, 'Informações do arquivo inválidas.');
  }
}

// ----------------------------------------------------------------------------
// Rotas da API
// ----------------------------------------------------------------------------
function comContagem(usuario, contagens) {
  const { trocar_senha: trocarSenha, ...resto } = usuario;
  return { ...resto, ativo: !!usuario.ativo, trocarSenha: !!trocarSenha, veiculosComoSocio: contagens.get(usuario.id) || 0 };
}

async function contagemVeiculosPorSocio(env) {
  const rows = await todos(env.DB.prepare('SELECT socio_id, COUNT(*) AS total FROM veiculos WHERE socio_id IS NOT NULL GROUP BY socio_id'));
  return new Map(rows.map(r => [r.socio_id, r.total]));
}

function validarUsuario(body, { novo }) {
  const erro = validarTexto(body.nome, 'Nome') || validarTexto(body.login, 'Login', { max: 50 });
  if (erro) return erro;
  if (!PERFIS.includes(body.perfil)) return 'Perfil inválido.';
  if (novo || body.senha) return validarSenha(body.senha);
  return null;
}

async function loginEmUso(env, login, excetoId = 0) {
  const existente = await buscarUsuarioPorLogin(env, String(login).trim());
  return !!existente && existente.id !== excetoId;
}

const rotas = [];
function rota(metodo, padrao, handler) {
  const chaves = [];
  const regex = new RegExp('^' + padrao.replace(/:(\w+)/g, (_, k) => { chaves.push(k); return '([^/]+)'; }) + '$');
  rotas.push({ metodo, regex, chaves, handler });
}

// ---------- Autenticação ----------
rota('GET', '/api/auth/status', async (ctx) => json(200, { usuario: await usuarioDaSessao(ctx.request, ctx.env) }));

rota('POST', '/api/auth/login', async ({ request, env, url }) => {
  const ip = ipDoCliente(request);
  if (await loginBloqueado(env, ip)) {
    throw new ErroHttp(429, 'Muitas tentativas de login. Aguarde 15 minutos e tente novamente.');
  }

  const { login, senha } = await lerCorpoJson(request);
  const usuario = login ? await buscarUsuarioPorLogin(env, String(login).trim()) : null;
  const senhaOk = await conferirSenha(String(senha || ''), usuario ? usuario.senha_hash : await obterHashFicticio());

  if (!usuario || !senhaOk || !usuario.ativo) {
    await registrarFalhaLogin(env, ip);
    throw new ErroHttp(401, 'Login ou senha inválidos.');
  }

  await env.DB.prepare('DELETE FROM tentativas_login WHERE ip = ?').bind(ip).run();
  const cookie = await iniciarSessao(env, url, usuario.id);
  return json(200, { usuario: dadosPublicosUsuario(usuario) }, { 'Set-Cookie': cookie });
});

rota('POST', '/api/auth/logout', async ({ request, env, url }) => {
  const token = lerCookie(request, SESSION_COOKIE);
  if (token) await env.DB.prepare('DELETE FROM sessoes WHERE token_hash = ?').bind(await sha256Hex(token)).run();
  return json(200, { ok: true }, { 'Set-Cookie': cookieSessao(url, '', 0) });
});

rota('POST', '/api/auth/senha', async (ctx) => {
  const usuario = await exigirLogin(ctx);
  const { senhaAtual, novaSenha } = await lerCorpoJson(ctx.request);
  const registro = await buscarUsuarioPorLogin(ctx.env, usuario.login);
  if (!registro || !(await conferirSenha(String(senhaAtual || ''), registro.senha_hash))) {
    throw new ErroHttp(400, 'A senha atual está incorreta.');
  }
  const erro = validarSenha(novaSenha);
  if (erro) throw new ErroHttp(400, erro);
  if (novaSenha === senhaAtual) throw new ErroHttp(400, 'A nova senha deve ser diferente da atual.');
  await ctx.env.DB.prepare('UPDATE usuarios SET senha_hash = ?, trocar_senha = 0 WHERE id = ?')
    .bind(await hashSenha(novaSenha), usuario.id).run();
  return json(200, { ok: true });
});

// ---------- Dados ----------
rota('GET', '/api/dados', async (ctx) => {
  const usuario = await exigirLogin(ctx);
  const { env } = ctx;

  // Na primeira execução o banco nasce com a base original da planilha
  if ((await getMeta(env, 'inicializado')) !== '1') {
    const { total } = await env.DB.prepare('SELECT COUNT(*) AS total FROM veiculos').first();
    if (total === 0) await restaurarBasePlanilha(env);
    await stmtSetMeta(env, 'inicializado', '1').run();
  }

  const dados = await lerDados(env, usuario);
  // Lista de sócios para o campo "Sócio" do cadastro de veículos (somente perfil full)
  dados.socios = usuario.perfil === 'full'
    ? (await listarUsuarios(env)).filter(u => u.ativo).map(u => ({ id: u.id, nome: u.nome, perfil: u.perfil }))
    : [];
  dados.origem = await getMeta(env, 'origem', '');
  return json(200, dados);
});

rota('PUT', '/api/dados', async (ctx) => {
  await exigirFull(ctx);
  const { veiculos, despesas, documentos, pagamentos, versao } = await lerCorpoJson(ctx.request);
  if (![veiculos, despesas, documentos, pagamentos].every(Array.isArray)) {
    throw new ErroHttp(400, 'Formato de dados inválido.');
  }
  const resultado = await salvarDados(ctx.env, { veiculos, despesas, documentos, pagamentos }, {
    versaoEsperada: Number(versao) || 0,
    origem: 'editado'
  });
  return json(200, { versao: resultado.versao });
});

rota('POST', '/api/dados/restaurar-planilha', async (ctx) => {
  await exigirFull(ctx);
  return json(200, { versao: await restaurarBasePlanilha(ctx.env) });
});

// ---------- Arquivos ----------
rota('GET', '/api/arquivos-total', async (ctx) => {
  const usuario = await exigirLogin(ctx);
  const row = usuario.perfil === 'full'
    ? await ctx.env.DB.prepare('SELECT COALESCE(SUM(tamanho_bytes), 0) AS total FROM arquivos').first()
    : await ctx.env.DB.prepare(`
        SELECT COALESCE(SUM(a.tamanho_bytes), 0) AS total
        FROM arquivos a
        JOIN documentos d ON d.id = a.documento_id
        JOIN veiculos v ON v.id = d.veiculo_id
        WHERE v.socio_id = ?
      `).bind(usuario.id).first();
  return json(200, { totalBytes: row.total });
});

rota('GET', '/api/arquivos/:id', async (ctx) => {
  const usuario = await exigirLogin(ctx);
  const id = Number(ctx.params.id);
  const naoEncontrado = new ErroHttp(404, 'Arquivo não encontrado.');
  if (!id || !(await documentoVisivel(ctx.env, id, usuario))) throw naoEncontrado;
  const info = await ctx.env.DB.prepare('SELECT dados FROM arquivos WHERE documento_id = ?').bind(id).first();
  const conteudo = info ? await ctx.env.ARQUIVOS.get(chaveArquivo(id), { type: 'stream' }) : null;
  if (!conteudo) throw naoEncontrado;
  // O conteúdo (data URL em base64) segue direto do KV, sem ser lido pelo Worker
  return new Response(conteudo, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Arquivo-Meta': encodeURIComponent(info.dados)
    }
  });
});

rota('PUT', '/api/arquivos/:id', async (ctx) => {
  await exigirFull(ctx);
  const id = Number(ctx.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) throw new ErroHttp(400, 'Arquivo inválido.');
  const declarado = Number(ctx.request.headers.get('Content-Length')) || 0;
  if (declarado > MAX_ARQUIVO_BYTES) throw new ErroHttp(413, 'Arquivo muito grande. O limite é de aproximadamente 18 MB.');

  const meta = lerMetaArquivo(ctx.request);
  const conteudo = await ctx.request.arrayBuffer();
  if (!conteudo.byteLength) throw new ErroHttp(400, 'Arquivo vazio.');
  if (conteudo.byteLength > MAX_ARQUIVO_BYTES) throw new ErroHttp(413, 'Arquivo muito grande. O limite é de aproximadamente 18 MB.');

  const { dataBase64: _ignorado, ...info } = meta;
  const tamanho = Number(info.tamanhoBytes) || Math.round(conteudo.byteLength * 0.75);
  await ctx.env.ARQUIVOS.put(chaveArquivo(id), conteudo);
  await ctx.env.DB.prepare(`
    INSERT INTO arquivos (documento_id, tamanho_bytes, dados) VALUES (?, ?, ?)
    ON CONFLICT(documento_id) DO UPDATE SET tamanho_bytes = excluded.tamanho_bytes, dados = excluded.dados
  `).bind(id, tamanho, JSON.stringify({ ...info, id })).run();
  return json(200, { ok: true });
});

rota('DELETE', '/api/arquivos/:id', async (ctx) => {
  await exigirFull(ctx);
  const id = Number(ctx.params.id);
  if (id) {
    await ctx.env.ARQUIVOS.delete(chaveArquivo(id));
    await ctx.env.DB.prepare('DELETE FROM arquivos WHERE documento_id = ?').bind(id).run();
  }
  return json(200, { ok: true });
});

// ---------- Usuários (somente perfil full) ----------
rota('GET', '/api/usuarios', async (ctx) => {
  await exigirFull(ctx);
  const [usuarios, contagens] = await Promise.all([listarUsuarios(ctx.env), contagemVeiculosPorSocio(ctx.env)]);
  return json(200, usuarios.map(u => comContagem(u, contagens)));
});

rota('POST', '/api/usuarios', async (ctx) => {
  await exigirFull(ctx);
  const body = await lerCorpoJson(ctx.request);
  const erro = validarUsuario(body, { novo: true });
  if (erro) throw new ErroHttp(400, erro);
  if (await loginEmUso(ctx.env, body.login)) throw new ErroHttp(409, 'Já existe um usuário com este login.');

  const usuario = await criarUsuario(ctx.env, {
    nome: body.nome.trim(),
    login: body.login.trim(),
    senhaHash: await hashSenha(body.senha),
    perfil: body.perfil
  });
  return json(201, comContagem(usuario, await contagemVeiculosPorSocio(ctx.env)));
});

rota('PUT', '/api/usuarios/:id', async (ctx) => {
  const eu = await exigirFull(ctx);
  const { env } = ctx;
  const id = Number(ctx.params.id);
  const atual = await buscarUsuario(env, id);
  if (!atual) throw new ErroHttp(404, 'Usuário não encontrado.');

  const body = await lerCorpoJson(ctx.request);
  const erro = validarUsuario(body, { novo: false });
  if (erro) throw new ErroHttp(400, erro);
  if (await loginEmUso(env, body.login, id)) throw new ErroHttp(409, 'Já existe um usuário com este login.');

  const ativo = body.ativo !== false;
  const continuaAdmin = body.perfil === 'full' && ativo;
  if (atual.perfil === 'full' && !continuaAdmin && (await contarAdminsAtivos(env, id)) === 0) {
    throw new ErroHttp(400, 'É preciso manter pelo menos um usuário ativo com acesso total.');
  }

  const nome = body.nome.trim();
  // Senha que o admin define para outra pessoa é provisória; a própria não
  const senhaProvisoria = id !== eu.id;
  const senhaHash = body.senha ? await hashSenha(body.senha) : null;
  const comandos = [
    env.DB.prepare('UPDATE usuarios SET nome = ?, login = ?, perfil = ?, ativo = ? WHERE id = ?')
      .bind(nome, body.login.trim(), body.perfil, ativo ? 1 : 0, id)
  ];
  if (senhaHash) {
    comandos.push(env.DB.prepare('UPDATE usuarios SET senha_hash = ?, trocar_senha = ? WHERE id = ?')
      .bind(senhaHash, senhaProvisoria ? 1 : 0, id));
  }
  // Usuário desativado ou com senha redefinida pelo administrador perde as sessões abertas
  if (!ativo || (senhaHash && senhaProvisoria)) {
    comandos.push(env.DB.prepare('DELETE FROM sessoes WHERE usuario_id = ?').bind(id));
  }
  await env.DB.batch(comandos);
  await vincularSociedadeLegada(env, id, nome);
  return json(200, comContagem(await buscarUsuario(env, id), await contagemVeiculosPorSocio(env)));
});

rota('DELETE', '/api/usuarios/:id', async (ctx) => {
  const eu = await exigirFull(ctx);
  const id = Number(ctx.params.id);
  if (id === eu.id) throw new ErroHttp(400, 'Você não pode excluir o seu próprio usuário.');
  const atual = await buscarUsuario(ctx.env, id);
  if (!atual) throw new ErroHttp(404, 'Usuário não encontrado.');
  if (atual.perfil === 'full' && atual.ativo && (await contarAdminsAtivos(ctx.env, id)) === 0) {
    throw new ErroHttp(400, 'É preciso manter pelo menos um usuário ativo com acesso total.');
  }
  await ctx.env.DB.prepare('DELETE FROM usuarios WHERE id = ?').bind(id).run();
  return json(200, { ok: true });
});

async function tratarApi(request, env, url) {
  for (const r of rotas) {
    if (r.metodo !== request.method) continue;
    const m = url.pathname.match(r.regex);
    if (!m) continue;
    const params = Object.fromEntries(r.chaves.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    return r.handler({ request, env, url, params });
  }
  throw new ErroHttp(404, 'Rota não encontrada.');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) {
      // Telas do sistema (pasta public/)
      return env.ASSETS.fetch(request);
    }
    try {
      await garantirInicializacao(env);
      return await tratarApi(request, env, url);
    } catch (err) {
      if (err instanceof ErroHttp) return json(err.status, { erro: err.message, ...err.extra });
      console.error(err);
      if (String(err && err.message).includes('no such table')) {
        return json(500, { erro: 'Banco de dados não preparado. Rode as migrações do D1 (veja o README).' });
      }
      return json(500, { erro: 'Erro interno no servidor.' });
    }
  },

  // Limpeza diária de sessões expiradas e bloqueios de login vencidos
  async scheduled(event, env) {
    const agora = Date.now();
    await env.DB.batch([
      env.DB.prepare('DELETE FROM sessoes WHERE expira_em < ?').bind(agora),
      env.DB.prepare('DELETE FROM tentativas_login WHERE expira_em < ?').bind(agora)
    ]);
  }
};
