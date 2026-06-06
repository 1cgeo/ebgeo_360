#!/usr/bin/env node

/**
 * @module scripts/recalculate-targets
 * @description Recalculates spatial targets per project using adaptive radius
 * based on median nearest-neighbor distance. Preserves original targets from
 * metadata and any calibration overrides.
 *
 * The algorithm divides the space around each photo into angular sectors and
 * picks the closest candidates per sector. This allows multiple targets along
 * a road (same general direction at different distances) while still providing
 * good directional coverage.
 *
 * Usage:
 *   node scripts/recalculate-targets.js --data <DATA_DIR> [options]
 *
 * Options:
 *   --multiplier <N>       Radius = median_nn_dist * N (default: 5)
 *   --max-targets <N>      Max spatial targets per photo (default: 6)
 *   --sectors <N>          Number of angular sectors (default: 4)
 *   --per-sector <N>       Max targets per sector (default: 3)
 *   --dry-run              Show results without modifying the database
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';

// ============================================================
// CLI Arguments
// ============================================================

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    data: null,
    multiplier: 5,       // radius = median_nn_dist * multiplier
    maxTargets: 6,       // max total spatial targets per photo
    sectors: 4,          // number of angular sectors (360/4 = 90° each)
    perSector: 3,        // max targets per sector (closest N within that sector)
    dryRun: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--data': opts.data = resolve(args[++i]); break;
      case '--multiplier': opts.multiplier = parseFloat(args[++i]); break;
      case '--max-targets': opts.maxTargets = parseInt(args[++i], 10); break;
      case '--sectors': opts.sectors = parseInt(args[++i], 10); break;
      case '--per-sector': opts.perSector = parseInt(args[++i], 10); break;
      case '--dry-run': opts.dryRun = true; break;
    }
  }

  if (!opts.data) {
    console.error('Usage: node scripts/recalculate-targets.js --data <DATA_DIR> [--multiplier N] [--max-targets N] [--sectors N] [--per-sector N] [--dry-run]');
    process.exit(1);
  }

  return opts;
}

// ============================================================
// Geo utilities
// ============================================================

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;
const EARTH_RADIUS = 6371000;

function haversine(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * DEG_TO_RAD;
  const dLon = (lon2 - lon1) * DEG_TO_RAD;
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * DEG_TO_RAD) * Math.cos(lat2 * DEG_TO_RAD) *
            Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function calcBearing(lat1, lon1, lat2, lon2) {
  const dLon = (lon2 - lon1) * DEG_TO_RAD;
  const y = Math.sin(dLon) * Math.cos(lat2 * DEG_TO_RAD);
  const x = Math.cos(lat1 * DEG_TO_RAD) * Math.sin(lat2 * DEG_TO_RAD) -
            Math.sin(lat1 * DEG_TO_RAD) * Math.cos(lat2 * DEG_TO_RAD) * Math.cos(dLon);
  return ((Math.atan2(y, x) * RAD_TO_DEG) + 360) % 360;
}

// ============================================================
// Compute median nearest-neighbor distance for a set of photos
// ============================================================

function computeMedianNearestDist(photos) {
  if (photos.length < 2) return null;

  const CELL_SIZE = 0.001;
  const grid = new Map();

  for (const p of photos) {
    const key = `${Math.floor(p.lat / CELL_SIZE)},${Math.floor(p.lon / CELL_SIZE)}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(p);
  }

  // Extensao da grade em celulas, usada para limitar a expansao do anel de busca.
  let minCellLat = Infinity, maxCellLat = -Infinity;
  let minCellLon = Infinity, maxCellLon = -Infinity;
  for (const p of photos) {
    const cl = Math.floor(p.lat / CELL_SIZE);
    const cn = Math.floor(p.lon / CELL_SIZE);
    if (cl < minCellLat) minCellLat = cl;
    if (cl > maxCellLat) maxCellLat = cl;
    if (cn < minCellLon) minCellLon = cn;
    if (cn > maxCellLon) maxCellLon = cn;
  }
  const maxRing = Math.max(maxCellLat - minCellLat, maxCellLon - minCellLon);

  const nearestDists = [];

  for (const photo of photos) {
    const cellLat = Math.floor(photo.lat / CELL_SIZE);
    const cellLon = Math.floor(photo.lon / CELL_SIZE);
    let minDist = Infinity;

    // Anel 1 = vizinhanca 3x3, identica ao original (mesmo resultado no caso denso).
    for (let dlat = -1; dlat <= 1; dlat++) {
      for (let dlon = -1; dlon <= 1; dlon++) {
        const cell = grid.get(`${cellLat + dlat},${cellLon + dlon}`);
        if (!cell) continue;
        for (const c of cell) {
          if (c.id === photo.id) continue;
          const d = haversine(photo.lat, photo.lon, c.lat, c.lon);
          if (d < minDist) minDist = d;
        }
      }
    }

    // Caso esparso: 3x3 vazio. O original fazia um full-scan O(n^2) para obter o
    // vizinho mais proximo REAL. Reproduzimos o MESMO resultado expandindo aneis
    // (anel 2, 3, ...) visitando so a borda de cada anel, com parada por cota
    // inferior exata. A cota usa a escala de longitude (cos(lat), menor
    // metros/celula) — conservadora, nunca para antes de cobrir um vizinho mais
    // proximo. Evita o O(n^2) mas converge ao mesmo minimo global.
    if (minDist === Infinity) {
      const metersPerCellLB = CELL_SIZE * EARTH_RADIUS * DEG_TO_RAD *
        Math.abs(Math.cos(photo.lat * DEG_TO_RAD));

      for (let ring = 2; ring <= maxRing + 1; ring++) {
        // Distancia minima possivel a uma celula a `ring` celulas = (ring-1) lacunas.
        if (minDist < Infinity && (ring - 1) * metersPerCellLB > minDist) break;
        for (let dlat = -ring; dlat <= ring; dlat++) {
          for (let dlon = -ring; dlon <= ring; dlon++) {
            // So a borda do anel atual; as celulas internas ja foram vistas.
            if (Math.abs(dlat) !== ring && Math.abs(dlon) !== ring) continue;
            const cell = grid.get(`${cellLat + dlat},${cellLon + dlon}`);
            if (!cell) continue;
            for (const c of cell) {
              if (c.id === photo.id) continue;
              const d = haversine(photo.lat, photo.lon, c.lat, c.lon);
              if (d < minDist) minDist = d;
            }
          }
        }
      }
    }

    if (minDist < Infinity) nearestDists.push(minDist);
  }

  nearestDists.sort((a, b) => a - b);
  return nearestDists[Math.floor(nearestDists.length / 2)];
}

// ============================================================
// Build spatial grid for candidate search
// ============================================================

function buildGrid(photos, radius) {
  // Tamanho da celula em graus de LATITUDE: deve cobrir raio + margem para que a
  // busca de vizinhos fique dentro de um anel de 1 celula.
  const cellLatDeg = Math.max(0.001, (radius / EARTH_RADIUS) * RAD_TO_DEG * 1.2);

  // Um grau de LONGITUDE cobre cos(lat) menos distancia de solo. Sem corrigir,
  // o anel de 1 celula sub-cobre o raio na direcao E/O em latitudes altas.
  // Escala a celula de longitude por 1/cos(lat) usando a latitude media do projeto.
  let latSum = 0;
  for (const p of photos) latSum += p.lat;
  const refLat = photos.length > 0 ? latSum / photos.length : 0;
  const cosLat = Math.max(Math.cos(refLat * DEG_TO_RAD), 1e-6);
  const cellLonDeg = cellLatDeg / cosLat;

  const grid = new Map();

  for (const p of photos) {
    const key = `${Math.floor(p.lat / cellLatDeg)},${Math.floor(p.lon / cellLonDeg)}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(p);
  }

  return { grid, cellLatDeg, cellLonDeg };
}

// ============================================================
// Generate spatial targets for a project
// ============================================================

function generateSpatialTargets(photos, originalTargets, radius, opts) {
  const { grid, cellLatDeg, cellLonDeg } = buildGrid(photos, radius);
  const sectorSize = 360 / opts.sectors;

  // Build lookup: photoId -> [{targetId, bearing}]
  const origTargetMap = new Map();
  for (const t of originalTargets) {
    if (!origTargetMap.has(t.source_id)) origTargetMap.set(t.source_id, []);
    origTargetMap.get(t.source_id).push({ targetId: t.target_id, bearing: t.bearing_deg });
  }

  const newTargets = [];

  for (const photo of photos) {
    const existing = origTargetMap.get(photo.id) || [];
    const existingTargetIds = new Set(existing.map(e => e.targetId));

    // Count existing original targets per sector
    const sectorCounts = new Array(opts.sectors).fill(0);
    for (const e of existing) {
      const sector = Math.floor(e.bearing / sectorSize) % opts.sectors;
      sectorCounts[sector]++;
    }

    // Find candidates within radius
    const cellLat = Math.floor(photo.lat / cellLatDeg);
    const cellLon = Math.floor(photo.lon / cellLonDeg);
    const candidates = [];

    for (let dlat = -1; dlat <= 1; dlat++) {
      for (let dlon = -1; dlon <= 1; dlon++) {
        const cell = grid.get(`${cellLat + dlat},${cellLon + dlon}`);
        if (!cell) continue;

        for (const c of cell) {
          if (c.id === photo.id) continue;
          if (existingTargetIds.has(c.id)) continue;

          const dist = haversine(photo.lat, photo.lon, c.lat, c.lon);
          if (dist > radius) continue;

          const bear = calcBearing(photo.lat, photo.lon, c.lat, c.lon);
          const sector = Math.floor(bear / sectorSize) % opts.sectors;

          candidates.push({ targetId: c.id, distance: dist, bearing: bear, sector });
        }
      }
    }

    // Sort by distance (closest first)
    candidates.sort((a, b) => a.distance - b.distance);

    // Greedy selection: pick closest candidates per sector
    const addedSectorCounts = [...sectorCounts];
    let addedCount = 0;

    for (const c of candidates) {
      if (addedCount >= opts.maxTargets) break;
      if (addedSectorCounts[c.sector] >= opts.perSector) continue;

      newTargets.push({
        sourceId: photo.id,
        targetId: c.targetId,
        distance: c.distance,
        bearing: c.bearing,
      });
      addedSectorCounts[c.sector]++;
      addedCount++;
    }
  }

  return newTargets;
}

// ============================================================
// Main
// ============================================================

function main() {
  const opts = parseArgs();
  const startTime = Date.now();

  const indexDbPath = resolve(opts.data, 'index.db');
  if (!existsSync(indexDbPath)) {
    console.error(`index.db not found at: ${indexDbPath}`);
    process.exit(1);
  }

  console.log('=== Recalculate Targets (per-project adaptive radius) ===');
  console.log(`  Data dir:        ${opts.data}`);
  console.log(`  Multiplier:      ${opts.multiplier}x median NN distance`);
  console.log(`  Max targets:     ${opts.maxTargets}`);
  console.log(`  Sectors:         ${opts.sectors} (${(360 / opts.sectors).toFixed(0)}° each)`);
  console.log(`  Per sector:      ${opts.perSector}`);
  console.log(`  Dry run:         ${opts.dryRun}`);
  console.log('');

  const db = new Database(indexDbPath);
  db.pragma('journal_mode = WAL');

  try {
    const projects = db.prepare('SELECT id, slug, name, photo_count FROM projects ORDER BY name').all();

    // Statements de COUNT preparados uma unica vez e reutilizados no loop.
    const countSpatialStmt = db.prepare(
      'SELECT COUNT(*) as c FROM targets t JOIN photos ph ON ph.id = t.source_id WHERE ph.project_id = ? AND t.is_original = 0'
    );
    const countOriginalStmt = db.prepare(
      'SELECT COUNT(*) as c FROM targets t JOIN photos ph ON ph.id = t.source_id WHERE ph.project_id = ? AND t.is_original = 1'
    );

    // Detect projects that should be skipped (have original targets but no spatial ones).
    // O spatial count e calculado uma vez por projeto e reaproveitado no loop principal.
    const skipSlugs = new Set();
    const spatialCountByProject = new Map();
    for (const p of projects) {
      const spatialCount = countSpatialStmt.get(p.id).c;
      const originalCount = countOriginalStmt.get(p.id).c;
      spatialCountByProject.set(p.id, spatialCount);
      if (spatialCount === 0 && originalCount > 0) {
        skipSlugs.add(p.slug);
      }
    }

    if (skipSlugs.size > 0) {
      console.log(`Skipping (no spatial targets exist): ${[...skipSlugs].join(', ')}`);
      console.log('');
    }

    const deleteSpatialTargets = db.prepare(
      'DELETE FROM targets WHERE is_original = 0 AND source_id IN (SELECT id FROM photos WHERE project_id = ?)'
    );

    const insertTarget = db.prepare(
      'INSERT OR IGNORE INTO targets (source_id, target_id, distance_m, bearing_deg, is_next, is_original) VALUES (?, ?, ?, ?, 0, 0)'
    );

    const getOriginalTargets = db.prepare(
      'SELECT t.source_id, t.target_id, t.bearing_deg FROM targets t JOIN photos ph ON ph.id = t.source_id WHERE ph.project_id = ? AND t.is_original = 1'
    );

    console.log('Project                   | Photos | Median NN (m) | Radius (m) | Old Spatial | New Spatial | Avg/Photo');
    console.log('--------------------------|--------|---------------|------------|-------------|-------------|----------');

    let totalOldSpatial = 0;
    let totalNewSpatial = 0;

    for (const p of projects) {
      if (skipSlugs.has(p.slug)) continue;

      const photos = db.prepare('SELECT id, lat, lon FROM photos WHERE project_id = ?').all(p.id);

      if (photos.length < 2) {
        console.log(
          `${p.slug.padEnd(25)} | ${String(photos.length).padStart(6)} | ` +
          `${'N/A'.padStart(13)} | ${'N/A'.padStart(10)} | ` +
          `${'N/A'.padStart(11)} | ${'N/A'.padStart(11)} | ${'N/A'.padStart(9)}`
        );
        continue;
      }

      const medianNN = computeMedianNearestDist(photos);
      const radius = Math.round(medianNN * opts.multiplier);

      // Reaproveita o spatial count ja computado na deteccao de skip.
      const oldSpatialCount = spatialCountByProject.get(p.id) ?? 0;

      const originalTargets = getOriginalTargets.all(p.id);
      const newTargets = generateSpatialTargets(photos, originalTargets, radius, opts);

      if (!opts.dryRun) {
        db.transaction(() => {
          deleteSpatialTargets.run(p.id);
          for (const t of newTargets) {
            insertTarget.run(t.sourceId, t.targetId, t.distance, t.bearing);
          }
        })();
      }

      totalOldSpatial += oldSpatialCount;
      totalNewSpatial += newTargets.length;

      const avgPerPhoto = photos.length > 0 ? (newTargets.length / photos.length).toFixed(1) : '0';

      console.log(
        `${p.slug.padEnd(25)} | ` +
        `${String(photos.length).padStart(6)} | ` +
        `${medianNN.toFixed(1).padStart(13)} | ` +
        `${String(radius).padStart(10)} | ` +
        `${String(oldSpatialCount).padStart(11)} | ` +
        `${String(newTargets.length).padStart(11)} | ` +
        `${avgPerPhoto.padStart(9)}`
      );
    }

    console.log('--------------------------|--------|---------------|------------|-------------|-------------|----------');
    console.log(
      `${'TOTAL'.padEnd(25)} | ` +
      `${''.padStart(6)} | ` +
      `${''.padStart(13)} | ` +
      `${''.padStart(10)} | ` +
      `${String(totalOldSpatial).padStart(11)} | ` +
      `${String(totalNewSpatial).padStart(11)} | ` +
      `${''.padStart(9)}`
    );
  } finally {
    db.close();
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n=== ${opts.dryRun ? 'Dry run' : 'Recalculation'} complete in ${elapsed}s ===`);
}

main();
