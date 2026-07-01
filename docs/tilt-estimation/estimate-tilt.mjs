#!/usr/bin/env node
// Estima mesh_rotation_x (pitch) e mesh_rotation_z (roll) do SANTA_CRUZ a partir
// do acelerômetro (ax,ay,az), com suavização por mediana móvel (robusta ao rig em movimento).
// Variante A (frame do device, sem shift de 60°). Salva JSON p/ aplicar depois.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire('C:/Users/diniz/OneDrive/Desktop/Desenvolvimento/ebgeo_360/package.json');
const Database = require('better-sqlite3');

const DIR = 'D:/360/data/Nao_Processados/SANTIAGO/METADADOS/SANTA_CRUZ';
const OUT = process.argv[2] || 'C:/Users/diniz/AppData/Local/Temp/claude/C--Users-diniz-OneDrive-Desktop-Desenvolvimento-ebgeo-360/f4f6e965-a74b-488b-8067-c61aa5a23312/scratchpad/tilt_santa_cruz.json';
const R2D = 180 / Math.PI;
const W = 7;                 // janela ±7 frames
const CLEAN_LO = 0.9, CLEAN_HI = 1.1;
const clamp = (v) => Math.max(-30, Math.min(30, v));
const med = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };

// nome -> {uuid, display_name}
const db = new Database('C:/Users/diniz/OneDrive/Desktop/Desenvolvimento/ebgeo_360/data/index.db', { readonly: true });
const meta = new Map();
for (const r of db.prepare(`SELECT p.original_name o, p.display_name d, p.id id FROM photos p JOIN projects pr ON pr.id=p.project_id WHERE pr.slug='santa_cruz'`).all())
  meta.set(r.o, { uuid: r.id, display: r.d });
db.close();

// lê frames
let rows = [];
for (const f of readdirSync(DIR).filter(f => f.endsWith('.json'))) {
  let d; try { d = JSON.parse(readFileSync(DIR + '/' + f, 'utf8')); } catch { continue; }
  const c = d.camera || {};
  if ([c.ax, c.ay, c.az].some(v => typeof v !== 'number')) continue;
  const name = f.slice(0, -5);
  const mag = Math.hypot(c.ax, c.ay, c.az);
  rows.push({
    name, ...(meta.get(name) || {}),
    ax: c.ax, ay: c.ay, az: c.az, mag,
    clean: mag >= CLEAN_LO && mag < CLEAN_HI,
    roll0: Math.atan2(c.ax, -c.ay) * R2D,   // Variante A
    pitch0: Math.atan2(-c.az, -c.ay) * R2D,
  });
}
// ordem de captura: prefixo (segmento/timestamp) + índice numérico do output
const keyOf = (n) => { const m = n.match(/^(.*_output_)(\d+)$/); return m ? [m[1], parseInt(m[2], 10)] : [n, 0]; };
rows.sort((a, b) => { const ka = keyOf(a.name), kb = keyOf(b.name); return ka[0] < kb[0] ? -1 : ka[0] > kb[0] ? 1 : ka[1] - kb[1]; });

// mediana móvel usando só frames limpos na janela
for (let i = 0; i < rows.length; i++) {
  const wr = [], wp = [];
  for (let j = Math.max(0, i - W); j <= Math.min(rows.length - 1, i + W); j++)
    if (rows[j].clean) { wr.push(rows[j].roll0); wp.push(rows[j].pitch0); }
  // fallback: se não há limpos na janela, usa o próprio frame (ou 0)
  rows[i].est_z = clamp(wr.length ? med(wr) : (rows[i].clean ? rows[i].roll0 : 0));   // roll
  rows[i].est_x = clamp(wp.length ? med(wp) : (rows[i].clean ? rows[i].pitch0 : 0));  // pitch
  rows[i].usedClean = wr.length;
}

// salva JSON completo p/ aplicar
const outArr = rows.map(r => ({ uuid: r.uuid, name: r.name, display: r.display, mesh_rotation_x: +r.est_x.toFixed(2), mesh_rotation_z: +r.est_z.toFixed(2) }));
writeFileSync(OUT, JSON.stringify(outArr, null, 0));

// stats
const st = (arr) => { const s = [...arr].sort((a, b) => a - b); return `p50=${s[s.length >> 1].toFixed(1)} min=${s[0].toFixed(1)} max=${s[s.length - 1].toFixed(1)}`; };
console.log('frames:', rows.length, '| limpos(|a|~1):', rows.filter(r => r.clean).length);
console.log('est mesh_rotation_z (roll) :', st(rows.map(r => r.est_z)));
console.log('est mesh_rotation_x (pitch):', st(rows.map(r => r.est_x)));
console.log('salvo:', OUT);

// fotos-teste
const nearLevel = rows.filter(r => r.display).slice().sort((a, b) => (Math.abs(a.est_z) + Math.abs(a.est_x)) - (Math.abs(b.est_z) + Math.abs(b.est_x)))[0];
const bigRoll = rows.filter(r => r.display).slice().sort((a, b) => Math.abs(b.est_z) - Math.abs(a.est_z))[0];
const bigPitch = rows.filter(r => r.display).slice().sort((a, b) => Math.abs(b.est_x) - Math.abs(a.est_x))[0];
console.log('\n=== FOTOS-TESTE (abra no calibration, aplique os valores, veja se o horizonte fica reto) ===');
for (const [tag, r] of [['ROLL grande', bigRoll], ['PITCH grande', bigPitch], ['quase nível', nearLevel]])
  console.log(`  [${tag}] ${r.display}  ->  mesh_rotation_z (roll) = ${r.est_z.toFixed(1)} , mesh_rotation_x (pitch) = ${r.est_x.toFixed(1)}   (a=${r.ax.toFixed(2)},${r.ay.toFixed(2)},${r.az.toFixed(2)}, |a|=${r.mag.toFixed(2)})`);
