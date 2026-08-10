#!/usr/bin/env node

/**
 * @module scripts/import-floor-plans
 * @description Popula `project_floors.plan_coords` com a planta baixa de cada
 * andar de um projeto, a partir de um geojson de linhas.
 *
 * A fonte e o `planta.geojson` do levantamento: uma FeatureCollection de
 * LineString, cada feicao com a propriedade `andar` no MESMO vocabulario do
 * `locate` das fotos (`andar 1`, `área externa`, ...). O script agrupa as
 * feicoes por andar, traduz o rotulo em nivel por `lib/floors.js` e grava uma
 * lista de linhas em JSON, no molde de `project_tracks.coords`.
 *
 * O script e RE-EXECUTAVEL e nao destroi o que nao veio no arquivo: ele so toca
 * os niveis presentes no geojson. Um andar sem planta desenhada continua com
 * `plan_coords` nulo, que e o estado correto do nivel 0 (externo).
 *
 * VERIFICACAO EMBUTIDA: depois de gravar, o script mede a distancia de cada
 * foto ate a linha mais proxima da planta DO SEU PROPRIO ANDAR e reprova a
 * importacao se a planta estiver deslocada ou trocada de andar. Uma planta no
 * andar errado passa em qualquer conferencia de contagem — o total de linhas
 * fecha, o mapa desenha — e so aparece como parede no lugar errado.
 *
 * Uso:
 *   node scripts/import-floor-plans.js --slug beira_rio --planta <planta.geojson>
 *                                      [--data ./data] [--dry-run]
 *                                      [--tolerancia 15]
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { parseFloor, defaultFloorLabel } from './lib/floors.js';

const args = process.argv.slice(2);
const getArg = (nome, padrao) => {
  const i = args.indexOf(`--${nome}`);
  return i === -1 || i + 1 >= args.length ? padrao : args[i + 1];
};

const slug = getArg('slug', null);
const plantaPath = getArg('planta', null);
const dataDir = resolve(getArg('data', './data'));
const dryRun = args.includes('--dry-run');
// Teto de distancia entre foto e planta do seu andar. 15 m e folgado para um
// predio: no Beira-Rio a pior foto fica a 7,3 m e a mediana por andar vai de
// 0,6 a 2,2 m. O teto pega planta trocada de andar, nao imprecisao de GPS.
const tolerancia = Number.parseFloat(getArg('tolerancia', '15'));

if (!slug || !plantaPath) {
  console.error('Uso: node scripts/import-floor-plans.js --slug <slug> --planta <planta.geojson>');
  process.exit(1);
}

const indexDbPath = join(dataDir, 'index.db');
if (!existsSync(indexDbPath)) {
  console.error(`Erro: index.db nao encontrado em ${indexDbPath}`);
  process.exit(1);
}
if (!existsSync(plantaPath)) {
  console.error(`Erro: planta nao encontrada em ${plantaPath}`);
  process.exit(1);
}

// ============================================================
// Geometria
// ============================================================

const RAD = Math.PI / 180;
const EARTH = 6371000;

/** Distancia em metros de um ponto ao segmento AB, em plano local. */
function distanciaAoSegmento(lon, lat, a, b) {
  const k = Math.cos(lat * RAD);
  const px = lon * k, py = lat;
  const ax = a[0] * k, ay = a[1];
  const bx = b[0] * k, by = b[1];
  const dx = bx - ax, dy = by - ay;
  const den = dx * dx + dy * dy;
  const t = den === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / den));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy)) * RAD * EARTH;
}

/** Menor distancia em metros de um ponto a um conjunto de linhas. */
function distanciaAsLinhas(lon, lat, linhas) {
  let menor = Infinity;
  for (const linha of linhas) {
    for (let i = 0; i < linha.length - 1; i++) {
      const d = distanciaAoSegmento(lon, lat, linha[i], linha[i + 1]);
      if (d < menor) menor = d;
    }
  }
  return menor;
}

function percentil(v, p) {
  if (v.length === 0) return NaN;
  const s = [...v].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}

// ============================================================
// Leitura
// ============================================================

const fc = JSON.parse(readFileSync(plantaPath, 'utf-8'));
if (fc.type !== 'FeatureCollection' || !Array.isArray(fc.features)) {
  console.error('Erro: a planta nao e uma FeatureCollection');
  process.exit(1);
}

// nivel -> { label, linhas: [[[lon,lat],...], ...] }
const porNivel = new Map();
let ignoradas = 0;

for (const f of fc.features) {
  const g = f.geometry;
  if (!g) { ignoradas++; continue; }

  // MultiLineString entra como varias linhas; qualquer outra geometria fica de
  // fora e e CONTADA, para o total nunca fechar por acidente.
  let partes;
  if (g.type === 'LineString') {
    partes = [g.coordinates];
  } else if (g.type === 'MultiLineString') {
    partes = g.coordinates;
  } else {
    ignoradas++;
    continue;
  }

  const bruto = f.properties?.andar ?? f.properties?.local ?? f.properties?.locate;
  if (bruto == null) { ignoradas++; continue; }

  const { level, label } = parseFloor(bruto);
  if (!porNivel.has(level)) porNivel.set(level, { label, linhas: [] });

  for (const parte of partes) {
    // Linha de um vertice so nao desenha nada e atrapalha a medida.
    if (Array.isArray(parte) && parte.length >= 2) {
      porNivel.get(level).linhas.push(parte.map(([lon, lat]) => [lon, lat]));
    } else {
      ignoradas++;
    }
  }
}

const totalLinhas = [...porNivel.values()].reduce((s, v) => s + v.linhas.length, 0);
console.log(`Planta: ${fc.features.length} feicoes -> ${totalLinhas} linhas em ${porNivel.size} niveis`);
if (ignoradas > 0) console.warn(`  ${ignoradas} feicao(oes) fora do padrao, ignorada(s)`);

// ============================================================
// Banco
// ============================================================

const db = new Database(indexDbPath, { readonly: dryRun });
db.pragma('busy_timeout = 5000');

const projeto = db.prepare('SELECT id, name FROM projects WHERE slug = ?').get(slug);
if (!projeto) {
  console.error(`Erro: projeto "${slug}" nao existe no index.db`);
  process.exit(1);
}

const fotos = db.prepare(`
  SELECT lon, lat, floor_level FROM photos
  WHERE project_id = ? AND id NOT IN (SELECT photo_id FROM deleted_photos)
`).all(projeto.id);

if (fotos.length === 0) {
  console.error(`Erro: projeto "${slug}" nao tem foto no index.db. Rode o migrate antes.`);
  process.exit(1);
}

// ---- Verificacao, ANTES de gravar ----

let reprovado = false;
console.log('');
console.log('Conferencia planta x fotos:');

for (const [level, { label, linhas }] of [...porNivel].sort((a, b) => a[0] - b[0])) {
  const doNivel = fotos.filter(f => f.floor_level === level);
  if (doNivel.length === 0) {
    console.warn(`  nivel ${level} (${label}): ${linhas.length} linhas, NENHUMA foto neste nivel`);
    continue;
  }

  const ds = doNivel.map(f => distanciaAsLinhas(f.lon, f.lat, linhas));
  const fora = ds.filter(d => d > tolerancia).length;
  console.log(
    `  nivel ${level} (${label}): ${linhas.length} linhas, ${doNivel.length} fotos, ` +
    `p50 ${percentil(ds, 0.5).toFixed(1)} m, max ${Math.max(...ds).toFixed(1)} m` +
    (fora > 0 ? `, ${fora} FOTO(S) ACIMA DE ${tolerancia} m` : '')
  );
  if (fora > 0) reprovado = true;
}

// Foto num nivel que tem planta noutro lugar do arquivo, mas nao no seu:
// silencio seria dizer que o andar nao tem planta, quando ele tem e esta errada.
const niveisComFoto = new Set(fotos.map(f => f.floor_level));
const semPlanta = [...niveisComFoto].filter(n => !porNivel.has(n)).sort((a, b) => a - b);
if (semPlanta.length > 0) {
  console.log(`  sem planta no arquivo: nivel(is) ${semPlanta.join(', ')}`);
}

if (reprovado) {
  console.error('');
  console.error('Importacao ABORTADA: planta longe das fotos do proprio andar.');
  console.error('Confira se o atributo "andar" da planta bate com o "locate" das fotos.');
  process.exit(1);
}

// ---- Gravacao ----

if (dryRun) {
  console.log('');
  console.log('--dry-run: nada gravado.');
  process.exit(0);
}

const upsert = db.prepare(`
  INSERT INTO project_floors (project_id, level, label, plan_coords)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(project_id, level) DO UPDATE SET plan_coords = excluded.plan_coords
`);

const gravar = db.transaction(() => {
  for (const [level, { label, linhas }] of porNivel) {
    upsert.run(projeto.id, level, label ?? defaultFloorLabel(level), JSON.stringify(linhas));
  }
});
gravar();

// ---- Releitura: o retorno do INSERT e eco, nao prova ----

const conferencia = db.prepare(`
  SELECT level, label, plan_coords FROM project_floors
  WHERE project_id = ? ORDER BY level
`).all(projeto.id);

let linhasGravadas = 0;
for (const linha of conferencia) {
  const n = linha.plan_coords ? JSON.parse(linha.plan_coords).length : 0;
  linhasGravadas += n;
  console.log(`  gravado: nivel ${linha.level} (${linha.label}) ${n} linhas`);
}

console.log('');
if (linhasGravadas !== totalLinhas) {
  console.error(`ERRO: li ${totalLinhas} linhas e reli ${linhasGravadas} no banco.`);
  process.exit(1);
}
console.log(`OK: ${linhasGravadas} linhas de planta em ${conferencia.length} niveis de ${projeto.name}.`);
