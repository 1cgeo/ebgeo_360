#!/usr/bin/env node

/**
 * @module scripts/generate-pmtiles
 * @description Generates a PMTiles file from the street view index.db.
 *
 * Produces:
 *   - fotos.pmtiles — Point layer with one feature per photo
 *   - fotos_linha.pmtiles — Line layer with the capture track (from project_tracks)
 *
 * Requires tippecanoe: either installed locally or via Docker.
 * If tippecanoe is not found locally, falls back to Docker image "tippecanoe:latest".
 * Build it with: docker build -t tippecanoe:latest https://github.com/felt/tippecanoe.git
 *
 * Usage:
 *   node scripts/generate-pmtiles.js --data ./data --output ./output
 *
 * Options:
 *   --data    Path to data directory containing index.db (default: ./data)
 *   --output  Path for generated .pmtiles files (default: same as --data)
 *   --docker    Force using Docker even if tippecanoe is installed locally
 */

import { existsSync, unlinkSync, createWriteStream } from 'node:fs';
import { join, resolve } from 'node:path';
import { execSync, execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';

// ============================================================
// CLI argument parsing
// ============================================================

const args = process.argv.slice(2);

function getArg(name, defaultValue) {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= args.length) return defaultValue;
  return args[idx + 1];
}

const dataDir = resolve(getArg('data', './data'));
const outputDir = resolve(getArg('output', dataDir));
const forceDocker = args.includes('--docker');

const indexDbPath = join(dataDir, 'index.db');

if (!existsSync(indexDbPath)) {
  console.error(`Error: index.db not found at ${indexDbPath}`);
  console.error('Run the migration script first: node scripts/migrate.js ...');
  process.exit(1);
}

// ============================================================
// Detect tippecanoe: local or Docker
// ============================================================

let useDocker = forceDocker;

if (!useDocker) {
  try {
    execSync('tippecanoe --version', { stdio: 'pipe' });
    console.log('Using local tippecanoe.');
  } catch {
    console.log('tippecanoe not found locally, trying Docker...');
    useDocker = true;
  }
}

if (useDocker) {
  try {
    execSync('docker --version', { stdio: 'pipe' });
  } catch {
    console.error('Error: Neither tippecanoe nor Docker is available.');
    console.error('Install tippecanoe: https://github.com/felt/tippecanoe#installation');
    console.error('Or install Docker and build the image: docker build -t tippecanoe:latest https://github.com/felt/tippecanoe.git');
    process.exit(1);
  }

  // Check if tippecanoe Docker image exists
  try {
    execSync('docker image inspect tippecanoe:latest', { stdio: 'pipe' });
    console.log('Using tippecanoe via Docker.');
  } catch {
    console.error('Error: Docker image "tippecanoe:latest" not found.');
    console.error('Build it with: docker build -t tippecanoe:latest https://github.com/felt/tippecanoe.git');
    process.exit(1);
  }
}

/**
 * Executa o tippecanoe sem interpretacao de shell (execFileSync com array de
 * argumentos), evitando command injection e problemas com paths que contenham
 * espacos, `$`, backticks ou aspas.
 *
 * @param {string[]} tippecanoeArgs - argumentos do tippecanoe (paths devem usar prefixo /data/ no Docker)
 * @param {string} mountDir - diretorio do host montado como /data no Docker
 */
function runTippecanoe(tippecanoeArgs, mountDir) {
  if (useDocker) {
    // A imagem nao define ENTRYPOINT (Cmd = /bin/bash), entao o binario precisa
    // ser nomeado explicitamente — sem isso o runc tenta executar o primeiro
    // argumento ('-o') como se fosse o programa.
    const dockerArgs = [
      'run', '--rm',
      '-v', `${mountDir}:/data`,
      'tippecanoe:latest',
      'tippecanoe',
      ...tippecanoeArgs,
    ];
    execFileSync('docker', dockerArgs, { stdio: 'inherit' });
  } else {
    execFileSync('tippecanoe', tippecanoeArgs, { stdio: 'inherit' });
  }
}

// ============================================================
// Open database
// ============================================================

const db = new Database(indexDbPath, { readonly: true });
db.pragma('journal_mode = WAL');

// ============================================================
// Phase 1: Generate points GeoJSON
// ============================================================

console.log('[1/2] Generating points GeoJSON...');

// Emite NDJSON (uma Feature GeoJSON por linha) em streaming via .iterate(),
// mantendo memoria O(1) e sem o teto de string do V8 do JSON.stringify.
// tippecanoe le NDJSON nativamente.
const photosStmt = db.prepare(`
  SELECT p.id, p.original_name, p.display_name, p.lat, p.lon,
         p.heading, p.ele, p.sequence_number, p.floor_level, p.floor_label,
         pr.slug AS project_slug
  FROM photos p
  JOIN projects pr ON pr.id = p.project_id
  ORDER BY pr.slug, p.sequence_number
`);

const pointsPath = join(outputDir, '_fotos_points.geojson');
const projectSlugs = new Set();
let pointCount = 0;

const stream = createWriteStream(pointsPath);
try {
  for (const p of photosStmt.iterate()) {
    const feature = {
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: [p.lon, p.lat],
      },
      properties: {
        // Both identifiers for backward compatibility
        photo_uuid: p.id,
        nome_img: p.original_name,
        display_name: p.display_name,
        project: p.project_slug,
        heading: p.heading,
        ele: p.ele,
        seq: p.sequence_number,
        // O filtro de andar do minimapa e do mapa principal roda sobre este
        // atributo, direto no MapLibre. Sem ele, os 6 andares do Beira-Rio
        // desenham empilhados no mesmo ponto.
        floor_level: p.floor_level,
        floor_label: p.floor_label,
      },
    };
    stream.write(`${JSON.stringify(feature)}\n`);
    projectSlugs.add(p.project_slug);
    pointCount++;
  }
} finally {
  stream.end();
}

// Aguarda o flush completo no disco antes de invocar o tippecanoe.
await new Promise((resolveStream, rejectStream) => {
  stream.on('finish', resolveStream);
  stream.on('error', rejectStream);
});

console.log(`  ${pointCount} point features written.`);

// ============================================================
// Phase 1b: Generate track GeoJSON (linhas)
// ============================================================
//
// O tracado sai de `project_tracks`, populado por scripts/import-tracks.js.
// Antes a camada de linha era mantida a mao: decodificava-se o proprio PMTiles,
// mesclava-se o geojson do lote novo e re-encodava. Cada volta desse ciclo
// passava a geometria por mais uma simplificacao do tippecanoe, entao a linha
// perdia vertices a cada importacao. Gerando do banco, a fonte e sempre a
// mesma e o resultado nao degrada.

console.log('[1b] Generating track GeoJSON from project_tracks...');

const tracksPath = join(outputDir, '_fotos_linha.geojson');
const tracksStmt = db.prepare(`
  SELECT pr.slug AS origem, t.coords
  FROM project_tracks t
  JOIN projects pr ON pr.id = t.project_id
  ORDER BY pr.slug, t.id
`);

let trackCount = 0;
let vertexCount = 0;
const trackStream = createWriteStream(tracksPath);
try {
  for (const t of tracksStmt.iterate()) {
    const coords = JSON.parse(t.coords);
    trackStream.write(`${JSON.stringify({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: coords },
      properties: { origem: t.origem },
    })}\n`);
    trackCount++;
    vertexCount += coords.length;
  }
} finally {
  trackStream.end();
}
await new Promise((resolveStream, rejectStream) => {
  trackStream.on('finish', resolveStream);
  trackStream.on('error', rejectStream);
});
console.log(`  ${trackCount} track features written (${vertexCount} vertices).`);

// ============================================================
// Phase 2: Run tippecanoe for points
// ============================================================

console.log('[2/2] Running tippecanoe for points (fotos.pmtiles)...');

const pointsOutput = join(outputDir, 'fotos.pmtiles');

// Argumentos do tippecanoe como array (sem shell) — no Docker os paths sao
// relativos ao mount /data.
const tippecanoeArgs = useDocker
  ? [
      '-o', '/data/fotos.pmtiles',
      '-l', 'fotos',
      '-zg',
      '--no-feature-limit',
      '--no-tile-size-limit',
      '--force',
      '/data/_fotos_points.geojson',
    ]
  : [
      '-o', pointsOutput,
      '-l', 'fotos',
      '-zg',
      '--no-feature-limit',
      '--no-tile-size-limit',
      '--force',
      pointsPath,
    ];

// Zoom maximo da camada de LINHA. Nao pode ser `-zg`: o tippecanoe escolhe um
// teto pela distancia media entre feicoes e quantiza a geometria a resolucao
// daquele tile. Em z11 (o valor herdado do arquivo antigo) cada unidade vale
// ~5 m; em z14 vale ~0,55 m, bem abaixo dos 13-19 m entre fotos consecutivas.
const TRACK_MAXZOOM = 14;

// `--no-line-simplification` e o que realmente faz o tracado bater com a fonte.
// Sem ele o tippecanoe simplifica ate no zoom maximo: no DCMun, 305 dos 1437
// vertices do geojson ficavam a mais de 1 m de qualquer vertice gravado. O
// comprimento total se preservava, mas as curvas viravam retas.
const trackArgs = (saida, entrada) => [
  '-o', saida,
  '-l', 'fotos_linha',
  '-z', String(TRACK_MAXZOOM),
  '--no-line-simplification',
  '--no-simplification-of-shared-nodes',
  '--no-feature-limit',
  '--no-tile-size-limit',
  '--force',
  entrada,
];

let exitCode = 0;
try {
  runTippecanoe(tippecanoeArgs, outputDir);
  console.log(`  fotos.pmtiles generated at ${pointsOutput}`);

  const tracksOutput = join(outputDir, 'fotos_linha.pmtiles');
  if (trackCount > 0) {
    console.log('[2b] Running tippecanoe for the track (fotos_linha.pmtiles)...');
    runTippecanoe(
      useDocker
        ? trackArgs('/data/fotos_linha.pmtiles', '/data/_fotos_linha.geojson')
        : trackArgs(tracksOutput, tracksPath),
      outputDir,
    );
    console.log(`  fotos_linha.pmtiles generated at ${tracksOutput}`);
  } else {
    console.log('[2b] project_tracks vazia — fotos_linha.pmtiles nao regenerado.');
    console.log('     Rode: node scripts/import-tracks.js');
  }

  // Summary
  console.log('\nDone!');
  console.log(`  ${projectSlugs.size} projects`);
  console.log(`  ${pointCount} photo points → fotos.pmtiles`);
  if (trackCount > 0) console.log(`  ${trackCount} track lines → fotos_linha.pmtiles (maxzoom ${TRACK_MAXZOOM})`);
  console.log(`  Output: ${outputDir}`);
} catch (error) {
  console.error('Error running tippecanoe:', error.message);
  exitCode = 1;
} finally {
  // Remove os GeoJSON temporarios tanto em sucesso quanto em falha.
  for (const tmp of [pointsPath, tracksPath]) {
    try {
      unlinkSync(tmp);
    } catch {
      // Ignore cleanup errors
    }
  }
  db.close();
}

if (exitCode !== 0) {
  process.exit(exitCode);
}
