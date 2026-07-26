#!/usr/bin/env node

/**
 * @module scripts/import-geojson-photos
 * @description Importa fotos que existem no `fotos.geojson` do levantamento e
 * na pasta de imagens, mas nao tem arquivo de metadado — e por isso o
 * `migrate.js`, que percorre a pasta de METADADOS, nunca as viu.
 *
 * Na AMAN sao 578 de 12.334. Elas tem imagem e posicao; o que falta e o resto
 * do que uma foto precisa para ser navegavel:
 *
 * - **heading**: herdado do vizinho na trilha de captura (`project_tracks`).
 *   Fotos consecutivas ficam a ~15 m e a camera gira devagar, entao o erro
 *   medido contra as 11.753 fotos que TEM heading e de 2,1 graus na mediana,
 *   com 97,3% abaixo de 30 graus. A alternativa obvia — usar o rumo para a
 *   proxima foto da trilha — erra 180 graus em 125 dos 445 segmentos, porque a
 *   LineString nem sempre e desenhada no sentido do percurso.
 * - **conexoes**: alvos espaciais para os vizinhos, nos dois sentidos. Sem eles
 *   a foto aparece no mapa e no grafo nao leva a lugar nenhum.
 * - **mesh_rotation_y/x/z**: o default do projeto. Elas entram por calibrar,
 *   como as outras.
 *
 * O numero de sequencia continua do fim: renumerar para intercalar mudaria o
 * display_name das fotos ja existentes (ele deriva da sequencia) e quebraria
 * qualquer link salvo.
 *
 * Uso:
 *   node scripts/import-geojson-photos.js --slug aman \
 *     --geojson "D:/.../fotos.geojson" --images "D:/.../Imagens" [--dry-run]
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';

const args = process.argv.slice(2);
const getArg = (nome, padrao) => {
  const i = args.indexOf(`--${nome}`);
  return i === -1 || i + 1 >= args.length ? padrao : args[i + 1];
};
const dataDir = resolve(getArg('data', './data'));
const slug = getArg('slug');
const geojsonPath = getArg('geojson');
const imagesDir = getArg('images');
const dryRun = args.includes('--dry-run');
const workers = parseInt(getArg('workers', '2'), 10);

if (!slug || !geojsonPath || !imagesDir) {
  console.error('Uso: node scripts/import-geojson-photos.js --slug <slug> --geojson <fotos.geojson> --images <dir> [--dry-run]');
  process.exit(1);
}

// ============================================================
// Geo
// ============================================================

const RAD = Math.PI / 180;
const EARTH = 6371000;
const metros = (aLat, aLon, bLat, bLon) => Math.hypot(
  (bLat - aLat) * RAD,
  (bLon - aLon) * RAD * Math.cos(((aLat + bLat) / 2) * RAD),
) * EARTH;

function rumo(aLat, aLon, bLat, bLon) {
  const dLon = (bLon - aLon) * RAD;
  const y = Math.sin(dLon) * Math.cos(bLat * RAD);
  const x = Math.cos(aLat * RAD) * Math.sin(bLat * RAD)
          - Math.sin(aLat * RAD) * Math.cos(bLat * RAD) * Math.cos(dLon);
  return ((Math.atan2(y, x) / RAD) + 360) % 360;
}

/** Grade para busca do vizinho mais proximo. */
function grade(itens, celulaM = 40) {
  const mLat = 111320;
  const mLon = 111320 * Math.cos((itens[0]?.lat ?? 0) * RAD);
  const g = new Map();
  for (const it of itens) {
    const k = `${Math.floor(it.lon * mLon / celulaM)}:${Math.floor(it.lat * mLat / celulaM)}`;
    if (!g.has(k)) g.set(k, []);
    g.get(k).push(it);
  }
  return {
    aoRedor(lat, lon, raioCelulas = 1) {
      const ci = Math.floor(lon * mLon / celulaM);
      const cj = Math.floor(lat * mLat / celulaM);
      const saida = [];
      for (let di = -raioCelulas; di <= raioCelulas; di++) {
        for (let dj = -raioCelulas; dj <= raioCelulas; dj++) {
          const b = g.get(`${ci + di}:${cj + dj}`);
          if (b) saida.push(...b);
        }
      }
      return saida;
    },
  };
}

// ============================================================
// Carrega
// ============================================================

const db = new Database(join(dataDir, 'index.db'));
db.pragma('journal_mode = WAL');

const projeto = db.prepare('SELECT id, slug, name, db_filename FROM projects WHERE slug = ?').get(slug);
if (!projeto) {
  console.error(`Projeto ${slug} nao existe no index.db`);
  process.exit(1);
}

const existentes = db.prepare(`
  SELECT id, original_name, lat, lon, heading
  FROM photos WHERE project_id = ?
`).all(projeto.id);
const jaTem = new Set(existentes.map(p => p.original_name));
console.log(`${slug}: ${existentes.length} fotos no banco`);

const gj = JSON.parse(readFileSync(geojsonPath, 'utf-8'));
const noGeojson = gj.features
  .filter(f => f.properties?.nome_img)
  .map(f => ({
    nome: f.properties.nome_img,
    lat: f.properties.lat_img ?? f.geometry?.coordinates?.[1],
    lon: f.properties.long_img ?? f.geometry?.coordinates?.[0],
    ele: f.properties.ele_img ?? null,
    faixa: f.properties.faixa_img ?? 0,
    num: f.properties.numero_img ?? 0,
    tempo: f.properties.time_img ?? null,
  }))
  .filter(p => p.lat != null && p.lon != null);

const faltantes = noGeojson
  .filter(p => !jaTem.has(p.nome))
  .filter(p => existsSync(join(imagesDir, `${p.nome}.jpg`)))
  .sort((a, b) => (a.faixa - b.faixa) || (a.num - b.num));

console.log(`geojson: ${noGeojson.length} pontos | ausentes do banco e com JPG: ${faltantes.length}`);
if (!faltantes.length) {
  console.log('nada a importar.');
  db.close();
  process.exit(0);
}

// ============================================================
// Heading pela trilha
// ============================================================

const trilhas = db.prepare(`
  SELECT coords FROM project_tracks WHERE project_id = ? ORDER BY id
`).all(projeto.id).map(r => JSON.parse(r.coords));

if (!trilhas.length) {
  console.error('project_tracks vazia para este projeto — rode antes: npm run import-tracks');
  process.exit(1);
}

// Vertice da trilha -> nome da foto naquela posicao.
const todasFotos = [
  ...existentes.map(p => ({ nome: p.original_name, lat: p.lat, lon: p.lon, heading: p.heading })),
  ...faltantes.map(p => ({ nome: p.nome, lat: p.lat, lon: p.lon, heading: null })),
];
const gradeFotos = grade(todasFotos);
const porNome = new Map(todasFotos.map(p => [p.nome, p]));

const naPosicao = (lon, lat) => {
  let melhor = null;
  let menor = Infinity;
  for (const p of gradeFotos.aoRedor(lat, lon)) {
    const d = metros(lat, lon, p.lat, p.lon);
    if (d < menor) { menor = d; melhor = p; }
  }
  return menor < 0.5 ? melhor.nome : null;
};

// O heading e o rumo para a proxima foto NO SENTIDO DO PERCURSO, e o sentido
// vem do `time_img`: a LineString nem sempre e desenhada na direcao em que se
// andou (na AMAN, 209 dos 445 segmentos estao ao contrario), e sem essa
// correcao o rumo sai 180 graus errado nesses trechos.
//
// Medido contra as 11.753 fotos que TEM heading: erro mediano de 1,3 grau, 92%
// abaixo de 10 graus, p99 em 88 — ou seja, nenhum caso invertido.
const tempoPorNome = new Map(noGeojson.map(p => [p.nome, p.tempo]));
const headingCalculado = new Map();

for (const linha of trilhas) {
  const seq = linha.map(([lo, la]) => naPosicao(lo, la)).filter(Boolean);
  if (seq.length < 2) continue;

  // Sentido do percurso: conta quantos passos avancam no tempo e quantos voltam.
  let avanca = 0;
  let recua = 0;
  for (let i = 1; i < seq.length; i++) {
    const t0 = tempoPorNome.get(seq[i - 1]);
    const t1 = tempoPorNome.get(seq[i]);
    if (t0 == null || t1 == null) continue;
    if (t1 > t0) avanca++;
    else if (t1 < t0) recua++;
  }
  const ordenada = recua > avanca ? [...seq].reverse() : seq;

  for (let i = 0; i < ordenada.length; i++) {
    const atual = porNome.get(ordenada[i]);
    if (!atual) continue;
    // Ultima foto do trecho: nao ha proxima, entao reaproveita o rumo de quem
    // veio antes — a camera nao gira entre um disparo e outro.
    const a = i < ordenada.length - 1 ? atual : porNome.get(ordenada[i - 1]);
    const b = i < ordenada.length - 1 ? porNome.get(ordenada[i + 1]) : atual;
    if (!a || !b || a === b) continue;
    if (!headingCalculado.has(ordenada[i])) {
      headingCalculado.set(ordenada[i], rumo(a.lat, a.lon, b.lat, b.lon));
    }
  }
}

let semHeading = 0;
for (const p of faltantes) {
  p.heading = headingCalculado.get(p.nome) ?? null;
  if (p.heading == null) semHeading++;
}
console.log(`heading derivado da trilha (sentido pelo time_img): ${faltantes.length - semHeading}/${faltantes.length}`);
if (semHeading) console.log(`  ${semHeading} ficam com heading nulo (foto isolada na trilha)`);

// ============================================================
// Alvos espaciais — mesma politica da Fase 5 do migrate
// ============================================================

const nnTodas = [];
for (const p of todasFotos) {
  let menor = Infinity;
  for (const q of gradeFotos.aoRedor(p.lat, p.lon)) {
    if (q === p) continue;
    const d = metros(p.lat, p.lon, q.lat, q.lon);
    if (d < menor) menor = d;
  }
  if (Number.isFinite(menor)) nnTodas.push(menor);
}
nnTodas.sort((a, b) => a - b);
const medianaNN = nnTodas[Math.floor(nnTodas.length / 2)];
const RAIO = medianaNN * 5;
const SETORES = 4;
const POR_SETOR = 3;
const MAX_ALVOS = 6;
console.log(`\nmediana NN ${medianaNN.toFixed(1)} m -> raio de conexao ${RAIO.toFixed(0)} m`);

const idPorNome = new Map(existentes.map(p => [p.original_name, p.id]));
const novosIds = new Map(faltantes.map(p => [p.nome, randomUUID()]));
for (const [n, id] of novosIds) idPorNome.set(n, id);

const arestas = []; // {origem, destino, dist, bearing}
for (const p of faltantes) {
  const candidatos = [];
  for (const q of gradeFotos.aoRedor(p.lat, p.lon, 2)) {
    if (q.nome === p.nome) continue;
    const d = metros(p.lat, p.lon, q.lat, q.lon);
    if (d > RAIO) continue;
    const b = rumo(p.lat, p.lon, q.lat, q.lon);
    candidatos.push({ nome: q.nome, d, b, setor: Math.floor(b / (360 / SETORES)) % SETORES });
  }
  candidatos.sort((a, b) => a.d - b.d);
  const porSetor = new Array(SETORES).fill(0);
  const escolhidos = [];
  for (const c of candidatos) {
    if (escolhidos.length >= MAX_ALVOS) break;
    if (porSetor[c.setor] >= POR_SETOR) continue;
    porSetor[c.setor]++;
    escolhidos.push(c);
  }
  for (const c of escolhidos) {
    arestas.push({ origem: p.nome, destino: c.nome, dist: c.d, bearing: c.b });
    // Ida e volta: sem a volta a foto nova so seria alcancavel, nunca um ponto
    // de partida de onde se ve as vizinhas.
    arestas.push({ origem: c.nome, destino: p.nome, dist: c.d, bearing: (c.b + 180) % 360 });
  }
}
const semAlvo = faltantes.filter(p => !arestas.some(a => a.origem === p.nome)).length;
console.log(`arestas a criar: ${arestas.length} (${semAlvo} fotos ficariam sem nenhuma)`);

// ============================================================
// Grava
// ============================================================

const proximaSeq = db.prepare('SELECT COALESCE(MAX(sequence_number), 0) AS m FROM photos WHERE project_id = ?').get(projeto.id).m;
const safeName = projeto.name.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_-]/g, '').replace(/_+/g, '_').slice(0, 50);
console.log(`\nsequencia continua de ${proximaSeq + 1} ate ${proximaSeq + faltantes.length}`);
console.log(`display_name: ${safeName}_${String(proximaSeq + 1).padStart(4, '0')} ...`);

if (dryRun) {
  console.log('\n--dry-run: nada gravado.');
  db.close();
  process.exit(0);
}

const insPhoto = db.prepare(`
  INSERT INTO photos (id, project_id, original_name, display_name, sequence_number,
                      lat, lon, ele, heading, camera_height, mesh_rotation_y,
                      mesh_rotation_x, mesh_rotation_z, distance_scale, floor_level,
                      full_size_bytes, preview_size_bytes)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 180, 0, 0, 1.0, 1, NULL, NULL)
`);
const insRowid = db.prepare('INSERT INTO photos_rowid (photo_id) VALUES (?)');
const insRtree = db.prepare('INSERT INTO photos_rtree (rowid_id, min_lon, max_lon, min_lat, max_lat) VALUES (?, ?, ?, ?, ?)');
const insTarget = db.prepare(`
  INSERT OR IGNORE INTO targets (source_id, target_id, distance_m, bearing_deg, is_next, is_original)
  VALUES (?, ?, ?, ?, 0, 0)
`);
const updCount = db.prepare('UPDATE projects SET photo_count = (SELECT COUNT(*) FROM photos WHERE project_id = ?) WHERE id = ?');

db.transaction(() => {
  faltantes.forEach((p, i) => {
    const uuid = novosIds.get(p.nome);
    const seq = proximaSeq + i + 1;
    insPhoto.run(uuid, projeto.id, p.nome, `${safeName}_${String(seq).padStart(4, '0')}`,
      seq, p.lat, p.lon, p.ele, p.heading);
    const r = insRowid.run(uuid);
    insRtree.run(r.lastInsertRowid, p.lon, p.lon, p.lat, p.lat);
  });
  for (const a of arestas) {
    const s = idPorNome.get(a.origem);
    const t = idPorNome.get(a.destino);
    if (s && t) insTarget.run(s, t, a.dist, a.bearing);
  }
  updCount.run(projeto.id, projeto.id);
})();
console.log(`\n${faltantes.length} fotos inseridas no index.db`);

// ---- Imagens ----
//
// Esta etapa e RE-EXECUTAVEL e nao depende do que foi inserido nesta rodada:
// ela procura toda foto do projeto sem BLOB. Antes ela convertia apenas as
// recem-inseridas, e isso tinha um buraco serio — se o HD caisse no meio, as
// linhas ja estavam no banco, entao a proxima execucao as considerava
// importadas e pulava; as imagens nunca entrariam.
const sharp = (await import('sharp')).default;
const projDb = new Database(join(dataDir, 'projects', projeto.db_filename));
projDb.pragma('journal_mode = WAL');
const insImg = projDb.prepare('INSERT OR REPLACE INTO images (photo_id, full_webp, preview_webp) VALUES (?, ?, ?)');
const updSizes = db.prepare('UPDATE photos SET full_size_bytes = ?, preview_size_bytes = ? WHERE id = ?');

const comBlob = new Set(projDb.prepare('SELECT photo_id FROM images').all().map(r => r.photo_id));
const pendentes = db.prepare('SELECT id, original_name FROM photos WHERE project_id = ?')
  .all(projeto.id)
  .filter(r => !comBlob.has(r.id))
  .map(r => ({ id: r.id, nome: r.original_name }));
console.log(`\nfotos sem imagem no ${projeto.db_filename}: ${pendentes.length}`);

const espera = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Espera o HD externo voltar. Um drive que desconecta nao volta em milissegundos
 * e nem sempre volta sozinho: em vez de queimar as tentativas num backoff curto,
 * fica sondando o diretorio e avisa, para dar tempo de reconectar o cabo.
 */
async function esperarDrive(limiteMs = 30 * 60 * 1000) {
  if (existsSync(imagesDir)) return true;
  const inicio = Date.now();
  let avisou = false;
  while (Date.now() - inicio < limiteMs) {
    if (existsSync(imagesDir)) {
      console.log(`\n  drive de volta apos ${((Date.now() - inicio) / 1000).toFixed(0)}s, retomando`);
      return true;
    }
    if (!avisou) {
      console.log(`\n  AGUARDANDO: ${imagesDir} sumiu — reconecte o HD (desisto em ${limiteMs / 60000} min)`);
      avisou = true;
    }
    await espera(5000);
  }
  return false;
}

const TENTATIVAS = 8;
async function converter(p) {
  const caminho = join(imagesDir, `${p.nome}.jpg`);
  for (let t = 1; t <= TENTATIVAS; t++) {
    try {
      const base = sharp(readFileSync(caminho));
      const [full, prev] = await Promise.all([
        base.clone().webp({ quality: 80 }).toBuffer(),
        base.clone().resize(512, 256, { fit: 'fill' }).webp({ quality: 70 }).toBuffer(),
      ]);
      return { p, full, prev, tentativas: t };
    } catch (e) {
      if (t === TENTATIVAS) return { p, erro: e.message };
      // Some o diretorio inteiro = drive desconectado, nao arquivo ruim: espera
      // ele voltar em vez de consumir as tentativas contra um caminho morto.
      if (!existsSync(imagesDir) && !(await esperarDrive())) {
        return { p, erro: 'drive nao voltou' };
      }
      // Backoff ate ~30s: o drive tambem engasga sob leitura paralela sustentada
      // sem chegar a desconectar, e ai so o tempo resolve.
      await espera(Math.min(30000, 300 * 2 ** t));
    }
  }
}

console.log('convertendo imagens...');
let feitas = 0;
let retentadas = 0;
const falhas = [];
for (let i = 0; i < pendentes.length; i += 40) {
  const bloco = pendentes.slice(i, i + 40);
  const res = [];
  for (let j = 0; j < bloco.length; j += workers) {
    res.push(...await Promise.all(bloco.slice(j, j + workers).map(converter)));
  }
  const bons = res.filter(r => !r.erro);
  projDb.transaction(() => { for (const r of bons) insImg.run(r.p.id, r.full, r.prev); })();
  db.transaction(() => { for (const r of bons) updSizes.run(r.full.length, r.prev.length, r.p.id); })();
  feitas += bons.length;
  retentadas += bons.filter(r => r.tentativas > 1).length;
  for (const r of res) if (r.erro) falhas.push(`${r.p.nome}: ${r.erro}`);
  process.stderr.write(`  ${feitas}/${pendentes.length} (${falhas.length} falhas, ${retentadas} com retry)\r`);
}
console.log(`\nimagens gravadas: ${feitas} | falhas: ${falhas.length} | precisaram de retry: ${retentadas}`);
if (falhas.length) {
  console.log(falhas.slice(0, 10).join('\n'));
  console.log('\nRode o script de novo: ele reconverte so o que ficou sem imagem.');
}

db.pragma('wal_checkpoint(TRUNCATE)');
projDb.pragma('wal_checkpoint(TRUNCATE)');
projDb.close();
db.close();
console.log('pronto. Regere os PMTiles: npm run generate-pmtiles');
