/**
 * Backup completo do sistema publicado na Cloudflare.
 *
 * Cria a pasta backups/AAAA-MM-DD_HHMM/ com:
 *  - banco.sql          → cópia do banco D1 (restaura com: npx wrangler d1 execute controle-carros --remote --file <arquivo>)
 *  - arquivos-N.json    → fotos e documentos do KV (restaura com: npx wrangler kv bulk put <arquivo> --binding ARQUIVOS --remote)
 *
 * Uso: npm run backup            (sistema publicado)
 *      npm run backup -- --local (ambiente de testes deste computador)
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const MAX_BYTES_LOTE = 90 * 1024 * 1024;
const local = process.argv.includes('--local');
const alvo = local ? '--local' : '--remote';

const raiz = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const agora = new Date();
const carimbo = `${agora.getFullYear()}-${String(agora.getMonth() + 1).padStart(2, '0')}-${String(agora.getDate()).padStart(2, '0')}_${String(agora.getHours()).padStart(2, '0')}${String(agora.getMinutes()).padStart(2, '0')}`;
const pasta = path.join(raiz, 'backups', `${carimbo}${local ? '_local' : ''}`);
fs.mkdirSync(pasta, { recursive: true });

function wrangler(args, { capturar = false } = {}) {
  const comando = ['npx', 'wrangler', ...args].map(a => /^[\w.:/\\-]+$/.test(a) ? a : `"${a.replace(/"/g, '\\"')}"`).join(' ');
  const r = spawnSync(comando, {
    cwd: raiz,
    shell: true,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: capturar ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    env: { ...process.env, CI: 'true' }
  });
  if (r.status !== 0) {
    if (capturar) process.stderr.write(r.stderr || '');
    throw new Error(`Falhou: wrangler ${args.join(' ')}`);
  }
  return r.stdout;
}

console.log(`Backup ${local ? 'do ambiente local' : 'do sistema publicado'} em ${pasta}\n`);

console.log('1/2 Banco de dados (D1)...');
wrangler(['d1', 'export', 'controle-carros', alvo, '--output', path.join(pasta, 'banco.sql')]);

console.log('\n2/2 Fotos e documentos (KV)...');
const chaves = JSON.parse(wrangler(['kv', 'key', 'list', '--binding', 'ARQUIVOS', alvo], { capturar: true }));
let lote = [];
let tamanho = 0;
let numero = 0;
const gravarLote = () => {
  if (!lote.length) return;
  numero++;
  fs.writeFileSync(path.join(pasta, `arquivos-${numero}.json`), JSON.stringify(lote), 'utf8');
  lote = [];
  tamanho = 0;
};
chaves.forEach(({ name }, i) => {
  // O wrangler acrescenta uma quebra de linha no fim; o conteúdo (base64) nunca termina com ela
  const valor = wrangler(['kv', 'key', 'get', name, '--binding', 'ARQUIVOS', alvo, '--text'], { capturar: true }).replace(/\r?\n$/, '');
  if (tamanho + valor.length > MAX_BYTES_LOTE) gravarLote();
  lote.push({ key: name, value: valor });
  tamanho += valor.length;
  process.stdout.write(`\r  ${i + 1}/${chaves.length} arquivo(s)`);
});
gravarLote();

console.log(`\n\nBackup concluído: ${pasta}`);
console.log('Guarde esta pasta fora deste computador (Google Drive, OneDrive, HD externo).');
