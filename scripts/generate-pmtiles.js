#!/usr/bin/env node

/**
 * @module scripts/generate-pmtiles
 * @description Generates a PMTiles file from the street view index.db.
 *
 * Produces:
 *   - fotos.pmtiles — Point layer with one feature per photo
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

import { existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
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
 * @param {string} tippecanoeArgs - tippecanoe CLI arguments (paths must use /data/ prefix for Docker)
 * @param {string} mountDir - host directory to mount as /data in Docker
 */
function runTippecanoe(tippecanoeArgs, mountDir) {
  if (useDocker) {
    const cmd = `docker run --rm -v "${mountDir}:/data" tippecanoe:latest ${tippecanoeArgs}`;
    execSync(cmd, { stdio: 'inherit' });
  } else {
    execSync(`tippecanoe ${tippecanoeArgs}`, { stdio: 'inherit' });
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

const photos = db.prepare(`
  SELECT p.id, p.original_name, p.display_name, p.lat, p.lon,
         p.heading, p.ele, p.sequence_number, p.floor_level,
         pr.slug AS project_slug
  FROM photos p
  JOIN projects pr ON pr.id = p.project_id
  ORDER BY pr.slug, p.sequence_number
`).all();

const pointFeatures = photos.map(p => ({
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
    floor_level: p.floor_level,
  },
}));

const pointsGeoJSON = {
  type: 'FeatureCollection',
  features: pointFeatures,
};

const pointsPath = join(outputDir, '_fotos_points.geojson');
writeFileSync(pointsPath, JSON.stringify(pointsGeoJSON));
console.log(`  ${pointFeatures.length} point features written.`);

// ============================================================
// Phase 2: Run tippecanoe for points
// ============================================================

console.log('[2/2] Running tippecanoe for points (fotos.pmtiles)...');

const pointsOutput = join(outputDir, 'fotos.pmtiles');

// Build tippecanoe arguments — when using Docker, paths are relative to /data mount
const tippecanoeArgs = useDocker
  ? [
      '-o /data/fotos.pmtiles',
      '-l fotos',
      '-zg',
      '--no-feature-limit',
      '--no-tile-size-limit',
      '--force',
      '/data/_fotos_points.geojson',
    ].join(' ')
  : [
      `-o "${pointsOutput}"`,
      '-l fotos',
      '-zg',
      '--no-feature-limit',
      '--no-tile-size-limit',
      '--force',
      `"${pointsPath}"`,
    ].join(' ');

try {
  runTippecanoe(tippecanoeArgs, outputDir);
  console.log(`  fotos.pmtiles generated at ${pointsOutput}`);
} catch (error) {
  console.error('Error running tippecanoe for points:', error.message);
  process.exit(1);
}

// ============================================================
// Cleanup temp files
// ============================================================

try {
  unlinkSync(pointsPath);
} catch {
  // Ignore cleanup errors
}

db.close();

// Summary
const stats = {
  points: pointFeatures.length,
  projects: new Set(photos.map(p => p.project_slug)).size,
};

console.log('\nDone!');
console.log(`  ${stats.projects} projects`);
console.log(`  ${stats.points} photo points → fotos.pmtiles`);
console.log(`  Output: ${outputDir}`);
