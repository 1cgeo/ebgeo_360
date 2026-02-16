/**
 * @module db/connection
 * @description Manages SQLite connections to index.db and per-project image databases.
 * Uses better-sqlite3 synchronous API for optimal read performance.
 */

import Database from 'better-sqlite3';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import config from '../config.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

// Singleton connections
let indexDb = null;
const projectDbs = new Map();

/**
 * Opens and initializes the central index database.
 * @returns {Database} The index database connection.
 */
export function getIndexDb() {
  if (indexDb) return indexDb;

  if (!existsSync(config.dataDir)) {
    mkdirSync(config.dataDir, { recursive: true });
  }

  indexDb = new Database(config.indexDbPath);
  indexDb.pragma('journal_mode = WAL');
  indexDb.pragma('synchronous = NORMAL');
  indexDb.pragma('cache_size = -64000'); // 64 MB cache

  // Initialize schema
  const schema = readFileSync(resolve(__dirname, 'schema.sql'), 'utf-8');
  indexDb.exec(schema);

  // Migrate: add columns if missing (for existing DBs)
  const cols = indexDb.pragma('table_info(photos)');
  if (!cols.some(c => c.name === 'calibration_reviewed')) {
    indexDb.exec('ALTER TABLE photos ADD COLUMN calibration_reviewed INTEGER DEFAULT 0');
  }
  if (!cols.some(c => c.name === 'mesh_rotation_x')) {
    indexDb.exec('ALTER TABLE photos ADD COLUMN mesh_rotation_x REAL DEFAULT 0');
  }
  if (!cols.some(c => c.name === 'mesh_rotation_z')) {
    indexDb.exec('ALTER TABLE photos ADD COLUMN mesh_rotation_z REAL DEFAULT 0');
  }
  if (!cols.some(c => c.name === 'distance_scale')) {
    indexDb.exec('ALTER TABLE photos ADD COLUMN distance_scale REAL DEFAULT 1.0');
  }
  if (!cols.some(c => c.name === 'marker_scale')) {
    indexDb.exec('ALTER TABLE photos ADD COLUMN marker_scale REAL DEFAULT 1.0');
  }

  // Migrate: rename override columns in targets table
  const targetCols = indexDb.pragma('table_info(targets)');
  if (targetCols.some(c => c.name === 'override_heading') && !targetCols.some(c => c.name === 'override_bearing')) {
    indexDb.exec('ALTER TABLE targets RENAME COLUMN override_heading TO override_bearing');
    indexDb.exec('ALTER TABLE targets RENAME COLUMN override_pitch TO override_distance');
    // Fix old override_pitch=0 values (angle 0°) → valid distance default (5m)
    indexDb.exec('UPDATE targets SET override_distance = 5 WHERE override_distance IS NOT NULL AND override_distance < 0.5');
  }

  // Migrate: add hidden column to targets table
  const targetCols2 = indexDb.pragma('table_info(targets)');
  if (!targetCols2.some(c => c.name === 'hidden')) {
    indexDb.exec('ALTER TABLE targets ADD COLUMN hidden INTEGER DEFAULT 0');
  }

  return indexDb;
}

/**
 * Opens a per-project image database (lazy, cached).
 * @param {string} dbFilename - The database filename (e.g., "alegrete.db").
 * @returns {Database} The project database connection.
 */
export function getProjectDb(dbFilename) {
  if (projectDbs.has(dbFilename)) {
    return projectDbs.get(dbFilename);
  }

  const dbPath = join(config.projectsDbDir, dbFilename);
  if (!existsSync(dbPath)) {
    return null;
  }

  const db = new Database(dbPath, { readonly: true });
  db.pragma('journal_mode = WAL');
  db.pragma('cache_size = -32000'); // 32 MB cache per project DB

  projectDbs.set(dbFilename, db);
  return db;
}

/**
 * Creates a new per-project image database with optimized page size.
 * Used during migration only.
 * @param {string} dbFilename - The database filename.
 * @returns {Database} The new project database connection.
 */
export function createProjectDb(dbFilename) {
  if (!existsSync(config.projectsDbDir)) {
    mkdirSync(config.projectsDbDir, { recursive: true });
  }

  const dbPath = join(config.projectsDbDir, dbFilename);
  const db = new Database(dbPath);

  // 64 KB page size optimizes BLOB reads via sqlite3_blob_open
  db.pragma('page_size = 65536');
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  // Initialize schema
  const schema = readFileSync(resolve(__dirname, 'project-schema.sql'), 'utf-8');
  db.exec(schema);

  projectDbs.set(dbFilename, db);
  return db;
}

/**
 * Closes all database connections. Call on graceful shutdown.
 */
export function closeAll() {
  if (indexDb) {
    indexDb.close();
    indexDb = null;
  }
  for (const [name, db] of projectDbs) {
    db.close();
    projectDbs.delete(name);
  }
}
