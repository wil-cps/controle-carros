-- AutoManage Toledo - estrutura do banco D1 (SQLite na Cloudflare)
-- Cada entidade guarda as colunas usadas em relacionamentos e controle de acesso
-- (id, veiculo_id, socio_id) e o registro completo do front-end em JSON (dados).

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

-- Dados do arquivo anexado (nome, tipo, tamanho). O conteúdo fica no KV (binding ARQUIVOS).
CREATE TABLE IF NOT EXISTS arquivos (
  documento_id INTEGER PRIMARY KEY,
  tamanho_bytes INTEGER NOT NULL DEFAULT 0,
  dados TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  chave TEXT PRIMARY KEY,
  valor TEXT
);

-- Bloqueio de login após muitas tentativas erradas (por IP)
CREATE TABLE IF NOT EXISTS tentativas_login (
  ip TEXT PRIMARY KEY,
  falhas INTEGER NOT NULL DEFAULT 0,
  expira_em INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_veiculos_socio ON veiculos(socio_id);
CREATE INDEX IF NOT EXISTS idx_despesas_veiculo ON despesas(veiculo_id);
CREATE INDEX IF NOT EXISTS idx_documentos_veiculo ON documentos(veiculo_id);
CREATE INDEX IF NOT EXISTS idx_pagamentos_veiculo ON pagamentos(veiculo_id);
CREATE INDEX IF NOT EXISTS idx_sessoes_usuario ON sessoes(usuario_id);
