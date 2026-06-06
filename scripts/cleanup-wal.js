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

let failures = 0;

function checkpointDb(dbPath) {
  const label = dbPath.replace(dataDir, '.');
  let db = null;
  try {
    db = new Database(dbPath);
    const result = db.pragma('wal_checkpoint(TRUNCATE)');
    // wal_checkpoint retorna { busy, log, checkpointed }. busy != 0 indica que o
    // DB esta em uso por outra conexao (ex.: servidor rodando) e o WAL NAO foi
    // truncado — sinaliza como falha para nao mascarar handles/locks remanescentes.
    const row = result[0] || {};
    if (row.busy && row.busy !== 0) {
      failures++;
      console.error(`  BUSY  ${label}  (checkpoint nao truncou o WAL: ${JSON.stringify(row)})`);
    } else {
      console.log(`  OK  ${label}  (checkpoint: ${JSON.stringify(row)})`);
    }
  } catch (err) {
    failures++;
    console.error(`  FAIL  ${label}  ${err.message}`);
  } finally {
    // Garante o fechamento do handle mesmo se a pragma lancar; trata falhas de close.
    if (db) {
      try {
        db.close();
      } catch (closeErr) {
        failures++;
        console.error(`  FAIL close  ${label}  ${closeErr.message}`);
      }
    }
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

if (failures > 0) {
  console.error(`\nConcluido com ${failures} falha(s). WAL/SHM de alguns DBs podem nao ter sido removidos (DB em uso?).`);
  process.exit(1);
} else {
  console.log('\nDone. WAL/SHM files should now be removed.');
}
