#!/usr/bin/env node

/**
 * @module scripts/transplantar-projeto
 * @description Leva UM projeto de um `index.db` para outro, sem tocar em nada
 * do que ja existe no destino.
 *
 * Existe porque re-migrar nao serve: o `migrate.js` re-deriva tudo dos JSON da
 * entrega, e ali nao existem a calibracao feita a mao, as ligacoes criadas na
 * tela nem as marcas de revisada. Quem tem um projeto pronto numa base e
 * precisa dele em outra quer TRANSPLANTE, e nao reimportacao.
 *
 * Duas armadilhas mandam no desenho, e as duas custaram caro no lote do
 * Beira-Rio (Decisions 2026-08-10):
 *
 *   1. `photos_rowid` e AUTOINCREMENT e e ele que indexa o rtree espacial.
 *      Copiar o `rowid_id` como esta COLIDE com o do destino. Aqui o id nasce
 *      no destino e as linhas do rtree sao remapeadas para ele.
 *   2. A ordem das chaves estrangeiras nao e escolha: `capture_runs` entra
 *      ANTES de `photos`, porque `photos.run_id` aponta para `capture_runs(id)`.
 *      Descobre-se por `pragma foreign_key_list`, nao por tentativa.
 *
 * O `capture_runs.id` e TEXT e o `project_floors` tem chave composta, entao
 * nenhum dos dois precisa de remapeamento: so da ordem acima.
 *
 * SEM `--aplicar` E ENSAIO, e o ensaio escreve de verdade: monta o payload,
 * insere dentro de uma transacao, roda a bateria de conferencias contra o
 * arquivo ja escrito, e ENTAO desfaz. So o commit muda entre ensaiar e gravar,
 * e qualquer reprovacao desfaz tudo sozinha.
 *
 * Uso:
 *   node scripts/transplantar-projeto.js --slug <slug> --destino <index.db> \
 *        [--origem ./data/index.db] [--aplicar]
 */

import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';

const args = process.argv.slice(2);
const pega = (nome, padrao = null) => {
  const i = args.indexOf(`--${nome}`);
  return i === -1 || i + 1 >= args.length ? padrao : args[i + 1];
};
const slug = pega('slug');
const destinoPath = pega('destino');
const origemPath = pega('origem', './data/index.db');
const aplicar = args.includes('--aplicar');

if (!slug || !destinoPath) {
  console.error('Uso: node scripts/transplantar-projeto.js --slug <slug> --destino <index.db> [--origem ./data/index.db] [--aplicar]');
  process.exit(1);
}
for (const [rot, p] of [['origem', origemPath], ['destino', destinoPath]]) {
  if (!existsSync(p)) { console.error(`Erro: ${rot} nao existe: ${p}`); process.exit(1); }
}

const org = new Database(origemPath, { readonly: true });
const dst = new Database(destinoPath);

const colunas = (db, tabela) => db.prepare(`SELECT * FROM ${tabela} LIMIT 1`).columns().map((c) => c.name);
const comuns = (t) => { const a = new Set(colunas(dst, t)); return colunas(org, t).filter((c) => a.has(c)); };
const contar = (db, t, onde = '', ...p) => db.prepare(`SELECT count(*) c FROM ${t} ${onde}`).get(...p).c;

// ============================================================
// Payload, lido da origem
// ============================================================

const proj = org.prepare('SELECT * FROM projects WHERE slug=?').get(slug);
if (!proj) { console.error(`Erro: a origem nao tem o projeto '${slug}'.`); process.exit(1); }
if (contar(dst, 'projects', 'WHERE slug=?', slug) > 0) {
  console.error(`Erro: o DESTINO ja tem '${slug}'. Transplantar por cima duplicaria o projeto.`);
  process.exit(1);
}

const fotos = org.prepare('SELECT * FROM photos WHERE project_id=? ORDER BY sequence_number').all(proj.id);
if (fotos.length === 0) { console.error(`Erro: o projeto '${slug}' nao tem foto nenhuma na origem.`); process.exit(1); }
const ids = fotos.map((f) => f.id);
const lista = ids.map(() => '?').join(',');

const lapides = org.prepare(`SELECT * FROM deleted_photos WHERE photo_id IN (${lista})`).all(...ids);
const alvos = org.prepare(`SELECT * FROM targets WHERE source_id IN (${lista})`).all(...ids);
const faixas = org.prepare('SELECT * FROM capture_runs WHERE project_id=? ORDER BY ordinal').all(proj.id);
const andares = org.prepare('SELECT * FROM project_floors WHERE project_id=? ORDER BY level').all(proj.id);
const tracks = org.prepare('SELECT * FROM project_tracks WHERE project_id=?').all(proj.id);
// rowid_id + bbox do rtree, na origem. So as vivas tem linha aqui: o
// soft-delete apaga a do rtree e a do rowid.
const espaciais = org.prepare(`
  SELECT w.photo_id, r.min_lon, r.max_lon, r.min_lat, r.max_lat
  FROM photos_rowid w JOIN photos_rtree r ON r.rowid_id = w.rowid_id
  WHERE w.photo_id IN (${lista})`).all(...ids);

const vivasEsperadas = fotos.length - lapides.length;

console.log(`== payload lido da origem (${origemPath})`);
console.log(`  projeto        ${proj.slug} "${proj.name}" | photo_count=${proj.photo_count} | db_filename=${proj.db_filename}`);
console.log(`  photos         ${fotos.length} (vivas ${vivasEsperadas}, lapides ${lapides.length})`);
console.log(`  targets        ${alvos.length} (da captura ${alvos.filter((t) => t.is_original).length}, criados a mao ${alvos.filter((t) => !t.is_original).length})`);
console.log(`  rowid/rtree    ${espaciais.length}`);
console.log(`  capture_runs   ${faixas.length} | project_floors ${andares.length} | project_tracks ${tracks.length}`);

if (espaciais.length !== vivasEsperadas) {
  console.error(`Erro: ${espaciais.length} linhas de rtree para ${vivasEsperadas} fotos vivas. A origem esta inconsistente, e o transplante levaria o defeito junto.`);
  process.exit(1);
}
if (proj.photo_count !== vivasEsperadas) {
  console.error(`Erro: projects.photo_count=${proj.photo_count} e as vivas sao ${vivasEsperadas}. Conserte a origem antes.`);
  process.exit(1);
}

// ============================================================
// Estado do destino, antes
// ============================================================

const ANTES = {
  projects: contar(dst, 'projects'), photos: contar(dst, 'photos'), targets: contar(dst, 'targets'),
  rtree: contar(dst, 'photos_rtree'), rowid: contar(dst, 'photos_rowid'),
  deleted: contar(dst, 'deleted_photos'), runs: contar(dst, 'capture_runs'),
  floors: contar(dst, 'project_floors'), tracks: contar(dst, 'project_tracks'),
};
const maxRowid = dst.prepare('SELECT max(rowid_id) m FROM photos_rowid').get().m ?? 0;
const outrosAntes = dst.prepare('SELECT slug, name, photo_count, entry_photo_id FROM projects ORDER BY slug').all();
console.log(`== destino antes (${destinoPath})`);
console.log(' ', JSON.stringify(ANTES), `| maior rowid_id ${maxRowid}`);

// ============================================================
// Escrita
// ============================================================

const insere = (t, c) => dst.prepare(`INSERT INTO ${t} (${c.join(',')}) VALUES (${c.map((x) => '@' + x).join(',')})`);
const cProj = comuns('projects'), cFoto = comuns('photos'), cAlvo = comuns('targets');
const cLap = comuns('deleted_photos'), cRun = comuns('capture_runs'), cAnd = comuns('project_floors'), cTrk = comuns('project_tracks').filter((c) => c !== 'id');
const insProj = insere('projects', cProj), insFoto = insere('photos', cFoto), insAlvo = insere('targets', cAlvo);
const insLap = insere('deleted_photos', cLap), insRun = insere('capture_runs', cRun), insAnd = insere('project_floors', cAnd), insTrk = insere('project_tracks', cTrk);
const insRowid = dst.prepare('INSERT INTO photos_rowid (photo_id) VALUES (?)');
const insRtree = dst.prepare('INSERT INTO photos_rtree (rowid_id, min_lon, max_lon, min_lat, max_lat) VALUES (?,?,?,?,?)');
const so = (o, c) => Object.fromEntries(c.map((k) => [k, o[k] ?? null]));

const rowidsNovos = [];
dst.exec('BEGIN');
try {
  insProj.run(so(proj, cProj));
  // capture_runs ANTES de photos: photos.run_id referencia capture_runs(id).
  for (const r of faixas) insRun.run(so(r, cRun));
  for (const f of fotos) insFoto.run(so(f, cFoto));
  for (const l of lapides) insLap.run(so(l, cLap));
  for (const e of espaciais) {
    const novo = insRowid.run(e.photo_id).lastInsertRowid; // o id nasce AQUI
    insRtree.run(novo, e.min_lon, e.max_lon, e.min_lat, e.max_lat);
    rowidsNovos.push(novo);
  }
  for (const t of alvos) insAlvo.run(so(t, cAlvo));
  for (const a of andares) insAnd.run(so(a, cAnd));
  for (const t of tracks) insTrk.run(so(t, cTrk));

  // ==========================================================
  // Conferencia, contra o arquivo JA escrito
  // ==========================================================

  const p2 = dst.prepare('SELECT * FROM projects WHERE slug=?').get(slug);
  const doProjeto = (t, campo = 'project_id') => contar(dst, t, `WHERE ${campo}=?`, p2.id);
  const vivas = contar(dst, 'photos', 'WHERE project_id=? AND id NOT IN (SELECT photo_id FROM deleted_photos)', p2.id);
  const alvos2 = contar(dst, 'targets', 'WHERE source_id IN (SELECT id FROM photos WHERE project_id=?)', p2.id);
  const rt = dst.prepare(`SELECT count(*) c FROM photos_rtree r
                          JOIN photos_rowid w ON w.rowid_id=r.rowid_id
                          JOIN photos ph ON ph.id=w.photo_id WHERE ph.project_id=?`).get(p2.id).c;
  // Consulta espacial de verdade, na bbox das proprias fotos do projeto.
  const bb = org.prepare(`SELECT min(lon) a, max(lon) b, min(lat) c, max(lat) d FROM photos
                          WHERE project_id=? AND id NOT IN (SELECT photo_id FROM deleted_photos)`).get(proj.id);
  // A margem NAO e folga arbitraria: o R*Tree do SQLite guarda coordenada em
  // float32, arredondando o minimo para baixo e o maximo para cima. Medido no
  // serra_dourada, o `min_lon` cai ate 6,6e-6 grau abaixo do `lon` da foto, e
  // uma margem de 1e-6 reprova por arredondamento, e nao por linha faltando.
  // 1e-3 grau (cerca de 100 m) tolera isso e ainda reprova linha ausente ou
  // posta no lugar errado, que e o que esta conferencia existe para pegar.
  const eps = 1e-3;
  const naBbox = dst.prepare(`SELECT count(*) c FROM photos_rtree r
                              JOIN photos_rowid w ON w.rowid_id=r.rowid_id
                              JOIN photos ph ON ph.id=w.photo_id
                              WHERE ph.project_id=? AND r.min_lon BETWEEN ? AND ? AND r.min_lat BETWEEN ? AND ?`)
    .get(p2.id, bb.a - eps, bb.b + eps, bb.c - eps, bb.d + eps).c;

  const DEPOIS = {
    projects: contar(dst, 'projects'), photos: contar(dst, 'photos'), targets: contar(dst, 'targets'),
    rtree: contar(dst, 'photos_rtree'), rowid: contar(dst, 'photos_rowid'),
    deleted: contar(dst, 'deleted_photos'), runs: contar(dst, 'capture_runs'),
    floors: contar(dst, 'project_floors'), tracks: contar(dst, 'project_tracks'),
  };
  console.log('== destino depois');
  console.log(' ', JSON.stringify(DEPOIS));

  // Grafo entre as vivas, no destino.
  const vv = dst.prepare('SELECT id FROM photos WHERE project_id=? AND id NOT IN (SELECT photo_id FROM deleted_photos)').all(p2.id).map((r) => r.id);
  const adj = new Map(vv.map((i) => [i, new Set()]));
  for (const t of dst.prepare('SELECT source_id, target_id FROM targets WHERE source_id IN (SELECT id FROM photos WHERE project_id=?)').all(p2.id)) {
    if (!adj.has(t.source_id) || !adj.has(t.target_id)) continue;
    adj.get(t.source_id).add(t.target_id); adj.get(t.target_id).add(t.source_id);
  }
  const visto = new Set(); const comps = [];
  for (const i of adj.keys()) {
    if (visto.has(i)) continue;
    const pilha = [i]; visto.add(i); let n = 0;
    while (pilha.length) { const u = pilha.pop(); n++; for (const v of adj.get(u)) if (!visto.has(v)) { visto.add(v); pilha.push(v); } }
    comps.push(n);
  }
  comps.sort((a, b) => b - a);

  // Os componentes na ORIGEM: o transplante nao pode piorar o grafo, mas
  // tambem nao tem que consertar um grafo que ja entrou partido.
  const compsOrigem = (() => {
    const vvO = fotos.filter((f) => !lapides.some((l) => l.photo_id === f.id)).map((f) => f.id);
    const a = new Map(vvO.map((i) => [i, new Set()]));
    for (const t of alvos) { if (!a.has(t.source_id) || !a.has(t.target_id)) continue; a.get(t.source_id).add(t.target_id); a.get(t.target_id).add(t.source_id); }
    const vi = new Set(); const cs = [];
    for (const i of a.keys()) { if (vi.has(i)) continue; const p = [i]; vi.add(i); let n = 0; while (p.length) { const u = p.pop(); n++; for (const v of a.get(u)) if (!vi.has(v)) { vi.add(v); p.push(v); } } cs.push(n); }
    return cs.sort((x, y) => y - x);
  })();

  const outrosDepois = dst.prepare('SELECT slug, name, photo_count, entry_photo_id FROM projects WHERE slug<>? ORDER BY slug').all(slug);
  const mexidos = outrosDepois.filter((o, i) => JSON.stringify(o) !== JSON.stringify(outrosAntes[i]));

  const checa = [
    ['projects +1', DEPOIS.projects === ANTES.projects + 1],
    [`photos +${fotos.length}`, DEPOIS.photos === ANTES.photos + fotos.length],
    [`targets +${alvos.length}`, DEPOIS.targets === ANTES.targets + alvos.length],
    [`photos_rtree +${espaciais.length}`, DEPOIS.rtree === ANTES.rtree + espaciais.length],
    [`photos_rowid +${espaciais.length}`, DEPOIS.rowid === ANTES.rowid + espaciais.length],
    [`deleted_photos +${lapides.length}`, DEPOIS.deleted === ANTES.deleted + lapides.length],
    [`capture_runs +${faixas.length}`, DEPOIS.runs === ANTES.runs + faixas.length],
    [`project_floors +${andares.length}`, DEPOIS.floors === ANTES.floors + andares.length],
    [`project_tracks +${tracks.length}`, DEPOIS.tracks === ANTES.tracks + tracks.length],
    [`nome "${proj.name}" preservado`, p2.name === proj.name],
    [`photo_count ${vivasEsperadas}`, p2.photo_count === vivasEsperadas],
    [`fotos vivas ${vivasEsperadas}`, vivas === vivasEsperadas],
    [`alvos do projeto ${alvos.length}`, alvos2 === alvos.length],
    [`rtree do projeto ${espaciais.length}`, rt === espaciais.length],
    [`consulta espacial na bbox devolve ${espaciais.length}`, naBbox === espaciais.length],
    [`tracados do projeto ${tracks.length}`, doProjeto('project_tracks') === tracks.length],
    [`faixas do projeto ${faixas.length}`, doProjeto('capture_runs') === faixas.length],
    ['rowid novo, sem colidir com o do destino', rowidsNovos.every((r) => r > maxRowid)],
    ['foto de entrada existe e nao esta apagada',
      !!dst.prepare('SELECT 1 x FROM photos WHERE id=? AND id NOT IN (SELECT photo_id FROM deleted_photos)').get(p2.entry_photo_id)],
    ['nenhum alvo aponta para foto inexistente', contar(dst, 'targets', 'WHERE target_id NOT IN (SELECT id FROM photos)') === 0],
    ['nenhuma foto aponta para faixa inexistente',
      contar(dst, 'photos', 'WHERE run_id IS NOT NULL AND run_id NOT IN (SELECT id FROM capture_runs)') === 0],
    ['integrity_check', dst.pragma('integrity_check')[0].integrity_check === 'ok'],
    ['foreign_key_check', dst.pragma('foreign_key_check').length === 0],
    [`os ${outrosDepois.length} projetos que ja estavam la, intactos`, mexidos.length === 0],
    [`grafo igual ao da origem (${compsOrigem.join(',')})`, JSON.stringify(comps) === JSON.stringify(compsOrigem)],
  ];

  const ok = (c) => (c ? 'OK  ' : 'FALHA');
  for (const [rot, c] of checa) console.log(`  ${ok(c)} ${rot}`);
  if (mexidos.length > 0) console.log('  projetos alterados:', JSON.stringify(mexidos.slice(0, 5)));

  if (checa.some(([, c]) => !c)) {
    dst.exec('ROLLBACK');
    console.log('\n  ALGO REPROVOU. Desfeito, nada foi gravado.');
    process.exit(1);
  }

  if (aplicar) {
    dst.exec('COMMIT');
    dst.pragma('wal_checkpoint(TRUNCATE)');
    console.log('\n  GRAVADO, e o WAL fechado. Confira o arquivo NO DESTINO antes de publicar.');
  } else {
    dst.exec('ROLLBACK');
    console.log('\n  ENSAIO: tudo passou, e foi DESFEITO. Rode de novo com --aplicar para gravar.');
  }
} catch (err) {
  try { dst.exec('ROLLBACK'); } catch { /* a transacao ja caiu */ }
  console.error('\n  Erro no transplante, nada gravado:', err.message);
  process.exitCode = 1;
} finally {
  org.close();
  dst.close();
}
