#!/usr/bin/env node

/**
 * @module scripts/cleanup-wal
 * @description Checkpoints and closes all SQLite databases, removing -wal and -shm files.
 * Usage: node scripts/cleanup-wal.js [--data-dir <path>]
 */

import Database from 'better-sqlite3';
import { readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    'data-dir': { type: 'string', default: '' },
  },
});

const dataDir = values['data-dir']
  ? resolve(values['data-dir'])
  : resolve(process.cwd(), 'data');

function checkpointDb(dbPath) {
  const label = dbPath.replace(dataDir, '.');
  try {
    const db = new Database(dbPath);
    const result = db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
    console.log(`  OK  ${label}  (checkpoint: ${JSON.stringify(result[0])})`);
  } catch (err) {
    console.error(`  FAIL  ${label}  ${err.message}`);
  }
}

console.log(`Data dir: ${dataDir}\n`);

// index.db
const indexPath = join(dataDir, 'index.db');
if (existsSync(indexPath)) {
  console.log('index.db:');
  checkpointDb(indexPath);
}

// project databases
const projectsDir = join(dataDir, 'projects');
if (existsSync(projectsDir)) {
  const files = readdirSync(projectsDir).filter(f => f.endsWith('.db'));
  console.log(`\nProject databases (${files.length}):`);
  for (const file of files) {
    checkpointDb(join(projectsDir, file));
  }
}

console.log('\nDone. WAL/SHM files should now be removed.');
