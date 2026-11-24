/**
 * Exporta o banco da versão anterior (servidor Node, dados/automanage.db) para a Cloudflare.
 *
 * Gera na pasta migracao/:
 *  - d1-importacao.sql      → dados para o D1 (substitui o que houver lá)
 *  - kv-arquivos-N.json     → fotos e documentos para o KV
 *  - senhas-provisorias.txt → nova senha provisória de cada usuário
 *
 * As senhas antigas usavam outro formato (scrypt) e não podem ser convertidas.
 * Cada usuário recebe uma senha provisória e cria a própria no primeiro login.
 *
 * Uso: npm run exportar-banco-local [-- caminho/do/automanage.db]
 */
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const PBKDF2_ITERACOES = 30000; // igual ao worker/index.js
const MAX_BYTES_KV = 90 * 1024 * 1024; // limite do "kv bulk put" é 100 MB por arquivo
const MAX_ITENS_KV = 10000;

const raiz = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const origem = path.resolve(process.argv[2] || path.join(raiz, 'dados', 'automanage.db'));
const destino = path.join(raiz, 'migracao');

if (!fs.existsSync(origem)) {
  console.error(`Banco não encontrado: ${origem}`);
  process.exit(1);
}

const db = new DatabaseSync(origem, { readOnly: true });
const todos = (sql) => db.prepare(sql).all();
const temTabela = (nome) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(nome);

const sqlTexto = (valor) => valor === null || valor === undefined ? 'NULL' : `'${String(valor).replace(/'/g, "''")}'`;
const sqlNumero = (valor) => valor === null || valor === undefined || valor === '' ? 'NULL' : String(Number(valor));

function hashSenha(senha) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.pbkdf2Sync(senha, salt, PBKDF2_ITERACOES, 32, 'sha256');
  return `pbkdf2$${PBKDF2_ITERACOES}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function senhaProvisoria() {
  const alfabeto = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  return Array.from(crypto.randomBytes(10), b => alfabeto[b % alfabeto.length]).join('');
}

fs.mkdirSync(destino, { recursive: true });
for (const f of fs.readdirSync(destino)) {
  if (/^(d1-importacao\.sql|kv-arquivos-\d+\.json|senhas-provisorias\.txt)$/.test(f)) fs.rmSync(path.join(destino, f));
}

const linhas = [
  '-- Gerado por scripts/exportar-banco-local.mjs em ' + new Date().toISOString(),
  '-- Substitui todos os dados do D1 pelos do banco local.',
  'DELETE FROM sessoes;',
  'DELETE FROM tentativas_login;',
  'DELETE FROM arquivos;',
  'DELETE FROM despesas;',
  'DELETE FROM documentos;',
  'DELETE FROM pagamentos;',
  'DELETE FROM veiculos;',
  'DELETE FROM usuarios;',
  'DELETE FROM meta;'
];

// Usuários (com senha provisória)
const usuarios = todos('SELECT id, nome, login, perfil, ativo, criado_em FROM usuarios ORDER BY id');
const senhas = [];
for (const u of usuarios) {
  const senha = senhaProvisoria();
  senhas.push({ ...u, senha });
  linhas.push(`INSERT INTO usuarios (id, nome, login, senha_hash, perfil, ativo, trocar_senha, criado_em) VALUES (${sqlNumero(u.id)}, ${sqlTexto(u.nome)}, ${sqlTexto(u.login)}, ${sqlTexto(hashSenha(senha))}, ${sqlTexto(u.perfil)}, ${u.ativo ? 1 : 0}, 1, ${sqlTexto(u.criado_em)});`);
}

// Veículos e registros ligados a eles
for (const v of todos('SELECT id, socio_id, dados FROM veiculos ORDER BY id')) {
  linhas.push(`INSERT INTO veiculos (id, socio_id, dados) VALUES (${sqlNumero(v.id)}, ${sqlNumero(v.socio_id)}, ${sqlTexto(v.dados)});`);
}
const contagem = { usuarios: usuarios.length, veiculos: 0 };
contagem.veiculos = todos('SELECT COUNT(*) AS t FROM veiculos')[0].t;
for (const tabela of ['despesas', 'documentos', 'pagamentos']) {
  const rows = todos(`SELECT id, veiculo_id, dados FROM ${tabela} ORDER BY id`);
  contagem[tabela] = rows.length;
  for (const r of rows) {
    linhas.push(`INSERT INTO ${tabela} (id, veiculo_id, dados) VALUES (${sqlNumero(r.id)}, ${sqlNumero(r.veiculo_id)}, ${sqlTexto(r.dados)});`);
  }
}

// Metadados (a versão segue a do banco local; "inicializado" evita recarregar a planilha)
const meta = new Map(todos('SELECT chave, valor FROM meta').map(m => [m.chave, m.valor]));
meta.set('inicializado', '1');
if (!meta.has('versao')) meta.set('versao', '0');
for (const [chave, valor] of meta) {
  linhas.push(`INSERT INTO meta (chave, valor) VALUES (${sqlTexto(chave)}, ${sqlTexto(valor)});`);
}

// Arquivos: informações no D1, conteúdo no KV
const lotes = [];
let lote = [];
let tamanhoLote = 0;
let totalArquivos = 0;
if (temTabela('arquivos')) {
  for (const a of db.prepare('SELECT documento_id, tamanho_bytes, dados FROM arquivos ORDER BY documento_id').iterate()) {
    const registro = JSON.parse(a.dados);
    const { dataBase64, ...info } = registro;
    if (typeof dataBase64 !== 'string' || !dataBase64) continue;
    linhas.push(`INSERT INTO arquivos (documento_id, tamanho_bytes, dados) VALUES (${sqlNumero(a.documento_id)}, ${sqlNumero(a.tamanho_bytes)}, ${sqlTexto(JSON.stringify({ ...info, id: a.documento_id }))});`);
    const item = { key: `arquivo:${a.documento_id}`, value: dataBase64 };
    const tamanho = dataBase64.length + 64;
    if (lote.length && (tamanhoLote + tamanho > MAX_BYTES_KV || lote.length >= MAX_ITENS_KV)) {
      lotes.push(lote);
      lote = [];
      tamanhoLote = 0;
    }
    lote.push(item);
    tamanhoLote += tamanho;
    totalArquivos++;
  }
}
if (lote.length) lotes.push(lote);
contagem.arquivos = totalArquivos;

fs.writeFileSync(path.join(destino, 'd1-importacao.sql'), linhas.join('\n') + '\n', 'utf8');
lotes.forEach((itens, i) => {
  fs.writeFileSync(path.join(destino, `kv-arquivos-${i + 1}.json`), JSON.stringify(itens), 'utf8');
});
fs.writeFileSync(
  path.join(destino, 'senhas-provisorias.txt'),
  ['Senhas provisórias (cada usuário cria a própria senha no primeiro login). Apague este arquivo depois de repassar.', '']
    .concat(senhas.map(s => `${s.nome} | login: ${s.login} | senha provisória: ${s.senha}${s.ativo ? '' : ' (usuário inativo)'}`))
    .join('\n') + '\n',
  'utf8'
);

console.log(`Banco lido: ${origem}`);
console.log(Object.entries(contagem).map(([k, v]) => `  ${k}: ${v}`).join('\n'));
console.log(`\nArquivos gerados em ${destino}`);
console.log('\nPara enviar à Cloudflare, rode na pasta do projeto:');
console.log('  npx wrangler d1 execute controle-carros --remote --file migracao/d1-importacao.sql');
lotes.forEach((_, i) => console.log(`  npx wrangler kv bulk put migracao/kv-arquivos-${i + 1}.json --binding ARQUIVOS --remote`));
console.log('\nAs senhas provisórias estão em migracao/senhas-provisorias.txt');
