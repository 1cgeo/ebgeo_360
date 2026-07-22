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
import { resetStatements } from './queries.js';

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
  indexDb.pragma('busy_timeout = 5000'); // espera ate 5s em vez de falhar com SQLITE_BUSY

  // Initialize schema
  const schema = readFileSync(resolve(__dirname, 'schema.sql'), 'utf-8');
  indexDb.exec(schema);

  // Aplica todas as migracoes de startup numa unica transacao (atomicidade)
  indexDb.transaction(() => {
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
      // O UPDATE que reescrevia override_distance < 0.5 para 5 saiu daqui.
      // Ele existia para consertar um valor que alimentava o desenho; hoje o
      // override e inerte e serve como REGISTRO de quais fotos estao mal
      // posicionadas, entao reescreve-lo a cada partida adulterava a unica
      // coisa que esses campos ainda valem.
    }

    // Migrate: add hidden column to targets table
    const targetCols2 = indexDb.pragma('table_info(targets)');
    if (!targetCols2.some(c => c.name === 'hidden')) {
      indexDb.exec('ALTER TABLE targets ADD COLUMN hidden INTEGER DEFAULT 0');
    }

    // Migrate: add override_height column to targets table
    const targetCols3 = indexDb.pragma('table_info(targets)');
    if (!targetCols3.some(c => c.name === 'override_height')) {
      indexDb.exec('ALTER TABLE targets ADD COLUMN override_height REAL');
    }

    // deleted_photos e os indices idx_targets_target/idx_targets_source_order
    // vivem no schema.sql, que roda incondicionalmente acima (com IF NOT EXISTS),
    // entao ja existem aqui: recria-los era redundancia. O filtro por photo_id
    // em deleted_photos e servido pelo indice automatico da PRIMARY KEY.
  })();

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
  // journal_mode=WAL nao se aplica em conexao readonly (no-op): o modo ja vem
  // persistido do arquivo (definido em createProjectDb). Reforcamos query_only.
  db.pragma('query_only = true');
  db.pragma('cache_size = -32000'); // 32 MB cache per project DB
  db.pragma('busy_timeout = 5000'); // espera ate 5s em vez de falhar com SQLITE_BUSY
  db.pragma('mmap_size = 268435456'); // 256 MB: le BLOBs via memory-map, reduz syscalls read()

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
  db.pragma('mmap_size = 268435456'); // 256 MB: le BLOBs via memory-map, reduz syscalls read()

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
  // Invalida o cache de prepared statements antes de fechar a conexao:
  // os statements em _stmts apontam para indexDb e ficariam invalidos.
  resetStatements();

  if (indexDb) {
    indexDb.close();
    indexDb = null;
  }
  for (const [name, db] of projectDbs) {
    db.close();
    projectDbs.delete(name);
  }
}
