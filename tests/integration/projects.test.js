/**
 * @module tests/integration/projects.test
 * @description Integration tests for project listing endpoints.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestData, destroyTestData, SEEDS } from '../helpers/test-db.js';

let app, dataDir;

before(async () => {
  ({ dataDir } = createTestData());
  process.env.STREETVIEW_DATA_DIR = dataDir;

  const { buildApp } = await import('../helpers/build-app.js');
  app = await buildApp();
});

after(async () => {
  await app.close();
  await destroyTestData(dataDir);
});

// ============================================================================
// GET /api/v1/projects
// ============================================================================

describe('GET /api/v1/projects', () => {
  it('returns 200 with projects array', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/projects' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(Array.isArray(body.projects));
    assert.equal(body.projects.length, 1);
  });

  it('project has camelCase keys (entryPhotoId, photoCount, captureDate)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/projects' });
    const project = JSON.parse(res.body).projects[0];

    assert.equal(project.entryPhotoId, SEEDS.PHOTO_1_ID);
    assert.equal(project.photoCount, 3);
    assert.equal(project.captureDate, '2024-01-15');
    // Snake-case fields should NOT be present
    assert.equal(project.entry_photo_id, undefined);
    assert.equal(project.photo_count, undefined);
    assert.equal(project.capture_date, undefined);
    // db_filename should be excluded
    assert.equal(project.db_filename, undefined);
  });

  it('project has center object with lat and lon', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/projects' });
    const project = JSON.parse(res.body).projects[0];

    assert.ok(project.center);
    assert.equal(project.center.lat, SEEDS.PHOTO_1_LAT);
    assert.equal(project.center.lon, SEEDS.PHOTO_1_LON);
    // Flat fields should NOT be present
    assert.equal(project.center_lat, undefined);
    assert.equal(project.center_lon, undefined);
  });

  it('response has Cache-Control metadata header', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/projects' });
    assert.ok(res.headers['cache-control']?.includes('3600'));
  });
});

// ============================================================================
// GET /api/v1/projects/:slug
// ============================================================================

describe('GET /api/v1/projects/:slug', () => {
  it('returns 200 with project for valid slug', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/projects/${SEEDS.PROJECT_SLUG}` });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(body.project);
    assert.equal(body.project.id, SEEDS.PROJECT_ID);
    assert.equal(body.project.name, SEEDS.PROJECT_NAME);
  });

  it('returns 404 for non-existent slug', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/projects/non-existent' });
    assert.equal(res.statusCode, 404);
    const body = JSON.parse(res.body);
    assert.ok(body.error);
  });
});
