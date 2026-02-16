/**
 * @module tests/integration/health-error.test
 * @description Tests the 503 error path of GET /health when the DB is broken.
 * Uses a separate file to avoid contaminating the singleton DB state.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let app, dataDir;

before(async () => {
  // Create a temp dir and place a regular FILE named index.db
  // so that better-sqlite3 fails to open it as a valid database.
  dataDir = mkdtempSync(join(tmpdir(), 'sv-health-err-'));
  // Write garbage data so better-sqlite3 cannot open it as SQLite
  writeFileSync(join(dataDir, 'index.db'), 'this-is-not-a-sqlite-database');

  process.env.STREETVIEW_DATA_DIR = dataDir;

  const { buildApp } = await import('../helpers/build-app.js');
  app = await buildApp();
});

after(async () => {
  await app.close();
  const { closeAll } = await import('../../src/db/connection.js');
  const { resetStatements } = await import('../../src/db/queries.js');
  closeAll();
  resetStatements();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('GET /health (error path)', () => {
  it('returns 503 when database is corrupt', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(res.statusCode, 503);
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'error');
    assert.ok(body.message);
  });
});
