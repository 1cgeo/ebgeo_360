/**
 * @module tests/helpers/test-db
 * @description Creates temporary SQLite databases with seed data for testing.
 * Uses better-sqlite3 directly — does NOT import any src/ modules at top level
 * to avoid triggering the config.js / connection.js singleton chain.
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const SRC_DB_DIR = resolve(__dirname, '..', '..', 'src', 'db');

// ============================================================================
// SEED CONSTANTS (exported for assertions in test files)
// ============================================================================

export const SEEDS = {
  PROJECT_ID: '00000000-0000-4000-a000-000000000001',
  PROJECT_SLUG: 'test-project',
  PROJECT_NAME: 'Test Project',
  DB_FILENAME: 'test-project.db',

  PHOTO_1_ID: '00000000-0000-4000-a000-000000000010',
  PHOTO_1_ORIGINAL_NAME: 'IMG_001.jpg',
  PHOTO_1_DISPLAY_NAME: 'Photo 001',
  PHOTO_1_LAT: -29.75,
  PHOTO_1_LON: -55.78,
  PHOTO_1_ELE: 120.5,
  PHOTO_1_HEADING: 90.0,
  PHOTO_1_CAMERA_HEIGHT: 1.65,
  PHOTO_1_MESH_ROTATION_Y: 180.0,

  PHOTO_2_ID: '00000000-0000-4000-a000-000000000020',
  PHOTO_2_ORIGINAL_NAME: 'IMG_002.jpg',
  PHOTO_2_DISPLAY_NAME: 'Photo 002',
  PHOTO_2_LAT: -29.7501,
  PHOTO_2_LON: -55.7801,
  PHOTO_2_ELE: 121.0,
  PHOTO_2_HEADING: 270.0,
  PHOTO_2_CAMERA_HEIGHT: 1.65,
  PHOTO_2_MESH_ROTATION_Y: 180.0,

  // Target PHOTO_1 → PHOTO_2: has override
  TARGET_1_TO_2_DISTANCE: 15.3,
  TARGET_1_TO_2_BEARING: 45.0,
  TARGET_1_TO_2_OVERRIDE_BEARING: 45.0,
  TARGET_1_TO_2_OVERRIDE_DISTANCE: 5.0,

  // Photo 3: nearby but NOT connected as a target
  PHOTO_3_ID: '00000000-0000-4000-a000-000000000030',
  PHOTO_3_ORIGINAL_NAME: 'IMG_003.jpg',
  PHOTO_3_DISPLAY_NAME: 'Photo 003',
  PHOTO_3_LAT: -29.7502,
  PHOTO_3_LON: -55.7802,
  PHOTO_3_ELE: 119.0,
  PHOTO_3_HEADING: 180.0,
  PHOTO_3_CAMERA_HEIGHT: 1.65,
  PHOTO_3_MESH_ROTATION_Y: 180.0,

  // Target PHOTO_2 → PHOTO_1: no override
  TARGET_2_TO_1_DISTANCE: 15.3,
  TARGET_2_TO_1_BEARING: 225.0,

  // Fake image blobs
  FULL_BLOB: Buffer.from('fake-full-webp-image-data'),
  PREVIEW_BLOB: Buffer.from('fake-preview-webp-data'),
};

// ============================================================================
// SETUP
// ============================================================================

/**
 * Creates a temporary directory with seeded index.db and project DB.
 * @returns {{ dataDir: string }} Path to temp data directory
 */
export function createTestData() {
  const dataDir = mkdtempSync(join(tmpdir(), 'sv-test-'));
  const projectsDir = join(dataDir, 'projects');
  mkdirSync(projectsDir, { recursive: true });

  // Create index.db
  const indexDbPath = join(dataDir, 'index.db');
  const indexSchema = readFileSync(join(SRC_DB_DIR, 'schema.sql'), 'utf-8');
  const indexDb = new Database(indexDbPath);
  indexDb.pragma('journal_mode = WAL');
  indexDb.exec(indexSchema);
  seedIndexDb(indexDb);
  indexDb.close();

  // Create project DB
  const projectDbPath = join(projectsDir, SEEDS.DB_FILENAME);
  const projectSchema = readFileSync(join(SRC_DB_DIR, 'project-schema.sql'), 'utf-8');
  const projectDb = new Database(projectDbPath);
  projectDb.pragma('page_size = 65536');
  projectDb.pragma('journal_mode = WAL');
  projectDb.exec(projectSchema);
  seedProjectDb(projectDb);
  projectDb.close();

  return { dataDir };
}

/**
 * Cleans up test data: closes all service DB connections, removes temp directory.
 * Must be called in after() hook.
 * @param {string} dataDir - Path returned by createTestData
 */
export async function destroyTestData(dataDir) {
  // Dynamic imports to avoid top-level chain
  const { closeAll } = await import('../../src/db/connection.js');
  const { resetStatements } = await import('../../src/db/queries.js');

  closeAll();
  resetStatements();

  rmSync(dataDir, { recursive: true, force: true });
}

// ============================================================================
// SEED HELPERS
// ============================================================================

function seedIndexDb(db) {
  // Insert project
  db.prepare(`
    INSERT INTO projects (id, slug, name, description, capture_date, location,
                          center_lat, center_lon, entry_photo_id, photo_count, db_filename)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    SEEDS.PROJECT_ID, SEEDS.PROJECT_SLUG, SEEDS.PROJECT_NAME,
    'A test project', '2024-01-15', 'Test Location',
    SEEDS.PHOTO_1_LAT, SEEDS.PHOTO_1_LON,
    SEEDS.PHOTO_1_ID, 3, SEEDS.DB_FILENAME,
  );

  // Insert photos
  const insertPhoto = db.prepare(`
    INSERT INTO photos (id, project_id, original_name, display_name, sequence_number,
                        lat, lon, ele, heading, camera_height, mesh_rotation_y, floor_level,
                        full_size_bytes, preview_size_bytes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertPhoto.run(
    SEEDS.PHOTO_1_ID, SEEDS.PROJECT_ID,
    SEEDS.PHOTO_1_ORIGINAL_NAME, SEEDS.PHOTO_1_DISPLAY_NAME, 1,
    SEEDS.PHOTO_1_LAT, SEEDS.PHOTO_1_LON, SEEDS.PHOTO_1_ELE,
    SEEDS.PHOTO_1_HEADING, SEEDS.PHOTO_1_CAMERA_HEIGHT,
    SEEDS.PHOTO_1_MESH_ROTATION_Y, 1,
    SEEDS.FULL_BLOB.length, SEEDS.PREVIEW_BLOB.length,
  );

  insertPhoto.run(
    SEEDS.PHOTO_2_ID, SEEDS.PROJECT_ID,
    SEEDS.PHOTO_2_ORIGINAL_NAME, SEEDS.PHOTO_2_DISPLAY_NAME, 2,
    SEEDS.PHOTO_2_LAT, SEEDS.PHOTO_2_LON, SEEDS.PHOTO_2_ELE,
    SEEDS.PHOTO_2_HEADING, SEEDS.PHOTO_2_CAMERA_HEIGHT,
    SEEDS.PHOTO_2_MESH_ROTATION_Y, 1,
    SEEDS.FULL_BLOB.length, SEEDS.PREVIEW_BLOB.length,
  );

  insertPhoto.run(
    SEEDS.PHOTO_3_ID, SEEDS.PROJECT_ID,
    SEEDS.PHOTO_3_ORIGINAL_NAME, SEEDS.PHOTO_3_DISPLAY_NAME, 3,
    SEEDS.PHOTO_3_LAT, SEEDS.PHOTO_3_LON, SEEDS.PHOTO_3_ELE,
    SEEDS.PHOTO_3_HEADING, SEEDS.PHOTO_3_CAMERA_HEIGHT,
    SEEDS.PHOTO_3_MESH_ROTATION_Y, 1,
    SEEDS.FULL_BLOB.length, SEEDS.PREVIEW_BLOB.length,
  );

  // Insert photos_rowid (for R-tree mapping)
  const insertRowid = db.prepare(`
    INSERT INTO photos_rowid (photo_id) VALUES (?)
  `);
  insertRowid.run(SEEDS.PHOTO_1_ID);
  insertRowid.run(SEEDS.PHOTO_2_ID);
  insertRowid.run(SEEDS.PHOTO_3_ID);

  // Insert photos_rtree (spatial index)
  const insertRtree = db.prepare(`
    INSERT INTO photos_rtree (rowid_id, min_lon, max_lon, min_lat, max_lat)
    SELECT pr.rowid_id, p.lon, p.lon, p.lat, p.lat
    FROM photos_rowid pr
    JOIN photos p ON p.id = pr.photo_id
    WHERE pr.photo_id = ?
  `);
  insertRtree.run(SEEDS.PHOTO_1_ID);
  insertRtree.run(SEEDS.PHOTO_2_ID);
  insertRtree.run(SEEDS.PHOTO_3_ID);

  // Insert targets (bidirectional)
  const insertTarget = db.prepare(`
    INSERT INTO targets (source_id, target_id, distance_m, bearing_deg, is_next, is_original,
                         override_bearing, override_distance)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // PHOTO_1 → PHOTO_2 (with override, is_next = 1)
  insertTarget.run(
    SEEDS.PHOTO_1_ID, SEEDS.PHOTO_2_ID,
    SEEDS.TARGET_1_TO_2_DISTANCE, SEEDS.TARGET_1_TO_2_BEARING,
    1, 1,
    SEEDS.TARGET_1_TO_2_OVERRIDE_BEARING, SEEDS.TARGET_1_TO_2_OVERRIDE_DISTANCE,
  );

  // PHOTO_2 → PHOTO_1 (no override, is_next = 0)
  insertTarget.run(
    SEEDS.PHOTO_2_ID, SEEDS.PHOTO_1_ID,
    SEEDS.TARGET_2_TO_1_DISTANCE, SEEDS.TARGET_2_TO_1_BEARING,
    0, 1,
    null, null,
  );
}

function seedProjectDb(db) {
  const insertImage = db.prepare(`
    INSERT INTO images (photo_id, full_webp, preview_webp)
    VALUES (?, ?, ?)
  `);

  insertImage.run(SEEDS.PHOTO_1_ID, SEEDS.FULL_BLOB, SEEDS.PREVIEW_BLOB);
  insertImage.run(SEEDS.PHOTO_2_ID, SEEDS.FULL_BLOB, SEEDS.PREVIEW_BLOB);
  insertImage.run(SEEDS.PHOTO_3_ID, SEEDS.FULL_BLOB, SEEDS.PREVIEW_BLOB);
}
