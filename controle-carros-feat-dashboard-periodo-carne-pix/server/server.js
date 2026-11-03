/**
 * AutoManage Toledo - Servidor HTTP (Express + SQLite)
 *
 * Perfis de acesso:
 *  - full:         acesso total, edita dados e gerencia usuários
 *  - visualizacao: somente leitura, apenas dos veículos em que é sócio
 *
 * Uso: npm install && npm start  (porta padrão 3000, altere com PORT)
 */
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const db = require('./db');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const ROOT_DIR = path.join(__dirname, '..');
const SESSION_COOKIE = 'automanage_sid';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 horas
const PERFIS = ['full', 'visualizacao'];
// Administrador criado automaticamente quando não há usuários (senha precisa ser trocada no 1º login)
const ADMIN_PADRAO = { nome: 'Administrador', login: 'admin', senha: 'admin' };

const app = express();
app.disable('x-powered-by');
// Necessário para identificar HTTPS quando o servidor fica atrás de um proxy/túnel local
app.set('trust proxy', 'loopback');

// ----------------------------------------------------------------------------
// Senhas (scrypt) e sessões
// ----------------------------------------------------------------------------
function hashSenha(senha) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(senha, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function conferirSenha(senha, armazenado) {
  const [algoritmo, saltHex, hashHex] = String(armazenado).split('$');
  if (algoritmo !== 'scrypt' || !saltHex || !hashHex) return false;
  const esperado = Buffer.from(hashHex, 'hex');
  const calculado = crypto.scryptSync(senha, Buffer.from(saltHex, 'hex'), esperado.length);
  return crypto.timingSafeEqual(esperado, calculado);
}

// Hash fixo para comparar mesmo quando o login não existe (evita revelar usuários pelo tempo de resposta)
const HASH_FICTICIO = hashSenha(crypto.randomBytes(12).toString('hex'));

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function lerCookie(req, nome) {
  const header = req.headers.cookie || '';
  for (const parte of header.split(';')) {
    const [chave, ...resto] = parte.trim().split('=');
    if (chave === nome) return decodeURIComponent(resto.join('='));
  }
  return null;
}

function definirCookieSessao(req, res, token, maxAgeMs) {
  const atributos = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`
  ];
  if (req.secure) atributos.push('Secure');
  res.setHeader('Set-Cookie', atributos.join('; '));
}

function iniciarSessao(req, res, usuarioId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.criarSessao(hashToken(token), usuarioId, Date.now() + SESSION_TTL_MS);
  definirCookieSessao(req, res, token, SESSION_TTL_MS);
}

function dadosPublicosUsuario(u) {
  return { id: u.id, nome: u.nome, login: u.login, perfil: u.perfil, trocarSenha: !!u.trocar_senha };
}

function usuarioDaSessao(req) {
  const token = lerCookie(req, SESSION_COOKIE);
  if (!token) return null;
  const sessao = db.buscarSessao(hashToken(token));
  if (!sessao || sessao.expira_em < Date.now() || !sessao.ativo) return null;
  return dadosPublicosUsuario(sessao);
}

function garantirAdminPadrao() {
  if (db.contarUsuarios() > 0) return;
  db.criarUsuario({
    nome: ADMIN_PADRAO.nome,
    login: ADMIN_PADRAO.login,
    senhaHash: hashSenha(ADMIN_PADRAO.senha),
    perfil: 'full',
    trocarSenha: true
  });
  console.log(`Usuário administrador padrão criado: login "${ADMIN_PADRAO.login}", senha "${ADMIN_PADRAO.senha}" (troca obrigatória no primeiro acesso).`);
}

// Limite simples de tentativas de login por IP
const tentativasLogin = new Map();
const MAX_TENTATIVAS = 10;
const JANELA_TENTATIVAS_MS = 15 * 60 * 1000;

function loginBloqueado(ip) {
  const registro = tentativasLogin.get(ip);
  if (!registro || registro.expira < Date.now()) return false;
  return registro.falhas >= MAX_TENTATIVAS;
}

function registrarFalhaLogin(ip) {
  const agora = Date.now();
  const registro = tentativasLogin.get(ip);
  if (!registro || registro.expira < agora) {
    tentativasLogin.set(ip, { falhas: 1, expira: agora + JANELA_TENTATIVAS_MS });
  } else {
    registro.falhas++;
  }
}

setInterval(() => {
  db.limparSessoesExpiradas();
  const agora = Date.now();
  for (const [ip, registro] of tentativasLogin) {
    if (registro.expira < agora) tentativasLogin.delete(ip);
  }
}, 60 * 60 * 1000).unref();

// ----------------------------------------------------------------------------
// Middlewares
// ----------------------------------------------------------------------------
app.use('/api', express.json({ limit: '40mb' }));

app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

// Exige login; com senha provisória, só a própria troca de senha é permitida
function exigirLogin(req, res, next) {
  const usuario = usuarioDaSessao(req);
  if (!usuario) return res.status(401).json({ erro: 'Sessão expirada. Faça login novamente.' });
  if (usuario.trocarSenha && req.path !== '/api/auth/senha') {
    return res.status(403).json({ erro: 'Troque a sua senha provisória para continuar.', trocarSenha: true });
  }
  req.usuario = usuario;
  next();
}

function exigirFull(req, res, next) {
  if (req.usuario.perfil !== 'full') {
    return res.status(403).json({ erro: 'Seu perfil é somente de visualização.' });
  }
  next();
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

// ----------------------------------------------------------------------------
// Autenticação
// ----------------------------------------------------------------------------
app.get('/api/auth/status', (req, res) => {
  res.json({ usuario: usuarioDaSessao(req) });
});

app.post('/api/auth/login', (req, res) => {
  const ip = req.ip;
  if (loginBloqueado(ip)) {
    return res.status(429).json({ erro: 'Muitas tentativas de login. Aguarde 15 minutos e tente novamente.' });
  }

  const { login, senha } = req.body || {};
  const usuario = login ? db.buscarUsuarioPorLogin(String(login).trim()) : null;
  const senhaOk = conferirSenha(String(senha || ''), usuario ? usuario.senha_hash : HASH_FICTICIO);

  if (!usuario || !senhaOk || !usuario.ativo) {
    registrarFalhaLogin(ip);
    return res.status(401).json({ erro: 'Login ou senha inválidos.' });
  }

  tentativasLogin.delete(ip);
  iniciarSessao(req, res, usuario.id);
  res.json({ usuario: dadosPublicosUsuario(usuario) });
});

app.post('/api/auth/logout', (req, res) => {
  const token = lerCookie(req, SESSION_COOKIE);
  if (token) db.excluirSessao(hashToken(token));
  definirCookieSessao(req, res, '', 0);
  res.json({ ok: true });
});

app.post('/api/auth/senha', exigirLogin, (req, res) => {
  const { senhaAtual, novaSenha } = req.body || {};
  const registro = db.buscarUsuarioPorLogin(req.usuario.login);
  if (!registro || !conferirSenha(String(senhaAtual || ''), registro.senha_hash)) {
    return res.status(400).json({ erro: 'A senha atual está incorreta.' });
  }
  const erro = validarSenha(novaSenha);
  if (erro) return res.status(400).json({ erro });
  if (novaSenha === senhaAtual) return res.status(400).json({ erro: 'A nova senha deve ser diferente da atual.' });
  db.alterarSenha(req.usuario.id, hashSenha(novaSenha));
  res.json({ ok: true });
});

// ----------------------------------------------------------------------------
// Dados do sistema
// ----------------------------------------------------------------------------
app.get('/api/dados', exigirLogin, (req, res) => {
  // Na primeira execução o banco nasce com a base original da planilha
  if (db.bancoVazio() && db.getMeta('inicializado') !== '1') {
    db.restaurarBasePlanilha();
    db.setMeta('inicializado', '1');
  }

  const dados = db.lerDados(req.usuario);
  // Lista de sócios para o campo "Sócio" do cadastro de veículos (somente perfil full)
  dados.socios = req.usuario.perfil === 'full'
    ? db.listarUsuarios().filter(u => u.ativo).map(u => ({ id: u.id, nome: u.nome, perfil: u.perfil }))
    : [];
  dados.origem = db.getMeta('origem', '');
  res.json(dados);
});

app.put('/api/dados', exigirLogin, exigirFull, (req, res) => {
  const { veiculos, despesas, documentos, pagamentos, versao } = req.body || {};
  if (![veiculos, despesas, documentos, pagamentos].every(Array.isArray)) {
    return res.status(400).json({ erro: 'Formato de dados inválido.' });
  }

  // Controle de concorrência: impede sobrescrever alterações feitas por outro usuário
  const versaoAtual = Number(db.getMeta('versao', '0'));
  if (Number(versao) !== versaoAtual) {
    return res.status(409).json({ erro: 'Os dados foram alterados por outro usuário.', versao: versaoAtual });
  }

  try {
    const novaVersao = db.salvarDados({ veiculos, despesas, documentos, pagamentos });
    db.setMeta('origem', 'editado');
    res.json({ versao: novaVersao });
  } catch (err) {
    console.error('Erro ao salvar dados:', err);
    res.status(400).json({ erro: `Não foi possível salvar: ${err.message}` });
  }
});

app.post('/api/dados/restaurar-planilha', exigirLogin, exigirFull, (req, res) => {
  const versao = db.restaurarBasePlanilha();
  res.json({ versao });
});

// ----------------------------------------------------------------------------
// Arquivos anexados (fotos e documentos)
// ----------------------------------------------------------------------------
app.get('/api/arquivos-total', exigirLogin, (req, res) => {
  res.json({ totalBytes: db.totalBytesArquivos(req.usuario) });
});

app.get('/api/arquivos/:id', exigirLogin, (req, res) => {
  const id = Number(req.params.id);
  if (!db.documentoVisivel(id, req.usuario)) return res.status(404).json({ erro: 'Arquivo não encontrado.' });
  const arquivo = db.lerArquivo(id);
  if (!arquivo) return res.status(404).json({ erro: 'Arquivo não encontrado.' });
  res.json(arquivo);
});

app.put('/api/arquivos/:id', exigirLogin, exigirFull, (req, res) => {
  const id = Number(req.params.id);
  const arquivo = req.body || {};
  if (!id || typeof arquivo.dataBase64 !== 'string') return res.status(400).json({ erro: 'Arquivo inválido.' });
  db.salvarArquivo(id, { ...arquivo, id });
  res.json({ ok: true });
});

app.delete('/api/arquivos/:id', exigirLogin, exigirFull, (req, res) => {
  db.excluirArquivo(Number(req.params.id));
  res.json({ ok: true });
});

// ----------------------------------------------------------------------------
// Cadastro de usuários (somente perfil full)
// ----------------------------------------------------------------------------
function comContagem(usuario) {
  const { trocar_senha: trocarSenha, ...resto } = usuario;
  return { ...resto, ativo: !!usuario.ativo, trocarSenha: !!trocarSenha, veiculosComoSocio: db.contarVeiculosDoSocio(usuario.id) };
}

function validarUsuario(body, { novo }) {
  const erro = validarTexto(body.nome, 'Nome') || validarTexto(body.login, 'Login', { max: 50 });
  if (erro) return erro;
  if (!PERFIS.includes(body.perfil)) return 'Perfil inválido.';
  if (novo || body.senha) return validarSenha(body.senha);
  return null;
}

function loginEmUso(login, excetoId = 0) {
  const existente = db.buscarUsuarioPorLogin(String(login).trim());
  return !!existente && existente.id !== excetoId;
}

app.get('/api/usuarios', exigirLogin, exigirFull, (req, res) => {
  res.json(db.listarUsuarios().map(comContagem));
});

app.post('/api/usuarios', exigirLogin, exigirFull, (req, res) => {
  const body = req.body || {};
  const erro = validarUsuario(body, { novo: true });
  if (erro) return res.status(400).json({ erro });
  if (loginEmUso(body.login)) return res.status(409).json({ erro: 'Já existe um usuário com este login.' });

  const usuario = db.criarUsuario({
    nome: body.nome.trim(),
    login: body.login.trim(),
    senhaHash: hashSenha(body.senha),
    perfil: body.perfil
  });
  res.status(201).json(comContagem(usuario));
});

app.put('/api/usuarios/:id', exigirLogin, exigirFull, (req, res) => {
  const id = Number(req.params.id);
  const atual = db.buscarUsuario(id);
  if (!atual) return res.status(404).json({ erro: 'Usuário não encontrado.' });

  const body = req.body || {};
  const erro = validarUsuario(body, { novo: false });
  if (erro) return res.status(400).json({ erro });
  if (loginEmUso(body.login, id)) return res.status(409).json({ erro: 'Já existe um usuário com este login.' });

  const ativo = body.ativo !== false;
  const continuaAdmin = body.perfil === 'full' && ativo;
  if (atual.perfil === 'full' && !continuaAdmin && db.contarAdminsAtivos(id) === 0) {
    return res.status(400).json({ erro: 'É preciso manter pelo menos um usuário ativo com acesso total.' });
  }

  const usuario = db.atualizarUsuario(id, {
    nome: body.nome.trim(),
    login: body.login.trim(),
    perfil: body.perfil,
    ativo,
    senhaHash: body.senha ? hashSenha(body.senha) : null,
    // Senha que o admin define para outra pessoa é provisória; a própria não
    senhaProvisoria: id !== req.usuario.id
  });
  res.json(comContagem(usuario));
});

app.delete('/api/usuarios/:id', exigirLogin, exigirFull, (req, res) => {
  const id = Number(req.params.id);
  if (id === req.usuario.id) return res.status(400).json({ erro: 'Você não pode excluir o seu próprio usuário.' });
  const atual = db.buscarUsuario(id);
  if (!atual) return res.status(404).json({ erro: 'Usuário não encontrado.' });
  if (atual.perfil === 'full' && atual.ativo && db.contarAdminsAtivos(id) === 0) {
    return res.status(400).json({ erro: 'É preciso manter pelo menos um usuário ativo com acesso total.' });
  }
  db.excluirUsuario(id);
  res.json({ ok: true });
});

app.use('/api', (req, res) => res.status(404).json({ erro: 'Rota não encontrada.' }));

// ----------------------------------------------------------------------------
// Front-end: somente os arquivos da aplicação são publicados
// (o banco, o código do servidor e a planilha nunca são servidos)
// ----------------------------------------------------------------------------
const ARQUIVOS_PUBLICOS = ['index.html', 'app.js', 'styles.css'];

app.get('/', (req, res) => res.sendFile(path.join(ROOT_DIR, 'index.html')));
for (const arquivo of ARQUIVOS_PUBLICOS) {
  app.get(`/${arquivo}`, (req, res) => res.sendFile(path.join(ROOT_DIR, arquivo)));
}

app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ erro: 'Arquivo muito grande. O limite é de aproximadamente 25 MB.' });
  }
  console.error(err);
  res.status(500).json({ erro: 'Erro interno no servidor.' });
});

garantirAdminPadrao();

app.listen(PORT, HOST, () => {
  console.log(`AutoManage Toledo rodando em http://localhost:${PORT}`);
  console.log(`Banco de dados: ${db.DB_PATH}`);
});
