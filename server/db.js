/**
 * AutoManage Toledo - Camada de persistência SQLite (módulo nativo node:sqlite)
 *
 * Cada entidade guarda as colunas usadas em relacionamentos e controle de acesso
 * (id, veiculo_id, socio_id) e o registro completo do front-end em JSON (dados).
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { DatabaseSync } = require('node:sqlite');

const ROOT_DIR = path.join(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT_DIR, 'dados');
const DB_PATH = path.join(DATA_DIR, 'automanage.db');

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
  CREATE TABLE IF NOT EXISTS usuarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    login TEXT NOT NULL UNIQUE COLLATE NOCASE,
    senha_hash TEXT NOT NULL,
    perfil TEXT NOT NULL CHECK (perfil IN ('full', 'visualizacao')),
    ativo INTEGER NOT NULL DEFAULT 1,
    trocar_senha INTEGER NOT NULL DEFAULT 0,
    criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS sessoes (
    token_hash TEXT PRIMARY KEY,
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    expira_em INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS veiculos (
    id INTEGER PRIMARY KEY,
    socio_id INTEGER NULL REFERENCES usuarios(id) ON DELETE SET NULL,
    dados TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS despesas (
    id INTEGER PRIMARY KEY,
    veiculo_id INTEGER NOT NULL,
    dados TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS documentos (
    id INTEGER PRIMARY KEY,
    veiculo_id INTEGER NOT NULL,
    dados TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS pagamentos (
    id INTEGER PRIMARY KEY,
    veiculo_id INTEGER NOT NULL,
    dados TEXT NOT NULL
  );

  -- Binário (base64) das fotos e documentos anexados
  CREATE TABLE IF NOT EXISTS arquivos (
    documento_id INTEGER PRIMARY KEY,
    tamanho_bytes INTEGER NOT NULL DEFAULT 0,
    dados TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS meta (
    chave TEXT PRIMARY KEY,
    valor TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_veiculos_socio ON veiculos(socio_id);
  CREATE INDEX IF NOT EXISTS idx_despesas_veiculo ON despesas(veiculo_id);
  CREATE INDEX IF NOT EXISTS idx_documentos_veiculo ON documentos(veiculo_id);
  CREATE INDEX IF NOT EXISTS idx_pagamentos_veiculo ON pagamentos(veiculo_id);
`);

// Bancos criados antes da coluna trocar_senha
if (!db.prepare('PRAGMA table_info(usuarios)').all().some(c => c.name === 'trocar_senha')) {
  db.exec('ALTER TABLE usuarios ADD COLUMN trocar_senha INTEGER NOT NULL DEFAULT 0');
}

function transaction(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function getMeta(chave, padrao = null) {
  const row = db.prepare('SELECT valor FROM meta WHERE chave = ?').get(chave);
  return row ? row.valor : padrao;
}

function setMeta(chave, valor) {
  db.prepare('INSERT INTO meta (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor')
    .run(chave, String(valor));
}

function getVersao() {
  return Number(getMeta('versao', '0'));
}

// ----------------------------------------------------------------------------
// Usuários
// ----------------------------------------------------------------------------
const USER_COLUMNS = 'id, nome, login, perfil, ativo, trocar_senha, criado_em';

function contarUsuarios() {
  return db.prepare('SELECT COUNT(*) AS total FROM usuarios').get().total;
}

function listarUsuarios() {
  return db.prepare(`SELECT ${USER_COLUMNS} FROM usuarios ORDER BY nome COLLATE NOCASE`).all();
}

function buscarUsuario(id) {
  return db.prepare(`SELECT ${USER_COLUMNS} FROM usuarios WHERE id = ?`).get(id);
}

function buscarUsuarioPorLogin(login) {
  return db.prepare('SELECT * FROM usuarios WHERE login = ?').get(login);
}

function contarAdminsAtivos(excetoId = 0) {
  return db.prepare("SELECT COUNT(*) AS total FROM usuarios WHERE perfil = 'full' AND ativo = 1 AND id <> ?")
    .get(excetoId).total;
}

function contarVeiculosDoSocio(usuarioId) {
  return db.prepare('SELECT COUNT(*) AS total FROM veiculos WHERE socio_id = ?').get(usuarioId).total;
}

function criarUsuario({ nome, login, senhaHash, perfil, trocarSenha = true }) {
  const info = db.prepare('INSERT INTO usuarios (nome, login, senha_hash, perfil, trocar_senha) VALUES (?, ?, ?, ?, ?)')
    .run(nome, login, senhaHash, perfil, trocarSenha ? 1 : 0);
  const id = Number(info.lastInsertRowid);
  vincularSociedadeLegada(id, nome);
  return buscarUsuario(id);
}

function atualizarUsuario(id, { nome, login, perfil, ativo, senhaHash, senhaProvisoria = true }) {
  transaction(() => {
    db.prepare('UPDATE usuarios SET nome = ?, login = ?, perfil = ?, ativo = ? WHERE id = ?')
      .run(nome, login, perfil, ativo ? 1 : 0, id);
    if (senhaHash) {
      // Senha definida pelo administrador é provisória: o usuário troca no próximo login
      db.prepare('UPDATE usuarios SET senha_hash = ?, trocar_senha = ? WHERE id = ?').run(senhaHash, senhaProvisoria ? 1 : 0, id);
    }
    // Usuário desativado ou com senha redefinida pelo administrador perde as sessões abertas
    if (!ativo || (senhaHash && senhaProvisoria)) {
      db.prepare('DELETE FROM sessoes WHERE usuario_id = ?').run(id);
    }
  });
  vincularSociedadeLegada(id, nome);
  return buscarUsuario(id);
}

function alterarSenha(id, senhaHash) {
  db.prepare('UPDATE usuarios SET senha_hash = ?, trocar_senha = 0 WHERE id = ?').run(senhaHash, id);
}

function excluirUsuario(id) {
  db.prepare('DELETE FROM usuarios WHERE id = ?').run(id);
}

/**
 * Veículos antigos guardam a sociedade como texto livre (ex: "Lagoa").
 * Quando existe um usuário com o mesmo nome, o veículo passa a ser dele.
 */
function vincularSociedadeLegada(usuarioId, nome) {
  const alvo = String(nome || '').trim().toLowerCase();
  if (!alvo) return 0;
  const candidatos = db.prepare('SELECT id, dados FROM veiculos WHERE socio_id IS NULL').all();
  const update = db.prepare('UPDATE veiculos SET socio_id = ? WHERE id = ?');
  let vinculados = 0;
  for (const row of candidatos) {
    const v = JSON.parse(row.dados);
    if (String(v.sociedade || '').trim().toLowerCase() === alvo) {
      update.run(usuarioId, row.id);
      vinculados++;
    }
  }
  return vinculados;
}

// ----------------------------------------------------------------------------
// Sessões
// ----------------------------------------------------------------------------
function criarSessao(tokenHash, usuarioId, expiraEm) {
  db.prepare('INSERT INTO sessoes (token_hash, usuario_id, expira_em) VALUES (?, ?, ?)').run(tokenHash, usuarioId, expiraEm);
}

function buscarSessao(tokenHash) {
  return db.prepare(`
    SELECT s.expira_em, u.id, u.nome, u.login, u.perfil, u.ativo, u.trocar_senha
    FROM sessoes s JOIN usuarios u ON u.id = s.usuario_id
    WHERE s.token_hash = ?
  `).get(tokenHash);
}

function excluirSessao(tokenHash) {
  db.prepare('DELETE FROM sessoes WHERE token_hash = ?').run(tokenHash);
}

function limparSessoesExpiradas() {
  db.prepare('DELETE FROM sessoes WHERE expira_em < ?').run(Date.now());
}

// ----------------------------------------------------------------------------
// Dados do sistema (veículos, despesas, documentos, parcelas)
// ----------------------------------------------------------------------------

/**
 * Retorna os dados visíveis para o usuário. O perfil de visualização recebe
 * somente os veículos em que é sócio e os registros ligados a eles.
 */
function lerDados(usuario) {
  const nomes = new Map(listarUsuarios().map(u => [u.id, u.nome]));
  const somenteSocio = usuario.perfil !== 'full';

  const veiculoRows = somenteSocio
    ? db.prepare('SELECT socio_id, dados FROM veiculos WHERE socio_id = ? ORDER BY id').all(usuario.id)
    : db.prepare('SELECT socio_id, dados FROM veiculos ORDER BY id').all();

  const veiculos = veiculoRows.map(row => {
    const v = JSON.parse(row.dados);
    v.socioId = row.socio_id ?? null;
    if (row.socio_id) v.sociedade = nomes.get(row.socio_id) || v.sociedade || '';
    return v;
  });

  const idsPermitidos = new Set(veiculos.map(v => Number(v.id)));
  const lerTabela = (tabela) => db.prepare(`SELECT veiculo_id, dados FROM ${tabela} ORDER BY id`).all()
    .filter(row => !somenteSocio || idsPermitidos.has(Number(row.veiculo_id)))
    .map(row => JSON.parse(row.dados));

  return {
    veiculos,
    despesas: lerTabela('despesas'),
    documentos: lerTabela('documentos'),
    pagamentos: lerTabela('pagamentos'),
    versao: getVersao()
  };
}

function bancoVazio() {
  return db.prepare('SELECT COUNT(*) AS total FROM veiculos').get().total === 0;
}

/**
 * Substitui todos os dados (perfil full). O socioId de cada veículo precisa
 * apontar para um usuário existente; sem ele, tenta vincular pela sociedade em texto.
 */
function salvarDados({ veiculos, despesas, documentos, pagamentos }) {
  const usuarios = listarUsuarios();
  const idsUsuarios = new Set(usuarios.map(u => u.id));
  const porNome = new Map(usuarios.map(u => [u.nome.trim().toLowerCase(), u.id]));

  return transaction(() => {
    db.exec('DELETE FROM veiculos; DELETE FROM despesas; DELETE FROM documentos; DELETE FROM pagamentos;');

    const insVeiculo = db.prepare('INSERT INTO veiculos (id, socio_id, dados) VALUES (?, ?, ?)');
    for (const v of veiculos) {
      let socioId = Number(v.socioId) || null;
      if (socioId && !idsUsuarios.has(socioId)) socioId = null;
      if (!socioId && v.sociedade) socioId = porNome.get(String(v.sociedade).trim().toLowerCase()) || null;
      const { socioId: _ignorado, ...registro } = v;
      insVeiculo.run(Number(v.id), socioId, JSON.stringify(registro));
    }

    const inserirFilhos = (tabela, lista) => {
      const stmt = db.prepare(`INSERT INTO ${tabela} (id, veiculo_id, dados) VALUES (?, ?, ?)`);
      for (const item of lista) {
        stmt.run(Number(item.id), Number(item.veiculoId) || 0, JSON.stringify(item));
      }
    };
    inserirFilhos('despesas', despesas);
    inserirFilhos('documentos', documentos);
    inserirFilhos('pagamentos', pagamentos);

    const novaVersao = getVersao() + 1;
    setMeta('versao', novaVersao);
    return novaVersao;
  });
}

/**
 * Carrega a base original da planilha a partir do data.js do front-end.
 */
function carregarBasePlanilha() {
  const codigo = fs.readFileSync(path.join(ROOT_DIR, 'data.js'), 'utf8');
  const contexto = {};
  vm.createContext(contexto);
  vm.runInContext(`${codigo}\nthis.__base = DEFAULT_DATABASE;`, contexto);
  return JSON.parse(JSON.stringify(contexto.__base));
}

function restaurarBasePlanilha() {
  const base = carregarBasePlanilha();
  const versao = salvarDados({
    veiculos: base.veiculos || [],
    despesas: base.despesas || [],
    documentos: base.documentos || [],
    pagamentos: base.pagamentos || []
  });
  setMeta('origem', 'planilha');
  return versao;
}

// ----------------------------------------------------------------------------
// Arquivos anexados
// ----------------------------------------------------------------------------
function documentoVisivel(documentoId, usuario) {
  const row = db.prepare('SELECT veiculo_id FROM documentos WHERE id = ?').get(documentoId);
  if (!row) return false;
  if (usuario.perfil === 'full') return true;
  const veiculo = db.prepare('SELECT socio_id FROM veiculos WHERE id = ?').get(row.veiculo_id);
  return !!veiculo && veiculo.socio_id === usuario.id;
}

function salvarArquivo(documentoId, arquivo) {
  const tamanho = Number(arquivo.tamanhoBytes) || Math.round(String(arquivo.dataBase64 || '').length * 0.75);
  db.prepare(`
    INSERT INTO arquivos (documento_id, tamanho_bytes, dados) VALUES (?, ?, ?)
    ON CONFLICT(documento_id) DO UPDATE SET tamanho_bytes = excluded.tamanho_bytes, dados = excluded.dados
  `).run(documentoId, tamanho, JSON.stringify(arquivo));
}

function lerArquivo(documentoId) {
  const row = db.prepare('SELECT dados FROM arquivos WHERE documento_id = ?').get(documentoId);
  return row ? JSON.parse(row.dados) : null;
}

function excluirArquivo(documentoId) {
  db.prepare('DELETE FROM arquivos WHERE documento_id = ?').run(documentoId);
}

function totalBytesArquivos(usuario) {
  if (usuario.perfil === 'full') {
    return db.prepare('SELECT COALESCE(SUM(tamanho_bytes), 0) AS total FROM arquivos').get().total;
  }
  return db.prepare(`
    SELECT COALESCE(SUM(a.tamanho_bytes), 0) AS total
    FROM arquivos a
    JOIN documentos d ON d.id = a.documento_id
    JOIN veiculos v ON v.id = d.veiculo_id
    WHERE v.socio_id = ?
  `).get(usuario.id).total;
}

module.exports = {
  DB_PATH,
  getMeta,
  setMeta,
  contarUsuarios,
  listarUsuarios,
  buscarUsuario,
  buscarUsuarioPorLogin,
  contarAdminsAtivos,
  contarVeiculosDoSocio,
  criarUsuario,
  atualizarUsuario,
  alterarSenha,
  excluirUsuario,
  criarSessao,
  buscarSessao,
  excluirSessao,
  limparSessoesExpiradas,
  lerDados,
  bancoVazio,
  salvarDados,
  restaurarBasePlanilha,
  documentoVisivel,
  salvarArquivo,
  lerArquivo,
  excluirArquivo,
  totalBytesArquivos
};
