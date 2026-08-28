#!/usr/bin/env node

/**
 * @module scripts/import-tracks
 * @description Popula `project_tracks` no index.db com o tracado de captura de
 * cada projeto — a mesma linha que vai para o fotos_linha.pmtiles.
 *
 * Duas fontes, nesta ordem de preferencia:
 *
 *   1. `{DATA}/_source_backup/{slug}_fotos_linha.geojson` — o arquivo original
 *      do levantamento. Geometria exata, sem recorte.
 *   2. `{DATA}/fotos_linha.pmtiles` — para os projetos que nao tem o geojson
 *      original neste computador. Decodificar tiles devolve a geometria
 *      recortada e duplicada nas bordas, entao so serve como ultimo recurso.
 *
 * No PMTiles as feicoes novas trazem `origem` = slug do projeto, mas as antigas
 * vem todas como `origem = 'legado'`, sem dizer de qual projeto sao. Essas sao
 * atribuidas por proximidade: cada vertice vota no projeto cuja foto esta mais
 * perto, e a linha vai para o mais votado. Os projetos ficam em cidades
 * diferentes, entao a votacao e folgada — na base atual o pior vertice fica a
 * 28 m de uma foto do projeto escolhido, com mediana de 3,5 m.
 *
 * Uso:
 *   node scripts/import-tracks.js [--data ./data] [--slug <a,b>] [--dry-run] [--docker]
 *
 * SEM `--slug` ele mexe em TODOS os projetos, e o que nao tem geojson em
 * `_source_backup` tem o tracado reescrito pela geometria recortada dos tiles.
 * Ao importar um lote novo, recorte pelos slugs daquele lote.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execSync, execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';

const args = process.argv.slice(2);
const getArg = (nome, padrao) => {
  const i = args.indexOf(`--${nome}`);
  return i === -1 || i + 1 >= args.length ? padrao : args[i + 1];
};
const dataDir = resolve(getArg('data', './data'));
const dryRun = args.includes('--dry-run');
const forceDocker = args.includes('--docker');

const indexDbPath = join(dataDir, 'index.db');
if (!existsSync(indexDbPath)) {
  console.error(`Error: index.db nao encontrado em ${indexDbPath}`);
  process.exit(1);
}

// ============================================================
// Geo
// ============================================================

const RAD = Math.PI / 180;
const EARTH = 6371000;

function metros(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * RAD;
  const dLon = (lon2 - lon1) * RAD * Math.cos(((lat1 + lat2) / 2) * RAD);
  return Math.hypot(dLat, dLon) * EARTH;
}

/**
 * Indice de grade das fotos, para achar o projeto mais proximo de um vertice
 * sem varrer as ~98 mil fotos a cada consulta.
 */
function criarIndice(fotos) {
  const CELULA = 0.02; // ~2 km
  const grade = new Map();
  for (const f of fotos) {
    const k = `${Math.floor(f.lon / CELULA)}:${Math.floor(f.lat / CELULA)}`;
    if (!grade.has(k)) grade.set(k, []);
    grade.get(k).push(f);
  }
  return (lon, lat) => {
    // Anel crescente: para quando encontra algo, para nao varrer o mapa inteiro
    // por causa de um vertice solto.
    for (let r = 1; r <= 6; r++) {
      let melhor = null;
      let menor = Infinity;
      const ci = Math.floor(lon / CELULA);
      const cj = Math.floor(lat / CELULA);
      for (let di = -r; di <= r; di++) {
        for (let dj = -r; dj <= r; dj++) {
          const balde = grade.get(`${ci + di}:${cj + dj}`);
          if (!balde) continue;
          for (const f of balde) {
            const d = metros(lat, lon, f.lat, f.lon);
            if (d < menor) { menor = d; melhor = f.slug; }
          }
        }
      }
      if (melhor) return { slug: melhor, dist: menor };
    }
    return { slug: null, dist: Infinity };
  };
}

// ============================================================
// tippecanoe-decode (local ou Docker)
// ============================================================

function decodificarPmtiles(caminho) {
  let viaDocker = forceDocker;
  if (!viaDocker) {
    try {
      execSync('tippecanoe-decode --version', { stdio: 'pipe' });
    } catch {
      viaDocker = true;
    }
  }

  const maxzoom = lerMaxzoom(caminho);
  const argumentos = ['-Z', String(maxzoom), '-z', String(maxzoom), '-l', 'fotos_linha'];

  if (!viaDocker) {
    return JSON.parse(execFileSync('tippecanoe-decode', [...argumentos, caminho], {
      encoding: 'utf-8', maxBuffer: 1024 * 1024 * 512,
    }));
  }
  try {
    execSync('docker image inspect tippecanoe:latest', { stdio: 'pipe' });
  } catch {
    console.error('Error: nem tippecanoe-decode local nem a imagem Docker "tippecanoe:latest".');
    console.error('Sem eles nao da para ler as linhas dos projetos antigos do PMTiles.');
    process.exit(1);
  }
  // A imagem nao define ENTRYPOINT: o binario precisa ser nomeado.
  const saida = execFileSync('docker', [
    'run', '--rm', '-v', `${dataDir}:/data`, 'tippecanoe:latest',
    'tippecanoe-decode', ...argumentos, `/data/${caminho.split(/[\\/]/).pop()}`,
  ], { encoding: 'utf-8', maxBuffer: 1024 * 1024 * 512 });
  return JSON.parse(saida);
}

/**
 * Le o maxzoom do cabecalho PMTiles v3 (byte 101). Decodificar num zoom que o
 * arquivo nao tem devolve so o cabecalho, sem nenhuma feicao — e o erro passa
 * despercebido porque o comando termina com sucesso.
 */
function lerMaxzoom(caminho) {
  const b = readFileSync(caminho);
  if (b.subarray(0, 7).toString() !== 'PMTiles') {
    throw new Error(`${caminho} nao parece um PMTiles`);
  }
  return b[101];
}

/** Achata as FeatureCollections aninhadas por tile que o decode devolve. */
function achatar(no, saida = []) {
  if (!no || typeof no !== 'object') return saida;
  if (no.type === 'Feature' && no.geometry) { saida.push(no); return saida; }
  if (Array.isArray(no.features)) { for (const f of no.features) achatar(f, saida); return saida; }
  if (Array.isArray(no)) for (const f of no) achatar(f, saida);
  return saida;
}

const chaveGeom = (geom) => {
  const partes = geom.type === 'LineString' ? [geom.coordinates] : geom.coordinates;
  return partes.map(p => p.map(([x, y]) => `${x.toFixed(6)},${y.toFixed(6)}`).join(';')).join('|');
};

// ============================================================
// Main
// ============================================================

const db = new Database(indexDbPath);
db.pragma('journal_mode = WAL');

// Garante a tabela em bancos criados antes dela.
db.exec(readFileSync(resolve(new URL('../src/db/schema.sql', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'utf-8'));

// RECORTE POR PROJETO, e ele nao e conforto.
//
// Sem `--slug`, todo projeto que nao tem geojson em `_source_backup` cai na
// Fonte 2 e tem o tracado REESCRITO a partir da geometria recortada dos tiles,
// que perde vertice. Numa maquina onde o `_source_backup` esta incompleto (a
// do chefe tinha 1 arquivo para 30 projetos), importar UM projeto novo
// estragaria os outros 29 de tabela, sem dizer nada.
//
// O lote do serra_dourada contornou isso inserindo as linhas a mao. O recorte
// resolve de vez: fora da lista, o projeto nao e lido nem apagado.
const somenteSlugs = (getArg('slug', '') || '').split(',').map(s => s.trim()).filter(Boolean);
const todos = db.prepare('SELECT id, slug FROM projects ORDER BY slug').all();
const desconhecidos = somenteSlugs.filter(s => !todos.some(p => p.slug === s));
if (desconhecidos.length) {
  console.error(`slug inexistente no banco: ${desconhecidos.join(', ')}`);
  process.exit(1);
}
const projetos = somenteSlugs.length ? todos.filter(p => somenteSlugs.includes(p.slug)) : todos;
const idPorSlug = new Map(projetos.map(p => [p.slug, p.id]));
console.log(`${todos.length} projetos no index.db`);
if (somenteSlugs.length) console.log(`  recorte por --slug: ${projetos.map(p => p.slug).join(', ')}`);

const linhasPorSlug = new Map(); // slug -> [{coords, source}]
const registrar = (slug, coords, source) => {
  if (!idPorSlug.has(slug)) return;
  if (coords.length < 2) return;
  if (!linhasPorSlug.has(slug)) linhasPorSlug.set(slug, []);
  linhasPorSlug.get(slug).push({ coords, source });
};

// ---- Fonte 1: geojson original ----
const backupDir = join(dataDir, '_source_backup');
const comGeojson = new Set();
if (existsSync(backupDir)) {
  for (const arquivo of readdirSync(backupDir)) {
    const m = arquivo.match(/^(.+)_fotos_linha\.geojson$/);
    if (!m || !idPorSlug.has(m[1])) continue;
    const gj = JSON.parse(readFileSync(join(backupDir, arquivo), 'utf-8'));
    let n = 0;
    for (const f of gj.features || []) {
      if (f.geometry?.type !== 'LineString') continue;
      registrar(m[1], f.geometry.coordinates, 'geojson');
      n++;
    }
    if (n) comGeojson.add(m[1]);
    console.log(`  [geojson] ${m[1]}: ${n} linhas`);
  }
}

// ---- Fonte 2: PMTiles, para o que sobrou ----
const pmtilesPath = join(dataDir, 'fotos_linha.pmtiles');
const faltando = projetos.filter(p => !comGeojson.has(p.slug));
if (faltando.length && existsSync(pmtilesPath)) {
  console.log(`\n${faltando.length} projetos sem geojson — lendo do PMTiles (maxzoom ${lerMaxzoom(pmtilesPath)})`);
  const feats = achatar(decodificarPmtiles(pmtilesPath));

  // O decode duplica feicoes na borda dos tiles.
  const vistas = new Set();
  const unicas = [];
  for (const f of feats) {
    if (f.geometry?.type !== 'LineString') continue;
    const k = `${JSON.stringify(f.properties)}#${chaveGeom(f.geometry)}`;
    if (vistas.has(k)) continue;
    vistas.add(k);
    unicas.push(f);
  }
  console.log(`  ${feats.length} feicoes no decode, ${unicas.length} unicas`);

  const fotos = db.prepare(`
    SELECT pr.slug, ph.lat, ph.lon
    FROM photos ph JOIN projects pr ON pr.id = ph.project_id
    WHERE ph.id NOT IN (SELECT photo_id FROM deleted_photos)
  `).all();
  const maisProximo = criarIndice(fotos);

  const semDono = [];
  const piores = [];
  const contagem = new Map();
  for (const f of unicas) {
    const origem = f.properties?.origem;
    // Origem que casa com um slug ja diz o dono; so o "legado" precisa de voto.
    let slug = idPorSlug.has(origem) ? origem : null;
    let pior = 0;
    if (!slug) {
      const votos = new Map();
      for (const [lon, lat] of f.geometry.coordinates) {
        const r = maisProximo(lon, lat);
        if (!r.slug) continue;
        votos.set(r.slug, (votos.get(r.slug) || 0) + 1);
        pior = Math.max(pior, r.dist);
      }
      const ordenado = [...votos].sort((a, b) => b[1] - a[1]);
      slug = ordenado[0]?.[0] ?? null;
    }
    if (!slug) { semDono.push(f); continue; }
    // Projeto que ja veio do geojson nao recebe a versao recortada do PMTiles.
    if (comGeojson.has(slug)) continue;
    registrar(slug, f.geometry.coordinates, idPorSlug.has(origem) ? 'pmtiles' : 'pmtiles-atribuido');
    contagem.set(slug, (contagem.get(slug) || 0) + 1);
    if (pior) piores.push(pior);
  }

  piores.sort((a, b) => a - b);
  for (const [slug, n] of [...contagem].sort()) console.log(`  [pmtiles] ${slug}: ${n} linhas`);
  if (piores.length) {
    console.log(`  atribuicao por proximidade — pior vertice: mediana ${piores[Math.floor(piores.length / 2)].toFixed(1)} m, max ${piores[piores.length - 1].toFixed(0)} m`);
  }
  if (semDono.length) console.log(`  AVISO: ${semDono.length} linhas sem projeto identificavel (descartadas)`);
}

// ---- Grava ----
const total = [...linhasPorSlug.values()].reduce((s, a) => s + a.length, 0);
const semLinha = projetos.filter(p => !linhasPorSlug.has(p.slug)).map(p => p.slug);
console.log(`\ntotal: ${total} linhas em ${linhasPorSlug.size} projetos`);
if (semLinha.length) console.log(`sem tracado: ${semLinha.join(', ')}`);

if (dryRun) {
  console.log('\n--dry-run: nada gravado.');
  db.close();
  process.exit(0);
}

const apagar = db.prepare('DELETE FROM project_tracks WHERE project_id = ?');
const inserir = db.prepare('INSERT INTO project_tracks (project_id, coords, source) VALUES (?, ?, ?)');
db.transaction(() => {
  for (const [slug, linhas] of linhasPorSlug) {
    const pid = idPorSlug.get(slug);
    apagar.run(pid);
    for (const l of linhas) inserir.run(pid, JSON.stringify(l.coords), l.source);
  }
})();

console.log(`gravado em ${indexDbPath}`);
db.pragma('wal_checkpoint(TRUNCATE)');
db.close();
