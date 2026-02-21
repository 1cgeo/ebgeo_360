#!/usr/bin/env node

/**
 * @module scripts/migrate
 * @description One-time migration script that transforms the static street view data
 * (METADATA/*.json + IMG/*.jpg) into SQLite databases:
 *   - index.db: metadata, navigation graph, spatial index
 *   - {slug}.db: per-project image BLOBs (full WebP + preview WebP)
 *
 * Includes adaptive spatial target generation (sector-based, per-project adaptive radius).
 *
 * Usage:
 *   node scripts/migrate.js --metadata <METADATA_DIR> --images <IMG_DIR> [--output <DATA_DIR>] [--workers <N>] [--skip-images]
 */

import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);

// ============================================================
// CLI Arguments
// ============================================================

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    metadata: null,
    images: null,
    output: resolve('./data'),
    workers: 4,
    skipImages: false,
    skipTargets: false, // skip automatic target generation (for manual indoor graphs)
    // Adaptive spatial targets (sector-based, per-project)
    multiplier: 5,     // radius = median_nn_dist * multiplier
    maxTargets: 6,     // max spatial targets per photo
    sectors: 4,        // number of angular sectors (360/4 = 90° each)
    perSector: 3,      // max targets per sector
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--metadata': opts.metadata = resolve(args[++i]); break;
      case '--images': opts.images = resolve(args[++i]); break;
      case '--output': opts.output = resolve(args[++i]); break;
      case '--workers': opts.workers = parseInt(args[++i], 10); break;
      case '--skip-images': opts.skipImages = true; break;
      case '--skip-targets': opts.skipTargets = true; break;
      case '--multiplier': opts.multiplier = parseFloat(args[++i]); break;
      case '--max-targets': opts.maxTargets = parseInt(args[++i], 10); break;
      case '--sectors': opts.sectors = parseInt(args[++i], 10); break;
      case '--per-sector': opts.perSector = parseInt(args[++i], 10); break;
    }
  }

  if (!opts.metadata || !opts.images) {
    console.error('Usage: node migrate.js --metadata <METADATA_DIR> --images <IMG_DIR> [--output <DATA_DIR>] [--workers <N>] [--skip-images]');
    process.exit(1);
  }

  return opts;
}

// ============================================================
// Project definitions (from config.js streetViewMarkers)
// ============================================================

const PROJECTS = [
  // { name: 'Alegrete', slug: 'alegrete', description: 'Imagens panorâmicas em Alegrete', capture_date: '2025-05-27', location: 'Alegrete, RS', lat: -29.784988, lon: -55.774959, entryPhoto: 'MULTICAPTURA_0466_001369' },
  // { name: 'Parque Osório', slug: 'parque_osorio', description: 'Imagens panorâmicas no Parque Osório', capture_date: '2025-04-22', location: 'Tramandaí, RS', lat: -29.984937, lon: -50.219546, entryPhoto: 'MULTICAPTURA_7476_000027' },
  // { name: 'Uruguaiana', slug: 'uruguaiana', description: 'Imagens panorâmicas em Uruguaiana', capture_date: '2022-08-22', location: 'Uruguaiana, RS', lat: -29.779807, lon: -57.088023, entryPhoto: 'MULTICAPTURA_3559_002909' },
  // { name: '3º RCMec', slug: '3o_rcmec', description: 'Imagens panorâmicas do 3º Regimento de Cavalaria Mecanizada', capture_date: '2024-04-11', location: 'Bagé, RS', lat: -31.315991, lon: -54.110370, entryPhoto: 'MULTICAPTURA_4922_000041' },
  // { name: 'Campo Instrução Santa Tecla', slug: 'cist', description: 'Imagens panorâmicas do Campo de Instrução de Santa Tecla', capture_date: '2024-04-11', location: 'Bagé, RS', lat: -31.284910, lon: -54.069718, entryPhoto: 'MULTICAPTURA_3814_000033' },
  // { name: '27º GAC', slug: '27o_gac', description: 'Imagens panorâmicas do 27º Grupo de Artilharia de Campanha', capture_date: '2025-10-09', location: 'Ijuí, RS', lat: -28.404819, lon: -53.915587, entryPhoto: 'PIC_20251009_092017_25_10_09_16_29_37_output_695' },
  // { name: 'CI Guarnição Ijuí', slug: 'cigi', description: 'Imagens panorâmicas do Campo de Instrução da Guarnição de Ijuí', capture_date: '2025-10-09', location: 'Ijuí, RS', lat: -28.430150, lon: -53.816107, entryPhoto: 'PIC_20251009_103847_25_10_09_16_50_02_output_107' },
  // { name: 'EASA', slug: 'easa', description: 'Imagens panorâmicas da Escola de Aperfeiçoamento de Sargentos das Armas', capture_date: '2025-10-07', location: 'Cruz Alta, RS', lat: -28.634834, lon: -53.613737, entryPhoto: 'PIC_20251007_150951_25_10_07_20_18_43_output_415' },
  // { name: '29º GACap', slug: '29o_gacap', description: 'Imagens panorâmicas do 29º Grupo de Artilharia de Campanha Autopropulsado', capture_date: '2025-10-10', location: 'Cruz Alta, RS', lat: -28.640036, lon: -53.595573, entryPhoto: 'PIC_20251010_090014_25_10_10_14_19_26_output_072' },
  // { name: 'CI Cruz Alta', slug: 'cica', description: 'Imagens panorâmicas do Campo de Instrução de Cruz Alta', capture_date: '2025-10-07', location: 'Cruz Alta, RS', lat: -28.659547, lon: -53.583192, entryPhoto: 'PIC_20251007_090419_25_10_07_17_13_32_output_0275' },
  // { name: 'Santana do Livramento', slug: 'santana_livramento', description: "Imagens panorâmicas de Sant'Ana do Livramento", capture_date: '2025-03-21', location: "Sant'Ana do Livramento, RS", lat: -30.877844, lon: -55.515478, entryPhoto: 'MULTICAPTURA_9468_005109' },
  // { name: 'Tubarão', slug: 'tubarao', description: 'Imagens panorâmicas de Tubarão', capture_date: '2025-11-09', location: 'Tubarão, SC', lat: -28.469048, lon: -48.989005, entryPhoto: 'PIC_20251109_111840_25_11_09_15_56_28_output_049' },
  // { name: 'Blumenau', slug: 'blumenau', description: 'Imagens panorâmicas da Área de Instrução do 23º BI', capture_date: '2025-11-05', location: 'Blumenau, SC', lat: -27.030783, lon: -49.167277, entryPhoto: 'PIC_20251105_120346_25_11_05_15_53_49_output_234' },
  // { name: 'CI General Calazans', slug: 'cigc', description: 'Imagens panorâmicas do Campo de Instrução General Calazans', capture_date: '2025-06-17', location: 'Ponta Grossa, PR', lat: -25.089303, lon: -50.080891, entryPhoto: 'MULTICAPTURA_6475_000275' },
  // { name: 'Ponta Grossa 1', slug: 'ponta_grossa_1', description: 'Imagens panorâmicas de Áreas de Interesse em Ponta Grossa (1)', capture_date: '2025-06-17', location: 'Ponta Grossa, PR', lat: -25.085013, lon: -50.408129, entryPhoto: 'MULTICAPTURA_4103_000184' },
  // { name: 'Ponta Grossa 2', slug: 'ponta_grossa_2', description: 'Imagens panorâmicas de Áreas de Interesse em Ponta Grossa (2)', capture_date: '2025-06-17', location: 'Ponta Grossa, PR', lat: -25.192272, lon: -50.136586, entryPhoto: 'MULTICAPTURA_8659_000358' },
  // { name: 'Academia Militar das Agulhas Negras', slug: 'aman', description: 'Imagens panorâmicas da Academia Militar das Agulhas Negras', capture_date: '2024-04-28', location: 'Resende, RJ', lat: -22.460190, lon: -44.450328, entryPhoto: 'MULTICAPTURA_6416_000770' },
  // { name: 'Campo de Instrução do Atalaia', slug: 'ciatalaia', description: 'Imagens panorâmicas do Campo de Instrução do Atalaia', capture_date: '2024-04-28', location: 'Três Corações, MG', lat: -21.694838, lon: -45.277349, entryPhoto: 'MULTICAPTURA_7536_001421' },
  // { name: 'Campo de Instrução General Moacyr Araújo Lopes', slug: 'cigmal', description: 'Imagens panorâmicas do Campo de Instrução General Moacyr Araújo Lopes', capture_date: '2024-04-28', location: 'São Thomé das Letras, MG', lat: -21.624797, lon: -44.980342, entryPhoto: 'MULTICAPTURA_7999_004825' },
  // { name: '1º Pelotão Especial de Fronteira', slug: '1pef', description: 'Imagens panorâmicas do 1º Pelotão Especial de Fronteira', capture_date: '2025-06-02', location: 'Bonfim, RR', lat: 3.379524, lon: -59.818027, entryPhoto: 'MULTICAPTURA_0189_000159' },
  // { name: '3º Pelotão Especial de Fronteira', slug: '3pef', description: 'Imagens panorâmicas do 3º Pelotão Especial de Fronteira', capture_date: '2025-06-02', location: 'Pacaraima, RR', lat: 4.478931, lon: -61.151317, entryPhoto: 'MULTICAPTURA_8590_000062' },
  // { name: 'Museu do CMS', slug: 'museu_cms', description: 'Imagens panorâmicas do Museu do Comando Militar do Sul', capture_date: '2025-12-05', location: 'Porto Alegre, RS', lat: -30.031488, lon: -51.235524, entryPhoto: 'PIC_20251205_114053_25_12_08_08_47_46_output_1', skipTargets: true },
];

// ============================================================
// Geo utilities
// ============================================================

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;
const EARTH_RADIUS = 6371000; // meters

function haversine(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * DEG_TO_RAD;
  const dLon = (lon2 - lon1) * DEG_TO_RAD;
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * DEG_TO_RAD) * Math.cos(lat2 * DEG_TO_RAD) *
            Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function bearing(lat1, lon1, lat2, lon2) {
  const dLon = (lon2 - lon1) * DEG_TO_RAD;
  const y = Math.sin(dLon) * Math.cos(lat2 * DEG_TO_RAD);
  const x = Math.cos(lat1 * DEG_TO_RAD) * Math.sin(lat2 * DEG_TO_RAD) -
            Math.sin(lat1 * DEG_TO_RAD) * Math.cos(lat2 * DEG_TO_RAD) * Math.cos(dLon);
  return ((Math.atan2(y, x) * RAD_TO_DEG) + 360) % 360;
}

// ============================================================
// Phase 1: Read all metadata JSON files
// ============================================================

function readAllMetadata(metadataDir) {
  console.log('[Phase 1/7] Reading metadata files...');
  const files = readdirSync(metadataDir).filter(f => f.endsWith('.json'));
  const photos = new Map(); // originalName → metadata
  let count = 0;

  for (const file of files) {
    try {
      const raw = readFileSync(join(metadataDir, file), 'utf-8');
      const data = JSON.parse(raw);
      const name = file.replace('.json', '');

      photos.set(name, {
        originalName: name,
        camera: data.camera,
        targets: (data.targets || []).map(t => {
          // Normalize target img: strip .jpg if present
          let img = t.img || t.id;
          if (img && img.endsWith('.jpg')) img = img.slice(0, -4);
          return {
            img,
            lon: t.lon,
            lat: t.lat,
            ele: t.ele,
            icon: t.icon,
            next: Boolean(t.next),
          };
        }),
      });

      count++;
      if (count % 10000 === 0) {
        process.stdout.write(`  ${count}/${files.length} (${((count / files.length) * 100).toFixed(1)}%)\r`);
      }
    } catch (err) {
      console.warn(`  Warning: Failed to parse ${file}: ${err.message}`);
    }
  }

  console.log(`  ${count} metadata files loaded.`);
  return photos;
}

// ============================================================
// Phase 2: Assign photos to projects (nearest center)
// ============================================================

function assignToProjects(photos, projects, opts) {
  console.log('[Phase 2/7] Assigning photos to projects...');

  const assignments = new Map(); // originalName → project slug
  const projectPhotos = new Map(); // slug → [originalName, ...]

  for (const p of projects) {
    projectPhotos.set(p.slug, []);
  }

  // Max distance threshold: 50 km from any project center
  const MAX_ASSIGN_DIST = 50000;

  for (const [name, meta] of photos) {
    const lat = meta.camera.lat;
    const lon = meta.camera.lon;
    if (lat == null || lon == null) continue;

    let bestDist = Infinity;
    let bestSlug = null;

    for (const p of projects) {
      const dist = haversine(lat, lon, p.lat, p.lon);
      if (dist < bestDist) {
        bestDist = dist;
        bestSlug = p.slug;
      }
    }

    if (bestDist <= MAX_ASSIGN_DIST && bestSlug) {
      assignments.set(name, bestSlug);
      projectPhotos.get(bestSlug).push(name);
    }
  }

  console.log('  Assignment summary:');
  for (const [slug, names] of projectPhotos) {
    if (names.length > 0) {
      console.log(`    ${slug}: ${names.length} photos`);
    }
  }

  const unassignedNames = [];
  for (const [name, meta] of photos) {
    if (!assignments.has(name)) {
      const lat = meta.camera.lat;
      const lon = meta.camera.lon;

      // Find nearest project for context
      let bestDist = Infinity;
      let bestSlug = null;
      if (lat != null && lon != null) {
        for (const p of projects) {
          const dist = haversine(lat, lon, p.lat, p.lon);
          if (dist < bestDist) { bestDist = dist; bestSlug = p.slug; }
        }
      }

      unassignedNames.push({ name, lat, lon, nearestProject: bestSlug, distanceKm: (bestDist / 1000).toFixed(1) });
    }
  }

  if (unassignedNames.length > 0) {
    console.log(`  WARNING: ${unassignedNames.length} photos unassigned (too far from any project center).`);

    // Write detailed report
    const reportLines = ['originalName,lat,lon,nearestProject,distanceKm'];
    for (const u of unassignedNames) {
      reportLines.push(`${u.name},${u.lat},${u.lon},${u.nearestProject},${u.distanceKm}`);
    }
    const reportPath = join(opts.output, '_unassigned_photos.csv');
    if (!existsSync(opts.output)) mkdirSync(opts.output, { recursive: true });
    writeFileSync(reportPath, reportLines.join('\n'), 'utf-8');
    console.log(`  Unassigned report saved to: ${reportPath}`);
  }

  return { assignments, projectPhotos };
}

// ============================================================
// Phase 3: Sequence photos per project
// ============================================================

function sequenceProject(projectDef, photoNames, photos) {
  const visited = new Set();
  const sequence = [];

  // Phase 3a: Walk the next:true chain from entry photo
  let current = projectDef.entryPhoto;
  while (current && !visited.has(current) && photos.has(current)) {
    visited.add(current);
    sequence.push(current);

    const meta = photos.get(current);
    const nextTarget = meta.targets.find(t => t.next && photos.has(t.img));
    current = nextTarget ? nextTarget.img : null;
  }

  // Phase 3b: BFS for remaining connected photos
  const queue = [...sequence];
  let qi = 0;
  while (qi < queue.length) {
    const node = queue[qi++];
    const meta = photos.get(node);
    if (!meta) continue;

    for (const t of meta.targets) {
      if (t.img && !visited.has(t.img) && photos.has(t.img)) {
        visited.add(t.img);
        sequence.push(t.img);
        queue.push(t.img);
      }
    }
  }

  // Phase 3c: Orphaned photos (assigned to project but unreachable via graph)
  const projectSet = new Set(photoNames);
  const orphaned = photoNames.filter(n => !visited.has(n) && projectSet.has(n));

  // Sort orphaned by lat, then lon for deterministic ordering
  orphaned.sort((a, b) => {
    const ma = photos.get(a);
    const mb = photos.get(b);
    const latDiff = (ma.camera.lat || 0) - (mb.camera.lat || 0);
    return latDiff !== 0 ? latDiff : (ma.camera.lon || 0) - (mb.camera.lon || 0);
  });

  sequence.push(...orphaned);

  return sequence;
}

function sequenceAllProjects(projects, projectPhotos, photos) {
  console.log('[Phase 3/7] Computing sequence numbers...');

  const sequences = new Map(); // slug → [originalName in order]

  for (const p of projects) {
    const names = projectPhotos.get(p.slug) || [];
    if (names.length === 0) continue;

    const seq = sequenceProject(p, names, photos);
    sequences.set(p.slug, seq);
    console.log(`  ${p.slug}: ${seq.length} photos sequenced`);
  }

  return sequences;
}

// ============================================================
// Phase 4: Generate UUIDs
// ============================================================

function generateUUIDs(projects, sequences) {
  console.log('[Phase 4/7] Generating UUIDs...');

  const projectUUIDs = new Map(); // slug → uuid
  const photoUUIDs = new Map(); // originalName → uuid
  const photoDisplayNames = new Map(); // originalName → display_name

  for (const p of projects) {
    projectUUIDs.set(p.slug, randomUUID());
  }

  for (const [slug, seq] of sequences) {
    const project = projects.find(p => p.slug === slug);
    const safeName = project.name
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // Remove accents
      .replace(/['']/g, '')                              // Remove apostrophes
      .replace(/\s+/g, '_')                              // Spaces to underscore
      .replace(/[^a-zA-Z0-9_-]/g, '')                    // Remove special chars
      .replace(/_+/g, '_')                                // Collapse underscores
      .slice(0, 50);

    for (let i = 0; i < seq.length; i++) {
      const originalName = seq[i];
      const uuid = randomUUID();
      photoUUIDs.set(originalName, uuid);
      photoDisplayNames.set(originalName, `${safeName}_${String(i + 1).padStart(4, '0')}`);
    }
  }

  console.log(`  ${photoUUIDs.size} photo UUIDs generated.`);
  return { projectUUIDs, photoUUIDs, photoDisplayNames };
}

// ============================================================
// Phase 5: Adaptive spatial analysis for enhanced targets
// Uses per-project adaptive radius based on median nearest-neighbor
// distance and sector-based target selection for good coverage.
// ============================================================

/**
 * Computes the median nearest-neighbor distance for a set of photos.
 * Uses a grid-based spatial index for O(n) average complexity.
 * @param {Array<{name: string, lat: number, lon: number}>} photoList
 * @returns {number|null} Median distance in meters, or null if < 2 photos
 */
function computeMedianNearestDist(photoList) {
  if (photoList.length < 2) return null;

  const CELL_SIZE = 0.001; // ~111m in latitude
  const grid = new Map();

  for (const p of photoList) {
    const key = `${Math.floor(p.lat / CELL_SIZE)},${Math.floor(p.lon / CELL_SIZE)}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(p);
  }

  const nearestDists = [];

  for (const photo of photoList) {
    const cellLat = Math.floor(photo.lat / CELL_SIZE);
    const cellLon = Math.floor(photo.lon / CELL_SIZE);
    let minDist = Infinity;

    for (let dlat = -1; dlat <= 1; dlat++) {
      for (let dlon = -1; dlon <= 1; dlon++) {
        const cell = grid.get(`${cellLat + dlat},${cellLon + dlon}`);
        if (!cell) continue;
        for (const c of cell) {
          if (c.name === photo.name) continue;
          const d = haversine(photo.lat, photo.lon, c.lat, c.lon);
          if (d < minDist) minDist = d;
        }
      }
    }

    // Fallback: brute-force if grid missed (very sparse data)
    if (minDist === Infinity) {
      for (const other of photoList) {
        if (other.name === photo.name) continue;
        const d = haversine(photo.lat, photo.lon, other.lat, other.lon);
        if (d < minDist) minDist = d;
      }
    }

    if (minDist < Infinity) nearestDists.push(minDist);
  }

  nearestDists.sort((a, b) => a - b);
  return nearestDists[Math.floor(nearestDists.length / 2)];
}

/**
 * Builds a spatial grid with adaptive cell size for candidate search.
 * @param {Array<{name: string, lat: number, lon: number}>} photoList
 * @param {number} radius - Search radius in meters
 * @returns {{grid: Map, cellDeg: number}}
 */
function buildAdaptiveGrid(photoList, radius) {
  const cellDeg = Math.max(0.001, (radius / EARTH_RADIUS) * RAD_TO_DEG * 1.2);
  const grid = new Map();

  for (const p of photoList) {
    const key = `${Math.floor(p.lat / cellDeg)},${Math.floor(p.lon / cellDeg)}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(p);
  }

  return { grid, cellDeg };
}

/**
 * Generates sector-based spatial targets for a set of photos in one project.
 * Divides the space around each photo into angular sectors and picks the
 * closest candidates per sector, providing good directional coverage.
 *
 * @param {Array<{name: string, lat: number, lon: number}>} projectPhotos
 * @param {Map<string, Set<string>>} originalTargetMap - name → Set of existing target names
 * @param {Map<string, Array<{bearing: number}>>} originalBearingsMap - name → [{bearing}]
 * @param {number} radius - Search radius in meters
 * @param {Object} opts - {maxTargets, sectors, perSector}
 * @returns {Map<string, Array<{targetName, distance, bearing}>>}
 */
function generateSpatialTargetsForProject(projectPhotos, originalTargetMap, originalBearingsMap, radius, opts) {
  const { grid, cellDeg } = buildAdaptiveGrid(projectPhotos, radius);
  const sectorSize = 360 / opts.sectors;
  const result = new Map();

  for (const photo of projectPhotos) {
    const existingTargetNames = originalTargetMap.get(photo.name) || new Set();
    const existingBearings = originalBearingsMap.get(photo.name) || [];

    // Count existing original targets per sector
    const sectorCounts = new Array(opts.sectors).fill(0);
    for (const eb of existingBearings) {
      const sector = Math.floor(eb.bearing / sectorSize) % opts.sectors;
      sectorCounts[sector]++;
    }

    // Find candidates within radius
    const cellLat = Math.floor(photo.lat / cellDeg);
    const cellLon = Math.floor(photo.lon / cellDeg);
    const candidates = [];

    for (let dlat = -1; dlat <= 1; dlat++) {
      for (let dlon = -1; dlon <= 1; dlon++) {
        const cell = grid.get(`${cellLat + dlat},${cellLon + dlon}`);
        if (!cell) continue;

        for (const c of cell) {
          if (c.name === photo.name) continue;
          if (existingTargetNames.has(c.name)) continue;

          const dist = haversine(photo.lat, photo.lon, c.lat, c.lon);
          if (dist > radius) continue;

          const bear = bearing(photo.lat, photo.lon, c.lat, c.lon);
          const sector = Math.floor(bear / sectorSize) % opts.sectors;

          candidates.push({ targetName: c.name, distance: dist, bearing: bear, sector });
        }
      }
    }

    // Sort by distance (closest first)
    candidates.sort((a, b) => a.distance - b.distance);

    // Greedy selection: pick closest candidates per sector
    const addedSectorCounts = [...sectorCounts];
    const selected = [];

    for (const c of candidates) {
      if (selected.length >= opts.maxTargets) break;
      if (addedSectorCounts[c.sector] >= opts.perSector) continue;

      selected.push(c);
      addedSectorCounts[c.sector]++;
    }

    if (selected.length > 0) {
      result.set(photo.name, selected);
    }
  }

  return result;
}

function adaptiveSpatialAnalysis(photos, photoUUIDs, opts, assignments, projects) {
  console.log('[Phase 5/7] Adaptive spatial analysis for enhanced targets...');

  // Build set of slugs that skip spatial target generation
  const skipTargetSlugs = new Set(projects.filter(p => p.skipTargets).map(p => p.slug));
  if (skipTargetSlugs.size > 0) {
    console.log(`  Skipping spatial targets for: ${[...skipTargetSlugs].join(', ')}`);
  }

  // Group photos by project slug
  const projectPhotoLists = new Map(); // slug → [{name, lat, lon}]
  for (const [name, meta] of photos) {
    if (!photoUUIDs.has(name)) continue;
    const slug = assignments.get(name);
    if (!slug) continue;
    if (skipTargetSlugs.has(slug)) continue;
    const lat = meta.camera.lat;
    const lon = meta.camera.lon;
    if (lat == null || lon == null) continue;

    if (!projectPhotoLists.has(slug)) projectPhotoLists.set(slug, []);
    projectPhotoLists.get(slug).push({ name, lat, lon });
  }

  // Build per-photo original target maps (name-based, not UUID-based)
  const originalTargetMap = new Map(); // name → Set<targetName>
  const originalBearingsMap = new Map(); // name → [{bearing}]
  for (const [name, meta] of photos) {
    if (!photoUUIDs.has(name)) continue;
    const targetNames = new Set();
    const bearings = [];
    for (const t of meta.targets) {
      if (!t.img || !photos.has(t.img)) continue;
      targetNames.add(t.img);
      const tm = photos.get(t.img);
      bearings.push({ bearing: bearing(meta.camera.lat, meta.camera.lon, tm.camera.lat, tm.camera.lon) });
    }
    originalTargetMap.set(name, targetNames);
    originalBearingsMap.set(name, bearings);
  }

  const spatialTargets = new Map(); // originalName → [{targetName, distance, bearing}]
  let totalNew = 0;

  console.log('  Project                   | Photos | Median NN (m) | Radius (m) | Spatial');
  console.log('  --------------------------|--------|---------------|------------|--------');

  for (const [slug, projectPhotos] of projectPhotoLists) {
    if (projectPhotos.length < 2) continue;

    const medianNN = computeMedianNearestDist(projectPhotos);
    if (medianNN == null) continue;

    const radius = Math.round(medianNN * opts.multiplier);
    const projectSpatial = generateSpatialTargetsForProject(
      projectPhotos, originalTargetMap, originalBearingsMap, radius, opts
    );

    // Merge into global map
    let projectNew = 0;
    for (const [name, targets] of projectSpatial) {
      spatialTargets.set(name, targets);
      projectNew += targets.length;
    }
    totalNew += projectNew;

    console.log(
      `  ${slug.padEnd(25)} | ` +
      `${String(projectPhotos.length).padStart(6)} | ` +
      `${medianNN.toFixed(1).padStart(13)} | ` +
      `${String(radius).padStart(10)} | ` +
      `${String(projectNew).padStart(6)}`
    );
  }

  console.log(`  ${totalNew} new spatial targets across ${spatialTargets.size} photos.`);
  return spatialTargets;
}

// ============================================================
// Phase 6: Populate metadata and targets in index.db
// ============================================================

function populateMetadata(opts, photos, projects, sequences, projectUUIDs, photoUUIDs, photoDisplayNames, spatialTargets) {
  console.log('[Phase 6/7] Populating metadata in index.db...');

  // Ensure output directories exist
  if (!existsSync(opts.output)) mkdirSync(opts.output, { recursive: true });
  const projectsDir = join(opts.output, 'projects');
  if (!existsSync(projectsDir)) mkdirSync(projectsDir, { recursive: true });

  // Create index.db
  const indexDbPath = join(opts.output, 'index.db');
  const indexDb = new Database(indexDbPath);
  indexDb.pragma('journal_mode = WAL');
  indexDb.pragma('synchronous = NORMAL');

  // Initialize schema
  const schemaPath = resolve(fileURLToPath(new URL('../src/db/schema.sql', import.meta.url)));
  const schema = readFileSync(schemaPath, 'utf-8');
  indexDb.exec(schema);

  // Insert projects
  const insertProject = indexDb.prepare(`
    INSERT OR REPLACE INTO projects (id, slug, name, description, capture_date, location, center_lat, center_lon, entry_photo_id, photo_count, db_filename)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertPhoto = indexDb.prepare(`
    INSERT OR REPLACE INTO photos (id, project_id, original_name, display_name, sequence_number, lat, lon, ele, heading, camera_height, mesh_rotation_y, mesh_rotation_x, mesh_rotation_z, distance_scale, floor_level, full_size_bytes, preview_size_bytes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertRowid = indexDb.prepare(`INSERT OR REPLACE INTO photos_rowid (photo_id) VALUES (?)`);
  const insertRtree = indexDb.prepare(`INSERT OR REPLACE INTO photos_rtree (rowid_id, min_lon, max_lon, min_lat, max_lat) VALUES (?, ?, ?, ?, ?)`);

  const insertTarget = indexDb.prepare(`
    INSERT OR REPLACE INTO targets (source_id, target_id, distance_m, bearing_deg, is_next, is_original)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const transact = indexDb.transaction(() => {
    for (const p of projects) {
      const seq = sequences.get(p.slug);
      if (!seq || seq.length === 0) continue;

      const projectId = projectUUIDs.get(p.slug);
      const entryPhotoId = photoUUIDs.get(p.entryPhoto);
      const dbFilename = `${p.slug}.db`;

      insertProject.run(
        projectId, p.slug, p.name, p.description, p.capture_date, p.location,
        p.lat, p.lon, entryPhotoId, seq.length, dbFilename
      );

      // Insert photos
      for (let i = 0; i < seq.length; i++) {
        const originalName = seq[i];
        const uuid = photoUUIDs.get(originalName);
        const displayName = photoDisplayNames.get(originalName);
        const meta = photos.get(originalName);
        const cam = meta.camera;

        insertPhoto.run(
          uuid, projectId, originalName, displayName, i + 1,
          cam.lat, cam.lon, cam.ele, cam.heading, cam.cameraHeight || cam.height || null,
          cam.mesh_rotation_y ?? 180, cam.mesh_rotation_x ?? 0, cam.mesh_rotation_z ?? 0,
          cam.distance_scale ?? 1.0, cam.floor_level ?? 1,
          null, null // sizes filled during image processing
        );

        // R-tree entry
        const rowidResult = insertRowid.run(uuid);
        const rowidId = rowidResult.lastInsertRowid;
        insertRtree.run(rowidId, cam.lon, cam.lon, cam.lat, cam.lat);
      }
    }
  });

  transact();

  // Insert targets (separate transaction for clarity)
  const targetTransact = indexDb.transaction(() => {
    for (const [originalName, meta] of photos) {
      const sourceUuid = photoUUIDs.get(originalName);
      if (!sourceUuid) continue;

      // Original targets from metadata
      for (const t of meta.targets) {
        const targetUuid = photoUUIDs.get(t.img);
        if (!targetUuid) continue;

        const targetMeta = photos.get(t.img);
        if (!targetMeta) continue;

        const dist = haversine(meta.camera.lat, meta.camera.lon, targetMeta.camera.lat, targetMeta.camera.lon);
        const bear = bearing(meta.camera.lat, meta.camera.lon, targetMeta.camera.lat, targetMeta.camera.lon);

        insertTarget.run(sourceUuid, targetUuid, dist, bear, t.next ? 1 : 0, 1);
      }

      // Spatial targets
      const spatial = spatialTargets.get(originalName);
      if (spatial) {
        for (const st of spatial) {
          const targetUuid = photoUUIDs.get(st.targetName);
          if (!targetUuid) continue;
          insertTarget.run(sourceUuid, targetUuid, st.distance, st.bearing, 0, 0);
        }
      }
    }
  });

  targetTransact();
  console.log('  Metadata and targets populated in index.db.');

  // Return the open DB handle for subsequent phases
  return indexDb;
}

// ============================================================
// Phase 7: Process images into per-project databases
// ============================================================

async function processImages(opts, projects, sequences, photoUUIDs, indexDb) {
  if (opts.skipImages) {
    console.log('[Phase 7/7] Skipping image processing (--skip-images).');
    return;
  }

  console.log('[Phase 7/7] Processing images into per-project databases...');

  const projectsDir = join(opts.output, 'projects');
  const projectSchemaPath = resolve(fileURLToPath(new URL('../src/db/project-schema.sql', import.meta.url)));
  const projectSchema = readFileSync(projectSchemaPath, 'utf-8');
  const sharp = (await import('sharp')).default;

  const updateSizes = indexDb.prepare(`UPDATE photos SET full_size_bytes = ?, preview_size_bytes = ? WHERE id = ?`);

  // Create global error CSV upfront (header written once)
  const errPath = join(opts.output, '_image_errors.csv');
  writeFileSync(errPath, 'project,originalName,reason\n', 'utf-8');
  let totalErrors = 0;

  for (const p of projects) {
    const seq = sequences.get(p.slug);
    if (!seq || seq.length === 0) continue;

    const dbFilename = `${p.slug}.db`;
    const projDbPath = join(projectsDir, dbFilename);

    // Create project DB with large page size
    const projDb = new Database(projDbPath);
    try {
      projDb.pragma('page_size = 65536');
      projDb.pragma('journal_mode = WAL');
      projDb.pragma('synchronous = NORMAL');
      projDb.exec(projectSchema);

      const insertImage = projDb.prepare(`INSERT OR REPLACE INTO images (photo_id, full_webp, preview_webp) VALUES (?, ?, ?)`);

      console.log(`  Processing ${p.slug} (${seq.length} photos)...`);
      let processed = 0;
      let errors = 0;

      // Process in batches: convert images with sharp (async), insert in transaction (sync)
      const BATCH_SIZE = 100;
      for (let batch = 0; batch < seq.length; batch += BATCH_SIZE) {
        const batchEnd = Math.min(batch + BATCH_SIZE, seq.length);
        const batchNames = seq.slice(batch, batchEnd);

        const batchErrors = []; // collect errors for this batch
        const promises = [];
        for (const originalName of batchNames) {
          const uuid = photoUUIDs.get(originalName);
          const imgPath = join(opts.images, `${originalName}.jpg`);

          if (!existsSync(imgPath)) {
            errors++;
            batchErrors.push({ originalName, reason: 'JPG file not found' });
            continue;
          }

          promises.push(
            (async () => {
              try {
                const imgBuffer = readFileSync(imgPath);
                const [fullBuf, prevBuf] = await Promise.all([
                  sharp(imgBuffer).webp({ quality: 80 }).toBuffer(),
                  sharp(imgBuffer).resize(512, 256, { fit: 'fill' }).webp({ quality: 70 }).toBuffer(),
                ]);
                return { uuid, fullBuf, prevBuf };
              } catch (err) {
                errors++;
                batchErrors.push({ originalName, reason: err.message });
                return null;
              }
            })()
          );
        }

        const results = await Promise.all(promises);

        // Insert in transaction (synchronous)
        const insertTransact = projDb.transaction(() => {
          for (const r of results) {
            if (!r) continue;
            insertImage.run(r.uuid, r.fullBuf, r.prevBuf);
            updateSizes.run(r.fullBuf.length, r.prevBuf.length, r.uuid);
            processed++;
          }
        });
        insertTransact();

        // Flush errors to CSV immediately after each batch
        if (batchErrors.length > 0) {
          const lines = batchErrors.map(e => `${p.slug},${e.originalName},"${e.reason.replace(/"/g, '""')}"`).join('\n') + '\n';
          appendFileSync(errPath, lines, 'utf-8');
          totalErrors += batchErrors.length;
        }

        process.stdout.write(`    ${processed}/${seq.length} processed (${errors} errors)\r`);
      }

      console.log(`    ${processed}/${seq.length} done (${errors} errors)`);
    } finally {
      projDb.close();
    }
  }

  if (totalErrors > 0) {
    console.log(`  Total image errors: ${totalErrors} (see ${errPath})`);
  }
}

// ============================================================
// Main
// ============================================================

async function main() {
  const opts = parseArgs();
  const startTime = Date.now();

  console.log('=== Street View Migration ===');
  console.log(`  Metadata:     ${opts.metadata}`);
  console.log(`  Images:       ${opts.images}`);
  console.log(`  Output:       ${opts.output}`);
  console.log(`  Workers:      ${opts.workers}`);
  console.log(`  Skip images:  ${opts.skipImages}`);
  console.log(`  Skip targets: ${opts.skipTargets}`);
  console.log(`  Multiplier:   ${opts.multiplier}x median NN`);
  console.log(`  Max targets:  ${opts.maxTargets} (${opts.sectors} sectors, ${opts.perSector}/sector)`);
  console.log('');

  // Phase 1: Read metadata
  const photos = readAllMetadata(opts.metadata);

  // Phase 2: Assign to projects
  const { assignments, projectPhotos } = assignToProjects(photos, PROJECTS, opts);

  // Phase 3: Sequence
  const sequences = sequenceAllProjects(PROJECTS, projectPhotos, photos);

  // Phase 4: UUIDs
  const { projectUUIDs, photoUUIDs, photoDisplayNames } = generateUUIDs(PROJECTS, sequences);

  // Phase 5: Adaptive spatial analysis (skipped when --skip-targets)
  const spatialTargets = opts.skipTargets
    ? (console.log('[Phase 5/7] Skipping spatial analysis (--skip-targets).'), new Map())
    : adaptiveSpatialAnalysis(photos, photoUUIDs, opts, assignments, PROJECTS);

  // Phase 6: Populate metadata + targets in index.db
  const indexDb = populateMetadata(opts, photos, PROJECTS, sequences, projectUUIDs, photoUUIDs, photoDisplayNames, spatialTargets);

  try {
    // Phase 7: Process images into per-project databases
    await processImages(opts, PROJECTS, sequences, photoUUIDs, indexDb);
  } finally {
    indexDb.close();
  }
  console.log('  Database finalized.');

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n=== Migration complete in ${elapsed}s ===`);
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
