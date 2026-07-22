/**
 * @module tests/integration/calibration.test
 * @description Integration tests for calibration write endpoints (PUT/DELETE).
 * Tests are ordered: validation first, then successful writes, then persistence checks.
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
// PUT /api/v1/photos/:uuid/calibration
// ============================================================================

describe('PUT /api/v1/photos/:uuid/calibration', () => {
  it('returns 200 with ok:true for valid mesh_rotation_y', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/photos/${SEEDS.PHOTO_1_ID}/calibration`,
      payload: { mesh_rotation_y: 200.5 },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.mesh_rotation_y, 200.5);
  });

  it('mesh_rotation_y persists (verified via GET)', async () => {
    // Write a known value
    await app.inject({
      method: 'PUT',
      url: `/api/v1/photos/${SEEDS.PHOTO_1_ID}/calibration`,
      payload: { mesh_rotation_y: 123.4 },
    });

    // Read back
    const res = await app.inject({ method: 'GET', url: `/api/v1/photos/${SEEDS.PHOTO_1_ID}` });
    const body = JSON.parse(res.body);
    assert.equal(body.camera.mesh_rotation_y, 123.4);
  });

  it('returns 400 when mesh_rotation_y is not a number', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/photos/${SEEDS.PHOTO_1_ID}/calibration`,
      payload: { mesh_rotation_y: 'not-a-number' },
    });
    assert.equal(res.statusCode, 400);
  });

  it('returns 400 when mesh_rotation_y is NaN', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/photos/${SEEDS.PHOTO_1_ID}/calibration`,
      payload: { mesh_rotation_y: NaN },
    });
    // JSON.stringify(NaN) becomes null, so the body will have mesh_rotation_y: null
    assert.equal(res.statusCode, 400);
  });

  it('returns 400 when mesh_rotation_y is out of range', async () => {
    const res1 = await app.inject({
      method: 'PUT',
      url: `/api/v1/photos/${SEEDS.PHOTO_1_ID}/calibration`,
      payload: { mesh_rotation_y: -1 },
    });
    assert.equal(res1.statusCode, 400);

    const res2 = await app.inject({
      method: 'PUT',
      url: `/api/v1/photos/${SEEDS.PHOTO_1_ID}/calibration`,
      payload: { mesh_rotation_y: 361 },
    });
    assert.equal(res2.statusCode, 400);
  });

  it('returns 400 when body is missing', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/photos/${SEEDS.PHOTO_1_ID}/calibration`,
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    });
    assert.equal(res.statusCode, 400);
  });

  it('returns 404 for non-existent photo UUID', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/photos/00000000-0000-0000-0000-000000000000/calibration',
      payload: { mesh_rotation_y: 180 },
    });
    assert.equal(res.statusCode, 404);
  });

  it('accepts mesh_rotation_y at boundary 0', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/photos/${SEEDS.PHOTO_1_ID}/calibration`,
      payload: { mesh_rotation_y: 0 },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).mesh_rotation_y, 0);
  });

  it('accepts mesh_rotation_y at boundary 360', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/photos/${SEEDS.PHOTO_1_ID}/calibration`,
      payload: { mesh_rotation_y: 360 },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).mesh_rotation_y, 360);
  });
});

// ============================================================================
// PUT /api/v1/photos/:uuid/rotation-x
// ============================================================================

describe('PUT /api/v1/photos/:uuid/rotation-x', () => {
  it('returns 200 with ok:true for valid mesh_rotation_x', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/photos/${SEEDS.PHOTO_1_ID}/rotation-x`,
      payload: { mesh_rotation_x: 5.5 },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.mesh_rotation_x, 5.5);
  });

  it('mesh_rotation_x persists (verified via GET)', async () => {
    await app.inject({
      method: 'PUT',
      url: `/api/v1/photos/${SEEDS.PHOTO_1_ID}/rotation-x`,
      payload: { mesh_rotation_x: -12.3 },
    });

    const res = await app.inject({ method: 'GET', url: `/api/v1/photos/${SEEDS.PHOTO_1_ID}` });
    const body = JSON.parse(res.body);
    assert.equal(body.camera.mesh_rotation_x, -12.3);
  });

  it('returns 400 when mesh_rotation_x is not a number', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/photos/${SEEDS.PHOTO_1_ID}/rotation-x`,
      payload: { mesh_rotation_x: 'bad' },
    });
    assert.equal(res.statusCode, 400);
  });

  it('returns 400 when mesh_rotation_x is out of range', async () => {
    const res1 = await app.inject({
      method: 'PUT',
      url: `/api/v1/photos/${SEEDS.PHOTO_1_ID}/rotation-x`,
      payload: { mesh_rotation_x: -31 },
    });
    assert.equal(res1.statusCode, 400);

    const res2 = await app.inject({
      method: 'PUT',
      url: `/api/v1/photos/${SEEDS.PHOTO_1_ID}/rotation-x`,
      payload: { mesh_rotation_x: 31 },
    });
    assert.equal(res2.statusCode, 400);
  });

  it('returns 404 for non-existent photo UUID', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/photos/00000000-0000-0000-0000-000000000000/rotation-x',
      payload: { mesh_rotation_x: 5 },
    });
    assert.equal(res.statusCode, 404);
  });

  it('accepts boundary values -30 and 30', async () => {
    const res1 = await app.inject({
      method: 'PUT',
      url: `/api/v1/photos/${SEEDS.PHOTO_1_ID}/rotation-x`,
      payload: { mesh_rotation_x: -30 },
    });
    assert.equal(res1.statusCode, 200);

    const res2 = await app.inject({
      method: 'PUT',
      url: `/api/v1/photos/${SEEDS.PHOTO_1_ID}/rotation-x`,
      payload: { mesh_rotation_x: 30 },
    });
    assert.equal(res2.statusCode, 200);
  });
});

// ============================================================================
// PUT /api/v1/photos/:uuid/rotation-z
// ============================================================================

describe('PUT /api/v1/photos/:uuid/rotation-z', () => {
  it('returns 200 with ok:true for valid mesh_rotation_z', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/photos/${SEEDS.PHOTO_1_ID}/rotation-z`,
      payload: { mesh_rotation_z: -7.2 },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.mesh_rotation_z, -7.2);
  });

  it('mesh_rotation_z persists (verified via GET)', async () => {
    await app.inject({
      method: 'PUT',
      url: `/api/v1/photos/${SEEDS.PHOTO_1_ID}/rotation-z`,
      payload: { mesh_rotation_z: 15.8 },
    });

    const res = await app.inject({ method: 'GET', url: `/api/v1/photos/${SEEDS.PHOTO_1_ID}` });
    const body = JSON.parse(res.body);
    assert.equal(body.camera.mesh_rotation_z, 15.8);
  });

  it('returns 400 when mesh_rotation_z is not a number', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/photos/${SEEDS.PHOTO_1_ID}/rotation-z`,
      payload: { mesh_rotation_z: 'bad' },
    });
    assert.equal(res.statusCode, 400);
  });

  it('returns 400 when mesh_rotation_z is out of range', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/photos/${SEEDS.PHOTO_1_ID}/rotation-z`,
      payload: { mesh_rotation_z: -31 },
    });
    assert.equal(res.statusCode, 400);
  });

  it('returns 404 for non-existent photo UUID', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/photos/00000000-0000-0000-0000-000000000000/rotation-z',
      payload: { mesh_rotation_z: 5 },
    });
    assert.equal(res.statusCode, 404);
  });
});

// ============================================================================
// PUT /api/v1/photos/:uuid/distance-scale
// ============================================================================

// ============================================================================
// PUT /api/v1/photos/:uuid/marker-scale
// ============================================================================

// ============================================================================
// POST /api/v1/projects/:slug/reset-reviewed
// ============================================================================

describe('POST /api/v1/projects/:slug/reset-reviewed', () => {
  it('returns 200 and resets all photos to unreviewed', async () => {
    // First mark a photo as reviewed
    await app.inject({
      method: 'PUT',
      url: `/api/v1/photos/${SEEDS.PHOTO_1_ID}/reviewed`,
      payload: { reviewed: true },
    });

    // Reset all
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${SEEDS.PROJECT_SLUG}/reset-reviewed`,
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.ok(body.photosReset >= 1);

    // Verify via project photos endpoint
    const listRes = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${SEEDS.PROJECT_SLUG}/photos`,
    });
    const listBody = JSON.parse(listRes.body);
    assert.ok(listBody.photos.every(p => p.reviewed === false));
  });

  it('returns 404 for non-existent project', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/projects/non-existent-slug/reset-reviewed',
    });
    assert.equal(res.statusCode, 404);
  });
});

// ============================================================================
// PUT /api/v1/projects/:slug/batch-calibration (extended fields)
// ============================================================================

describe('PUT /api/v1/projects/:slug/batch-calibration (extended)', () => {
  it('updates mesh_rotation_x for all project photos', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/projects/${SEEDS.PROJECT_SLUG}/batch-calibration`,
      payload: { mesh_rotation_x: 10.5 },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.updated.mesh_rotation_x.value, 10.5);
    assert.equal(body.updated.mesh_rotation_x.photosUpdated, 3);
  });

  it('updates mesh_rotation_z for all project photos', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/projects/${SEEDS.PROJECT_SLUG}/batch-calibration`,
      payload: { mesh_rotation_z: -5.0 },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.updated.mesh_rotation_z.value, -5.0);
  });

  it('updates all fields at once', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/projects/${SEEDS.PROJECT_SLUG}/batch-calibration`,
      payload: {
        mesh_rotation_y: 90,
        mesh_rotation_x: 2.0,
        mesh_rotation_z: -1.5,
      },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.ok(body.updated.mesh_rotation_y);
    assert.ok(body.updated.mesh_rotation_x);
    assert.ok(body.updated.mesh_rotation_z);
  });

  it('returns 400 when no fields provided', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/projects/${SEEDS.PROJECT_SLUG}/batch-calibration`,
      payload: {},
    });
    assert.equal(res.statusCode, 400);
  });

  it('validates new field ranges', async () => {
    const res1 = await app.inject({
      method: 'PUT',
      url: `/api/v1/projects/${SEEDS.PROJECT_SLUG}/batch-calibration`,
      payload: { mesh_rotation_x: 50 },
    });
    assert.equal(res1.statusCode, 400);

    const res2 = await app.inject({
      method: 'PUT',
      url: `/api/v1/projects/${SEEDS.PROJECT_SLUG}/batch-calibration`,
      payload: { distance_scale: 0.01 },
    });
    assert.equal(res2.statusCode, 400);
  });
});

// ============================================================================
// PUT /api/v1/targets/:sourceId/:targetId/override
// ============================================================================

// ============================================================================
// DELETE /api/v1/targets/:sourceId/:targetId/override
// ============================================================================

// ============================================================================
// PUT /api/v1/targets/:sourceId/:targetId/visibility
// ============================================================================

describe('PUT /api/v1/targets/:sourceId/:targetId/visibility', () => {
  it('returns 200 with ok:true when hiding a target', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/targets/${SEEDS.PHOTO_1_ID}/${SEEDS.PHOTO_2_ID}/visibility`,
      payload: { hidden: true },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.hidden, true);
  });

  it('hidden target excluded from GET /photos/:uuid by default', async () => {
    // Hide the target
    await app.inject({
      method: 'PUT',
      url: `/api/v1/targets/${SEEDS.PHOTO_1_ID}/${SEEDS.PHOTO_2_ID}/visibility`,
      payload: { hidden: true },
    });

    // GET without include_hidden
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/photos/${SEEDS.PHOTO_1_ID}`,
    });
    const body = JSON.parse(res.body);
    const hiddenTarget = body.targets.find(t => t.id === SEEDS.PHOTO_2_ID);
    assert.equal(hiddenTarget, undefined);
  });

  it('hidden target included when include_hidden=true', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/photos/${SEEDS.PHOTO_1_ID}?include_hidden=true`,
    });
    const body = JSON.parse(res.body);
    const target = body.targets.find(t => t.id === SEEDS.PHOTO_2_ID);
    assert.ok(target);
    assert.equal(target.hidden, true);
  });

  it('returns 200 when un-hiding a target', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/targets/${SEEDS.PHOTO_1_ID}/${SEEDS.PHOTO_2_ID}/visibility`,
      payload: { hidden: false },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).hidden, false);

    // Verify target is back in normal GET
    const getRes = await app.inject({
      method: 'GET',
      url: `/api/v1/photos/${SEEDS.PHOTO_1_ID}`,
    });
    const target = JSON.parse(getRes.body).targets.find(t => t.id === SEEDS.PHOTO_2_ID);
    assert.ok(target);
  });

  it('returns 400 when hidden is not boolean', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/targets/${SEEDS.PHOTO_1_ID}/${SEEDS.PHOTO_2_ID}/visibility`,
      payload: { hidden: 'yes' },
    });
    assert.equal(res.statusCode, 400);
  });

  it('returns 404 for non-existent source photo', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/targets/00000000-0000-0000-0000-000000000000/${SEEDS.PHOTO_2_ID}/visibility`,
      payload: { hidden: true },
    });
    assert.equal(res.statusCode, 404);
  });

  it('returns 404 when targetId is not a target of sourceId', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/targets/${SEEDS.PHOTO_1_ID}/00000000-0000-0000-0000-000000000099/visibility`,
      payload: { hidden: true },
    });
    assert.equal(res.statusCode, 404);
  });
});

// ============================================================================
// GET /api/v1/photos/:uuid/nearby
// ============================================================================

describe('GET /api/v1/photos/:uuid/nearby', () => {
  it('returns nearby unconnected photos', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/photos/${SEEDS.PHOTO_1_ID}/nearby?radius=100`,
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(Array.isArray(body.photos));
    // PHOTO_3 is nearby but not connected
    const photo3 = body.photos.find(p => p.id === SEEDS.PHOTO_3_ID);
    assert.ok(photo3, 'PHOTO_3 should be in nearby results');
    assert.equal(photo3.displayName, SEEDS.PHOTO_3_DISPLAY_NAME);
    assert.ok(typeof photo3.distance === 'number');
    assert.ok(typeof photo3.bearing === 'number');
  });

  it('excludes already-connected targets from nearby', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/photos/${SEEDS.PHOTO_1_ID}/nearby?radius=100`,
    });
    const body = JSON.parse(res.body);
    // PHOTO_2 is already a target of PHOTO_1, should not appear
    const photo2 = body.photos.find(p => p.id === SEEDS.PHOTO_2_ID);
    assert.equal(photo2, undefined, 'Connected target should not appear in nearby');
  });

  it('returns 404 for non-existent photo', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/photos/00000000-0000-0000-0000-000000000000/nearby',
    });
    assert.equal(res.statusCode, 404);
  });

  it('respects radius parameter', async () => {
    // Very small radius should exclude distant photos
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/photos/${SEEDS.PHOTO_1_ID}/nearby?radius=1`,
    });
    const body = JSON.parse(res.body);
    assert.equal(body.photos.length, 0, 'No photos within 1m');
  });

  it('negative radius is clamped (no silent empty list from inverted bbox)', async () => {
    // radius negativo era aceito antes e invertia a bbox -> lista vazia silenciosa.
    // Apos o clamp em [1, 1000], comporta-se como o radius minimo (1m).
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/photos/${SEEDS.PHOTO_1_ID}/nearby?radius=-100`,
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(Array.isArray(body.photos));
    // Com radius efetivo de 1m nao deve incluir PHOTO_3 (mais distante).
    const photo3 = body.photos.find(p => p.id === SEEDS.PHOTO_3_ID);
    assert.equal(photo3, undefined, 'No distant photos with clamped 1m radius');
  });

  it('non-numeric radius falls back to default 100m', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/photos/${SEEDS.PHOTO_1_ID}/nearby?radius=abc`,
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    const photo3 = body.photos.find(p => p.id === SEEDS.PHOTO_3_ID);
    assert.ok(photo3, 'PHOTO_3 should appear with default 100m radius');
  });

  it('oversized radius is clamped to 1000m (no project-wide scan blowup)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/photos/${SEEDS.PHOTO_1_ID}/nearby?radius=999999`,
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(Array.isArray(body.photos));
  });
});

// ============================================================================
// POST /api/v1/targets — create new target
// ============================================================================

describe('POST /api/v1/targets', () => {
  it('creates a new target connection', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/targets',
      payload: { source_id: SEEDS.PHOTO_1_ID, target_id: SEEDS.PHOTO_3_ID },
    });
    assert.equal(res.statusCode, 201);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.target.source_id, SEEDS.PHOTO_1_ID);
    assert.equal(body.target.target_id, SEEDS.PHOTO_3_ID);
    assert.equal(body.target.is_next, false);
    assert.equal(body.target.is_original, false);
    assert.ok(typeof body.target.distance_m === 'number');
    assert.ok(typeof body.target.bearing_deg === 'number');
  });

  it('new target appears in GET /photos/:uuid?include_hidden=true', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/photos/${SEEDS.PHOTO_1_ID}?include_hidden=true`,
    });
    const body = JSON.parse(res.body);
    const newTarget = body.targets.find(t => t.id === SEEDS.PHOTO_3_ID);
    assert.ok(newTarget, 'New target should appear in targets list');
    assert.equal(newTarget.is_original, false);
  });

  it('returns 409 for duplicate connection', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/targets',
      payload: { source_id: SEEDS.PHOTO_1_ID, target_id: SEEDS.PHOTO_3_ID },
    });
    assert.equal(res.statusCode, 409);
  });

  it('returns 400 when source_id or target_id missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/targets',
      payload: { source_id: SEEDS.PHOTO_1_ID },
    });
    assert.equal(res.statusCode, 400);
  });

  it('returns 400 when source_id equals target_id', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/targets',
      payload: { source_id: SEEDS.PHOTO_1_ID, target_id: SEEDS.PHOTO_1_ID },
    });
    assert.equal(res.statusCode, 400);
  });

  it('returns 404 for non-existent source photo', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/targets',
      payload: { source_id: '00000000-0000-0000-0000-000000000000', target_id: SEEDS.PHOTO_2_ID },
    });
    assert.equal(res.statusCode, 404);
  });

  it('returns 404 for non-existent target photo', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/targets',
      payload: { source_id: SEEDS.PHOTO_1_ID, target_id: '00000000-0000-0000-0000-000000000000' },
    });
    assert.equal(res.statusCode, 404);
  });
});

// ============================================================================
// DELETE /api/v1/targets/:sourceId/:targetId — remove manual target
// ============================================================================

describe('DELETE /api/v1/targets/:sourceId/:targetId', () => {
  it('deletes a manually-created target', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/targets/${SEEDS.PHOTO_1_ID}/${SEEDS.PHOTO_3_ID}`,
    });
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).ok, true);

    // Verify it is gone
    const getRes = await app.inject({
      method: 'GET',
      url: `/api/v1/photos/${SEEDS.PHOTO_1_ID}?include_hidden=true`,
    });
    const body = JSON.parse(getRes.body);
    const deleted = body.targets.find(t => t.id === SEEDS.PHOTO_3_ID);
    assert.equal(deleted, undefined, 'Deleted target should not appear');
  });

  it('returns 400 when trying to delete an original target', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/targets/${SEEDS.PHOTO_1_ID}/${SEEDS.PHOTO_2_ID}`,
    });
    assert.equal(res.statusCode, 400);
    assert.ok(JSON.parse(res.body).error.includes('original'));
  });

  it('returns 404 for non-existent target', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/targets/${SEEDS.PHOTO_1_ID}/00000000-0000-0000-0000-000000000099`,
    });
    assert.equal(res.statusCode, 404);
  });
});

// ============================================================================
// DELETE /api/v1/photos/:uuid — soft-delete a photo
// ============================================================================

describe('DELETE /api/v1/photos/:uuid (soft-delete)', () => {
  // These tests delete PHOTO_3 (not connected as a target by seed data).
  // Run them last since they mutate shared state.

  it('returns 200 with ok:true for a valid photo', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/photos/${SEEDS.PHOTO_3_ID}`,
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.deletedPhotoId, SEEDS.PHOTO_3_ID);
    assert.equal(body.projectSlug, SEEDS.PROJECT_SLUG);
    assert.equal(typeof body.newPhotoCount, 'number');
    assert.equal(body.newPhotoCount, 2); // was 3, now 2
  });

  it('returns 404 for a photo that was already deleted', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/photos/${SEEDS.PHOTO_3_ID}`,
    });
    assert.equal(res.statusCode, 404);
  });

  it('returns 404 for a non-existent photo UUID', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/photos/00000000-0000-0000-0000-000000000000',
    });
    assert.equal(res.statusCode, 404);
  });

  it('GET /photos/:uuid returns 404 after deletion', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/photos/${SEEDS.PHOTO_3_ID}`,
    });
    assert.equal(res.statusCode, 404);
  });

  it('GET /photos/:uuid/image returns 404 after deletion', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/photos/${SEEDS.PHOTO_3_ID}/image`,
    });
    assert.equal(res.statusCode, 404);
  });

  it('deleted photo does not appear in project photo list', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${SEEDS.PROJECT_SLUG}/photos`,
    });
    const body = JSON.parse(res.body);
    const deleted = body.photos.find(p => p.id === SEEDS.PHOTO_3_ID);
    assert.equal(deleted, undefined, 'Deleted photo should not appear in project photos');
  });

  it('deleted photo does not appear in nearby results', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/photos/${SEEDS.PHOTO_1_ID}/nearby?radius=100`,
    });
    const body = JSON.parse(res.body);
    const deleted = body.photos.find(p => p.id === SEEDS.PHOTO_3_ID);
    assert.equal(deleted, undefined, 'Deleted photo should not appear in nearby');
  });

  it('project photo_count is decremented', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${SEEDS.PROJECT_SLUG}`,
    });
    const body = JSON.parse(res.body);
    assert.equal(body.project.photoCount, 2);
  });

  // Now test deleting a photo that IS a target of another photo
  it('targets TO deleted photo are removed from other photos', async () => {
    // PHOTO_2 has PHOTO_1 as target. Delete PHOTO_1.
    const delRes = await app.inject({
      method: 'DELETE',
      url: `/api/v1/photos/${SEEDS.PHOTO_1_ID}`,
    });
    assert.equal(delRes.statusCode, 200);

    // PHOTO_2's targets should no longer include PHOTO_1
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/photos/${SEEDS.PHOTO_2_ID}?include_hidden=true`,
    });
    const body = JSON.parse(res.body);
    const deletedTarget = body.targets.find(t => t.id === SEEDS.PHOTO_1_ID);
    assert.equal(deletedTarget, undefined, 'Deleted photo should not appear as target');
  });

  it('entry_photo_id is updated when entry photo is deleted', async () => {
    // PHOTO_1 was the entry photo and was deleted above.
    // entry_photo_id should now point to PHOTO_2 (the only remaining photo).
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${SEEDS.PROJECT_SLUG}`,
    });
    const body = JSON.parse(res.body);
    assert.equal(body.project.entryPhotoId, SEEDS.PHOTO_2_ID);
    assert.equal(body.project.photoCount, 1);
  });
});
