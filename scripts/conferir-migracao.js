#!/usr/bin/env node

/**
 * @module scripts/conferir-migracao
 * @description Pós-flight de uma migração: relê o `index.db` contra o backup de
 * ANTES e contra a pasta preparada que entrou, na mesma extensão da escrita.
 *
 * Reprova se: algum projeto anterior mudou de contagem ou centro; o acréscimo
 * de fotos não é exatamente o da pasta; lat/lon/ele/heading/mesh_rotation_y de
 * alguma foto diverge do JSON; `sequence_number` tem furo; algum alvo original
 * do JSON falta no banco; algum blob não decodifica no tamanho gravado.
 *
 * Uso:
 *   node scripts/conferir-migracao.js --data <DATA_DIR> --antes <index.db de backup> \
 *        --slug <slug> --pasta <pasta preparada> [--sem-imagens]
 */

import Database from 'better-sqlite3';
import sharp from 'sharp';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const pega = (n) => { const i = args.indexOf(`--${n}`); return i === -1 ? null : args[i + 1]; };
const data = pega('data'); const antesPath = pega('antes'); const slug = pega('slug'); const pasta = pega('pasta');
const semImagens = args.includes('--sem-imagens');
const falhas = [];
const falha = (m) => { falhas.push(m); console.log(`  REPROVA: ${m}`); };

const db = new Database(join(data, 'index.db'), { readonly: true });
const antes = new Database(antesPath, { readonly: true });

// 1. projetos anteriores intocados
const proj = (d) => new Map(d.prepare(`SELECT p.slug, p.center_lat, p.center_lon, (SELECT count(*) FROM photos f WHERE f.project_id = p.id) n FROM projects p`).all().map((r) => [r.slug, r]));
const pa = proj(antes); const pd = proj(db);
for (const [s, r] of pa) {
  const d = pd.get(s);
  if (!d) falha(`projeto ${s} sumiu`);
  else if (d.n !== r.n || d.center_lat !== r.center_lat || d.center_lon !== r.center_lon) falha(`projeto ${s} mudou (${r.n} -> ${d.n})`);
}

// 2. o projeto novo contra a pasta
const jsons = readdirSync(pasta).filter((f) => f.endsWith('.json'));
const src = new Map(jsons.map((f) => [f.slice(0, -5), JSON.parse(readFileSync(join(pasta, f), 'utf-8'))]));
const p = db.prepare('SELECT * FROM projects WHERE slug = ?').get(slug);
if (!p) { falha(`projeto ${slug} ausente`); process.exit(1); }
const fotos = db.prepare('SELECT * FROM photos WHERE project_id = ?').all(p.id);
if (fotos.length !== src.size) falha(`${fotos.length} fotos no banco contra ${src.size} JSON`);
const totalAntes = antes.prepare('SELECT count(*) c FROM photos').get().c;
const totalDepois = db.prepare('SELECT count(*) c FROM photos').get().c;
const novosOutros = [...pd.keys()].filter((s) => !pa.has(s) && s !== slug);
const esperadoOutros = novosOutros.reduce((a, s) => a + pd.get(s).n, 0);
if (totalDepois - totalAntes !== fotos.length + esperadoOutros) falha(`acréscimo de ${totalDepois - totalAntes} fotos, esperado ${fotos.length + esperadoOutros}`);

const tol = 1e-9; let campos = 0;
const porNome = new Map(fotos.map((f) => [f.original_name, f]));
for (const [n, j] of src) {
  const f = porNome.get(n); const c = j.camera;
  if (!f) { falha(`foto ${n} ausente`); continue; }
  for (const [k, v] of [['lat', c.lat], ['lon', c.lon], ['ele', c.ele], ['heading', c.heading], ['mesh_rotation_y', c.mesh_rotation_y]]) {
    campos++;
    if (v != null && Math.abs(f[k] - v) > tol) falha(`${n}.${k}: banco ${f[k]} contra JSON ${v}`);
  }
}
const seqs = fotos.map((f) => f.sequence_number).sort((a, b) => a - b);
if (seqs[0] !== 1 || seqs.some((s, i) => s !== i + 1)) falha('sequence_number com furo');
if (!porNome.has(src.keys().next().value)) falha('nome não casa');
const entrada = fotos.find((f) => f.id === p.entry_photo_id);
if (!entrada) falha('foto de entrada não pertence ao projeto');

// alvos originais: todo par do JSON tem de estar no banco
const idDe = new Map(fotos.map((f) => [f.original_name, f.id]));
const tg = db.prepare('SELECT source_id, target_id, is_original FROM targets WHERE source_id IN (SELECT id FROM photos WHERE project_id = ?)').all(p.id);
const chave = new Set(tg.map((t) => `${t.source_id}>${t.target_id}`));
const paresJson = new Set();
for (const [n, j] of src) for (const t of j.targets) if (idDe.has(t.img)) paresJson.add(`${idDe.get(n)}>${idDe.get(t.img)}`);
let faltam = 0; for (const k of paresJson) if (!chave.has(k)) faltam++;
if (faltam) falha(`${faltam} alvos originais do JSON ausentes no banco`);

// 3. blobs
let blobs = 0;
if (!semImagens) {
  const pdb = new Database(join(data, 'projects', p.db_filename), { readonly: true });
  const st = pdb.prepare('SELECT full_webp, preview_webp FROM images WHERE photo_id = ?');
  for (const f of fotos) {
    const r = st.get(f.id);
    if (!r) { falha(`blob ausente ${f.original_name}`); continue; }
    const [mf, mp] = await Promise.all([sharp(r.full_webp).metadata(), sharp(r.preview_webp).metadata()]);
    if (mf.width !== 7680 || mf.height !== 3840 || mp.width !== 512 || mp.height !== 256) falha(`${f.original_name}: ${mf.width}x${mf.height} / ${mp.width}x${mp.height}`);
    if (r.full_webp.length !== f.full_size_bytes || r.preview_webp.length !== f.preview_size_bytes) falha(`${f.original_name}: tamanho do blob não bate`);
    blobs++;
  }
}

console.log(`${slug}: ${fotos.length} fotos, ${campos} campos conferidos, ${tg.length} alvos (${paresJson.size} originais do JSON), ${blobs} blobs decodificados, ${pa.size} projetos anteriores intocados, total ${totalAntes} -> ${totalDepois}`);
console.log(falhas.length ? `REPROVADO: ${falhas.length} falha(s)` : 'APROVADO');
process.exit(falhas.length ? 1 : 0);
