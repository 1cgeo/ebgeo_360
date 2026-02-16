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

describe('PUT /api/v1/photos/:uuid/distance-scale', () => {
  it('returns 200 with ok:true for valid distance_scale', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/photos/${SEEDS.PHOTO_1_ID}/distance-scale`,
      payload: { distance_scale: 2.5 },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.distance_scale, 2.5);
  });

  it('distance_scale persists (verified via GET)', async () => {
    await app.inject({
      method: 'PUT',
      url: `/api/v1/photos/${SEEDS.PHOTO_1_ID}/distance-scale`,
      payload: { distance_scale: 1.75 },
    });

    const res = await app.inject({ method: 'GET', url: `/api/v1/photos/${SEEDS.PHOTO_1_ID}` });
    const body = JSON.parse(res.body);
    assert.equal(body.camera.distance_scale, 1.75);
  });

  it('returns 400 when distance_scale is not a number', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/photos/${SEEDS.PHOTO_1_ID}/distance-scale`,
      payload: { distance_scale: 'bad' },
    });
    assert.equal(res.statusCode, 400);
  });

  it('returns 400 when distance_scale is out of range', async () => {
    const res1 = await app.inject({
      method: 'PUT',
      url: `/api/v1/photos/${SEEDS.PHOTO_1_ID}/distance-scale`,
      payload: { distance_scale: 0.05 },
    });
    assert.equal(res1.statusCode, 400);

    const res2 = await app.inject({
      method: 'PUT',
      url: `/api/v1/photos/${SEEDS.PHOTO_1_ID}/distance-scale`,
      payload: { distance_scale: 5.1 },
    });
    assert.equal(res2.statusCode, 400);
  });

  it('returns 404 for non-existent photo UUID', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/photos/00000000-0000-0000-0000-000000000000/distance-scale',
      payload: { distance_scale: 1.0 },
    });
    assert.equal(res.statusCode, 404);
  });

  it('accepts boundary values 0.1 and 5.0', async () => {
    const res1 = await app.inject({
      method: 'PUT',
      url: `/api/v1/photos/${SEEDS.PHOTO_1_ID}/distance-scale`,
      payload: { distance_scale: 0.1 },
    });
    assert.equal(res1.statusCode, 200);

    const res2 = await app.inject({
      method: 'PUT',
      url: `/api/v1/photos/${SEEDS.PHOTO_1_ID}/distance-scale`,
      payload: { distance_scale: 5.0 },
    });
    assert.equal(res2.statusCode, 200);
  });
});

// ============================================================================
// PUT /api/v1/photos/:uuid/marker-scale
// ============================================================================

describe('PUT /api/v1/photos/:uuid/marker-scale', () => {
  it('returns 200 with ok:true for valid marker_scale', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/photos/${SEEDS.PHOTO_1_ID}/marker-scale`,
      payload: { marker_scale: 2.5 },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.marker_scale, 2.5);
  });

  it('marker_scale persists (verified via GET)', async () => {
    await app.inject({
      method: 'PUT',
      url: `/api/v1/photos/${SEEDS.PHOTO_1_ID}/marker-scale`,
      payload: { marker_scale: 0.5 },
    });

    const res = await app.inject({ method: 'GET', url: `/api/v1/photos/${SEEDS.PHOTO_1_ID}` });
    const body = JSON.parse(res.body);
    assert.equal(body.camera.marker_scale, 0.5);
  });

  it('returns 400 when marker_scale is not a number', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/photos/${SEEDS.PHOTO_1_ID}/marker-scale`,
      payload: { marker_scale: 'bad' },
    });
    assert.equal(res.statusCode, 400);
  });

  it('returns 400 when marker_scale is out of range', async () => {
    const res1 = await app.inject({
      method: 'PUT',
      url: `/api/v1/photos/${SEEDS.PHOTO_1_ID}/marker-scale`,
      payload: { marker_scale: 0.05 },
    });
    assert.equal(res1.statusCode, 400);

    const res2 = await app.inject({
      method: 'PUT',
      url: `/api/v1/photos/${SEEDS.PHOTO_1_ID}/marker-scale`,
      payload: { marker_scale: 5.1 },
    });
    assert.equal(res2.statusCode, 400);
  });

  it('returns 404 for non-existent photo UUID', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/photos/00000000-0000-0000-0000-000000000000/marker-scale',
      payload: { marker_scale: 1.0 },
    });
    assert.equal(res.statusCode, 404);
  });

  it('accepts boundary values 0.1 and 5.0', async () => {
    const res1 = await app.inject({
      method: 'PUT',
      url: `/api/v1/photos/${SEEDS.PHOTO_1_ID}/marker-scale`,
      payload: { marker_scale: 0.1 },
    });
    assert.equal(res1.statusCode, 200);

    const res2 = await app.inject({
      method: 'PUT',
      url: `/api/v1/photos/${SEEDS.PHOTO_1_ID}/marker-scale`,
      payload: { marker_scale: 5.0 },
    });
    assert.equal(res2.statusCode, 200);
  });
});

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

  it('updates distance_scale for all project photos', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/projects/${SEEDS.PROJECT_SLUG}/batch-calibration`,
      payload: { distance_scale: 2.0 },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.updated.distance_scale.value, 2.0);
  });

  it('updates marker_scale for all project photos', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/projects/${SEEDS.PROJECT_SLUG}/batch-calibration`,
      payload: { marker_scale: 0.3 },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.updated.marker_scale.value, 0.3);
    assert.equal(body.updated.marker_scale.photosUpdated, 3);
  });

  it('updates all fields at once', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/projects/${SEEDS.PROJECT_SLUG}/batch-calibration`,
      payload: {
        mesh_rotation_y: 90,
        camera_height: 3.0,
        mesh_rotation_x: 2.0,
        mesh_rotation_z: -1.5,
        distance_scale: 1.5,
        marker_scale: 0.8,
      },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.ok(body.updated.mesh_rotation_y);
    assert.ok(body.updated.camera_height);
    assert.ok(body.updated.mesh_rotation_x);
    assert.ok(body.updated.mesh_rotation_z);
    assert.ok(body.updated.distance_scale);
    assert.ok(body.updated.marker_scale);
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

describe('PUT /api/v1/targets/:sourceId/:targetId/override', () => {
  it('returns 200 with ok:true for valid bearing and distance', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/targets/${SEEDS.PHOTO_2_ID}/${SEEDS.PHOTO_1_ID}/override`,
      payload: { override_bearing: 90.0, override_distance: 10.0 },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.override_bearing, 90.0);
    assert.equal(body.override_distance, 10.0);
  });

  it('override persists (verified via GET /photos/:sourceId)', async () => {
    // Write override
    await app.inject({
      method: 'PUT',
      url: `/api/v1/targets/${SEEDS.PHOTO_2_ID}/${SEEDS.PHOTO_1_ID}/override`,
      payload: { override_bearing: 77.5, override_distance: 3.0 },
    });

    // Read back via photo metadata
    const res = await app.inject({ method: 'GET', url: `/api/v1/photos/${SEEDS.PHOTO_2_ID}` });
    const body = JSON.parse(res.body);
    const target = body.targets.find(t => t.id === SEEDS.PHOTO_1_ID);
    assert.ok(target);
    assert.equal(target.override_bearing, 77.5);
    assert.equal(target.override_distance, 3.0);
  });

  it('returns 400 for non-numeric override_bearing', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/targets/${SEEDS.PHOTO_1_ID}/${SEEDS.PHOTO_2_ID}/override`,
      payload: { override_bearing: 'bad', override_distance: 5 },
    });
    assert.equal(res.statusCode, 400);
  });

  it('returns 400 for override_bearing out of range', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/targets/${SEEDS.PHOTO_1_ID}/${SEEDS.PHOTO_2_ID}/override`,
      payload: { override_bearing: 400, override_distance: 5 },
    });
    assert.equal(res.statusCode, 400);
  });

  it('returns 400 for override_distance out of range', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/targets/${SEEDS.PHOTO_1_ID}/${SEEDS.PHOTO_2_ID}/override`,
      payload: { override_bearing: 0, override_distance: 600 },
    });
    assert.equal(res.statusCode, 400);
  });

  it('returns 404 for non-existent source photo', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/targets/00000000-0000-0000-0000-000000000000/${SEEDS.PHOTO_2_ID}/override`,
      payload: { override_bearing: 0, override_distance: 5 },
    });
    assert.equal(res.statusCode, 404);
  });

  it('returns 404 when targetId is not a target of sourceId', async () => {
    // PHOTO_2 has PHOTO_1 as target, but use a non-existent target UUID
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/targets/${SEEDS.PHOTO_1_ID}/00000000-0000-0000-0000-000000000099/override`,
      payload: { override_bearing: 0, override_distance: 5 },
    });
    assert.equal(res.statusCode, 404);
    assert.ok(JSON.parse(res.body).error.includes('Target'));
  });

  it('returns 400 for non-numeric override_distance', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/targets/${SEEDS.PHOTO_1_ID}/${SEEDS.PHOTO_2_ID}/override`,
      payload: { override_bearing: 0, override_distance: 'bad' },
    });
    assert.equal(res.statusCode, 400);
  });

  it('accepts boundary values (bearing=0, bearing=360, distance=0.5, distance=500)', async () => {
    const res1 = await app.inject({
      method: 'PUT',
      url: `/api/v1/targets/${SEEDS.PHOTO_1_ID}/${SEEDS.PHOTO_2_ID}/override`,
      payload: { override_bearing: 0, override_distance: 0.5 },
    });
    assert.equal(res1.statusCode, 200);

    const res2 = await app.inject({
      method: 'PUT',
      url: `/api/v1/targets/${SEEDS.PHOTO_1_ID}/${SEEDS.PHOTO_2_ID}/override`,
      payload: { override_bearing: 360, override_distance: 500 },
    });
    assert.equal(res2.statusCode, 200);
  });

  it('accepts null overrides (clears via PUT)', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/targets/${SEEDS.PHOTO_1_ID}/${SEEDS.PHOTO_2_ID}/override`,
      payload: { override_bearing: null, override_distance: null },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.override_bearing, null);
    assert.equal(body.override_distance, null);
  });
});

// ============================================================================
// DELETE /api/v1/targets/:sourceId/:targetId/override
// ============================================================================

describe('DELETE /api/v1/targets/:sourceId/:targetId/override', () => {
  it('returns 200 and clears overrides', async () => {
    // First ensure the target has an override (seed data has PHOTO_1→PHOTO_2 with override)
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/targets/${SEEDS.PHOTO_1_ID}/${SEEDS.PHOTO_2_ID}/override`,
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);

    // Verify cleared
    const getRes = await app.inject({ method: 'GET', url: `/api/v1/photos/${SEEDS.PHOTO_1_ID}` });
    const target = JSON.parse(getRes.body).targets[0];
    assert.equal(target.override_bearing, null);
    assert.equal(target.override_distance, null);
  });

  it('returns 404 for non-existent target', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/targets/00000000-0000-0000-0000-000000000000/00000000-0000-0000-0000-000000000099/override',
    });
    assert.equal(res.statusCode, 404);
    assert.ok(JSON.parse(res.body).error);
  });
});

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
