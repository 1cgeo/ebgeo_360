#!/usr/bin/env node

/**
 * @module scripts/estimate-slope-roll
 * @description Estimates mesh_rotation_z (roll) correction for each photo based on
 * terrain slope computed from elevation data of the "next" target in the sequence.
 *
 * When a vehicle drives uphill, the camera tilts backward, causing the horizon to
 * appear lower in the panorama. A positive mesh_rotation_z rolls the panorama sphere
 * to compensate, bringing the horizon back to center.
 *
 * The slope angle is computed as:
 *   θ = atan2(ΔE, d)
 * where ΔE = ele_next − ele_camera and d = horizontal distance to next.
 *
 * Only photos with both camera and next-target elevation data are updated.
 * Photos without a next target or without elevation data are left unchanged.
 *
 * Usage:
 *   node scripts/estimate-slope-roll.js --data <DATA_DIR> [options]
 *
 * Options:
 *   --dry-run        Show results without modifying the database
 *   --max-angle <N>  Clamp correction to ±N degrees (default: 15)
 *   --project <slug> Only process a single project
 *   --clear          Reset mesh_rotation_z to 0 for all affected photos (undo)
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
    dryRun: false,
    maxAngle: 15,     // clamp to ±15°
    project: null,    // optional: only process one project
    clear: false,     // reset to 0
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--data': opts.data = resolve(args[++i]); break;
      case '--dry-run': opts.dryRun = true; break;
      case '--max-angle': opts.maxAngle = parseFloat(args[++i]); break;
      case '--project': opts.project = args[++i]; break;
      case '--clear': opts.clear = true; break;
    }
  }

  if (!opts.data) {
    console.error('Usage: node scripts/estimate-slope-roll.js --data <DATA_DIR> [--dry-run] [--max-angle N] [--project <slug>] [--clear]');
    process.exit(1);
  }

  return opts;
}

// ============================================================
// Constants
// ============================================================

const RAD_TO_DEG = 180 / Math.PI;

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

  console.log('=== Estimate Slope Roll (mesh_rotation_z from elevation) ===');
  console.log(`  Data dir:    ${opts.data}`);
  console.log(`  Max angle:   ±${opts.maxAngle}°`);
  console.log(`  Project:     ${opts.project ?? 'all'}`);
  console.log(`  Clear mode:  ${opts.clear}`);
  console.log(`  Dry run:     ${opts.dryRun}`);
  console.log('');

  const db = new Database(indexDbPath);
  db.pragma('journal_mode = WAL');

  // Get projects to process
  let projects;
  if (opts.project) {
    projects = db.prepare('SELECT id, slug, name, photo_count FROM projects WHERE slug = ?').all(opts.project);
    if (projects.length === 0) {
      console.error(`Project not found: ${opts.project}`);
      process.exit(1);
    }
  } else {
    projects = db.prepare('SELECT id, slug, name, photo_count FROM projects ORDER BY name').all();
  }

  // Query: for each photo, get its elevation and the next target's elevation + distance
  const getPhotosWithNext = db.prepare(`
    SELECT
      p.id,
      p.display_name,
      p.ele AS cam_ele,
      p.mesh_rotation_z AS current_z,
      t_next.ele AS next_ele,
      tgt.distance_m AS next_dist
    FROM photos p
    LEFT JOIN targets tgt ON tgt.source_id = p.id AND tgt.is_next = 1
    LEFT JOIN photos t_next ON t_next.id = tgt.target_id
    WHERE p.project_id = ?
    ORDER BY p.sequence_number
  `);

  const updateRotZ = db.prepare('UPDATE photos SET mesh_rotation_z = ? WHERE id = ?');

  console.log('Project                   | Photos | With Ele | Updated | Avg Slope | Max Slope');
  console.log('--------------------------|--------|----------|---------|-----------|----------');

  let totalPhotos = 0;
  let totalWithEle = 0;
  let totalUpdated = 0;

  for (const project of projects) {
    const rows = getPhotosWithNext.all(project.id);
    let withEle = 0;
    let updated = 0;
    let sumAbsSlope = 0;
    let maxAbsSlope = 0;

    const updates = []; // {id, newZ, displayName, slopeDeg}

    for (const row of rows) {
      if (opts.clear) {
        // Clear mode: reset to 0 if currently non-zero
        if (row.current_z !== 0) {
          updates.push({ id: row.id, newZ: 0, displayName: row.display_name, slopeDeg: 0 });
          updated++;
        }
        continue;
      }

      // Skip if missing elevation data on either end
      if (row.cam_ele == null || row.next_ele == null || row.next_dist == null) {
        continue;
      }

      // Skip if distance is too small (same spot, unreliable angle)
      if (row.next_dist < 1) {
        continue;
      }

      withEle++;

      // Compute slope angle: positive = uphill (next is higher)
      const deltaEle = row.next_ele - row.cam_ele;
      const slopeRad = Math.atan2(deltaEle, row.next_dist);
      const slopeDeg = slopeRad * RAD_TO_DEG;

      // Discard outliers: slopes beyond maxAngle are GPS noise, not real inclines.
      // Leave mesh_rotation_z at 0 for these photos.
      if (Math.abs(slopeDeg) > opts.maxAngle) {
        continue;
      }

      // Round to 1 decimal for clean values
      const newZ = Math.round(slopeDeg * 10) / 10;

      sumAbsSlope += Math.abs(slopeDeg);
      maxAbsSlope = Math.max(maxAbsSlope, Math.abs(slopeDeg));

      // Only update if the value is changing
      const currentRounded = Math.round(row.current_z * 10) / 10;
      if (newZ !== currentRounded) {
        updates.push({ id: row.id, newZ, displayName: row.display_name, slopeDeg });
        updated++;
      }
    }

    // Apply updates
    if (!opts.dryRun && updates.length > 0) {
      db.transaction(() => {
        for (const u of updates) {
          updateRotZ.run(u.newZ, u.id);
        }
      })();
    }

    totalPhotos += rows.length;
    totalWithEle += withEle;
    totalUpdated += updated;

    const avgSlope = withEle > 0 ? (sumAbsSlope / withEle).toFixed(1) : 'N/A';
    const maxSlope = withEle > 0 ? maxAbsSlope.toFixed(1) : 'N/A';

    console.log(
      `${project.slug.padEnd(25)} | ` +
      `${String(rows.length).padStart(6)} | ` +
      `${String(withEle).padStart(8)} | ` +
      `${String(updated).padStart(7)} | ` +
      `${String(avgSlope + '°').padStart(9)} | ` +
      `${String(maxSlope + '°').padStart(9)}`
    );

    // In dry-run mode with a single project, show per-photo details
    if (opts.dryRun && opts.project && updates.length > 0) {
      console.log('');
      console.log('  Detail (changes only):');
      console.log('  Photo                          | Current Z | New Z   | Slope');
      console.log('  -------------------------------|-----------|---------|------');
      for (const u of updates.slice(0, 50)) {
        console.log(
          `  ${u.displayName.padEnd(30)} | ` +
          `${String(u.slopeDeg.toFixed(1) + '°').padStart(9)} | ` +
          `${String(u.newZ.toFixed(1) + '°').padStart(7)} | ` +
          `${String(u.slopeDeg.toFixed(2) + '°').padStart(7)}`
        );
      }
      if (updates.length > 50) {
        console.log(`  ... and ${updates.length - 50} more`);
      }
      console.log('');
    }
  }

  console.log('--------------------------|--------|----------|---------|-----------|----------');
  console.log(
    `${'TOTAL'.padEnd(25)} | ` +
    `${String(totalPhotos).padStart(6)} | ` +
    `${String(totalWithEle).padStart(8)} | ` +
    `${String(totalUpdated).padStart(7)} | ` +
    `${''.padStart(9)} | ` +
    `${''.padStart(9)}`
  );

  db.close();

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n=== ${opts.dryRun ? 'Dry run' : opts.clear ? 'Clear' : 'Estimation'} complete in ${elapsed}s ===`);
  if (opts.dryRun) {
    console.log('(No changes written — use without --dry-run to apply)');
  }
}

main();
