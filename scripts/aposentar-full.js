/**
 * @module scripts/aposentar-full
 * @description Apaga `full_webp` e `preview_webp` dos bancos de projeto.
 *
 * IRREVERSIVEL. Depois disto, esta maquina nao tem mais como regerar tile nem
 * provar pixel contra a fonte. O chefe autorizou por escrito, e os dados desta
 * maquina sao copia de teste: a producao esta no servidor.
 *
 * O PORTAO QUE PRECEDE ESTE SCRIPT, e ele nao e formalidade:
 *  1. As 99.035 fotos na escada que desce ate um tile, conferido por formato.
 *  2. Prova de pixel do nivel 0 contra o `full_webp` nos 29 projetos: pior erro
 *     4,64/255, com contraprova do par errado em 119,96/255.
 *  3. Os 346 cantos que o descritor publica, todos 200.
 *  4. Log de rede do navegador: ZERO pedido a `quality=preview` e a
 *     `quality=full`, com arrasto, zoom, painel de retaguarda e troca de foto.
 *
 * O que ele NAO apaga: a tabela `images` continua existindo, so sem as duas
 * colunas de blob. Assim `photo_id` sobrevive como registro de que a foto teve
 * imagem, e o `getImageBlob` responde 404 em vez de 500 (ver src/db/queries.js).
 *
 * Uso:
 *   node scripts/aposentar-full.js --dry-run
 *   node scripts/aposentar-full.js --so blumenau
 *   node scripts/aposentar-full.js
 */

import Database from 'better-sqlite3';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import config from '../src/config.js';

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const so = argv.includes('--so') ? new Set(argv[argv.indexOf('--so') + 1].split(',')) : null;

const idx = new Database(config.indexDbPath, { readonly: true });
const projetos = idx.prepare('SELECT id, slug, db_filename FROM projects ORDER BY slug').all();

const GB = (b) => (b / 1073741824).toFixed(2);
let liberado = 0, feitos = 0, pulados = 0;

console.log(dryRun ? 'APOSENTAR full_webp e preview_webp (--dry-run, nada e escrito)' : 'APOSENTAR full_webp e preview_webp');
console.log('');

for (const p of projetos) {
  if (so && !so.has(p.slug)) continue;
  const caminho = resolve(config.projectsDbDir, p.db_filename);
  const tiles = resolve(config.projectsDbDir, `${p.slug}_tiles.db`);
  if (!existsSync(caminho)) { console.log(`  ${p.slug}: sem banco de imagem`); continue; }

  // GUARDA: nao apaga imagem de projeto que nao tem piramide completa. A
  // conferencia e por foto viva, e nao por arquivo existir.
  if (!existsSync(tiles)) { console.log(`  ${p.slug}: PULADO, sem banco de tiles`); pulados++; continue; }
  const vivas = idx.prepare(
    'SELECT COUNT(*) c FROM photos WHERE project_id = ? AND id NOT IN (SELECT photo_id FROM deleted_photos)',
  ).get(p.id).c;
  const t = new Database(tiles, { readonly: true });
  const comPiramide = t.prepare('SELECT COUNT(*) c FROM tile_pyramids').get().c;
  t.close();
  if (comPiramide < vivas) {
    console.log(`  ${p.slug}: PULADO, piramide incompleta (${comPiramide}/${vivas})`);
    pulados++;
    continue;
  }

  const antes = statSync(caminho).size;
  if (dryRun) {
    console.log(`  ${p.slug}: ${GB(antes)} GB, ${comPiramide} piramides, apagaria as duas colunas`);
    feitos++;
    continue;
  }

  const db = new Database(caminho);
  const colunas = db.prepare('PRAGMA table_info(images)').all().map(c => c.name);
  db.exec('PRAGMA journal_mode = DELETE');
  for (const col of ['full_webp', 'preview_webp']) {
    if (colunas.includes(col)) db.exec(`ALTER TABLE images DROP COLUMN ${col}`);
  }
  // O VACUUM e o que devolve o espaco: sem ele o arquivo mantem o tamanho e as
  // paginas apenas viram espaco livre interno.
  db.exec('VACUUM');
  db.close();

  const depois = statSync(caminho).size;
  liberado += antes - depois;
  feitos++;
  console.log(`  ${p.slug}: ${GB(antes)} -> ${GB(depois)} GB   liberou ${GB(antes - depois)} GB`);
}

console.log('');
console.log(`  ${feitos} projeto(s) ${dryRun ? 'seriam tratados' : 'tratados'}, ${pulados} pulado(s)`);
if (!dryRun) console.log(`  liberado: ${GB(liberado)} GB`);
