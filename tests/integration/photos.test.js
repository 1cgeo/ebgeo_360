/**
 * @module tests/integration/photos.test
 * @description Integration tests for photo metadata and image serving endpoints.
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
// GET /api/v1/photos/:uuid — metadata
// ============================================================================

describe('GET /api/v1/photos/:uuid', () => {
  it('returns 200 with camera and targets', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/photos/${SEEDS.PHOTO_1_ID}` });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(body.camera);
    assert.ok(Array.isArray(body.targets));
  });

  it('camera has expected shape', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/photos/${SEEDS.PHOTO_1_ID}` });
    const { camera } = JSON.parse(res.body);

    assert.equal(camera.id, SEEDS.PHOTO_1_ID);
    assert.equal(camera.img, SEEDS.PHOTO_1_ID);
    assert.equal(camera.lon, SEEDS.PHOTO_1_LON);
    assert.equal(camera.lat, SEEDS.PHOTO_1_LAT);
    assert.equal(camera.ele, SEEDS.PHOTO_1_ELE);
    assert.equal(camera.heading, SEEDS.PHOTO_1_HEADING);
    assert.equal(camera.height, SEEDS.PHOTO_1_CAMERA_HEIGHT);
    assert.equal(camera.mesh_rotation_y, SEEDS.PHOTO_1_MESH_ROTATION_Y);
    assert.equal(camera.mesh_rotation_x, 0);
    assert.equal(camera.mesh_rotation_z, 0);
    assert.equal(camera.distance_scale, 1.0);
    assert.equal(camera.marker_scale, 1.0);
    assert.equal(camera.floor_level, 1);
  });

  it('targets array has expected shape with display_name', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/photos/${SEEDS.PHOTO_1_ID}` });
    const { targets } = JSON.parse(res.body);

    assert.equal(targets.length, 1);
    const target = targets[0];
    assert.equal(target.id, SEEDS.PHOTO_2_ID);
    assert.equal(target.img, SEEDS.PHOTO_2_ID);
    assert.equal(target.display_name, SEEDS.PHOTO_2_DISPLAY_NAME);
    assert.equal(target.distance, SEEDS.TARGET_1_TO_2_DISTANCE);
    assert.equal(target.bearing, SEEDS.TARGET_1_TO_2_BEARING);
    assert.equal(target.next, true);
  });

  it('target with override has non-null override_bearing/override_distance', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/photos/${SEEDS.PHOTO_1_ID}` });
    const target = JSON.parse(res.body).targets[0];

    assert.equal(target.override_bearing, SEEDS.TARGET_1_TO_2_OVERRIDE_BEARING);
    assert.equal(target.override_distance, SEEDS.TARGET_1_TO_2_OVERRIDE_DISTANCE);
  });

  it('target without override has null override_bearing/override_distance', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/photos/${SEEDS.PHOTO_2_ID}` });
    const target = JSON.parse(res.body).targets[0];

    assert.equal(target.override_bearing, null);
    assert.equal(target.override_distance, null);
  });

  it('does not include hidden field by default', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/photos/${SEEDS.PHOTO_1_ID}` });
    const target = JSON.parse(res.body).targets[0];
    assert.equal(target.hidden, undefined);
  });

  it('includes hidden field when include_hidden=true', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/photos/${SEEDS.PHOTO_1_ID}?include_hidden=true`,
    });
    const target = JSON.parse(res.body).targets[0];
    assert.equal(target.hidden, false);
  });

  it('includes is_original field', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/photos/${SEEDS.PHOTO_1_ID}` });
    const target = JSON.parse(res.body).targets[0];
    assert.equal(target.is_original, true);
  });

  it('returns 404 for non-existent UUID', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/photos/00000000-0000-0000-0000-000000000000' });
    assert.equal(res.statusCode, 404);
  });

  it('returns application/json content type', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/photos/${SEEDS.PHOTO_1_ID}` });
    assert.ok(res.headers['content-type']?.includes('application/json'));
  });

  it('sets no-cache Cache-Control with an ETag validator', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/photos/${SEEDS.PHOTO_1_ID}` });
    assert.ok(res.headers['cache-control']?.includes('no-cache'));
    assert.ok(res.headers['etag']);
  });

  it('returns 304 when If-None-Match matches the metadata ETag', async () => {
    const res1 = await app.inject({ method: 'GET', url: `/api/v1/photos/${SEEDS.PHOTO_1_ID}` });
    const etag = res1.headers['etag'];
    assert.ok(etag);

    const res2 = await app.inject({
      method: 'GET',
      url: `/api/v1/photos/${SEEDS.PHOTO_1_ID}`,
      headers: { 'if-none-match': etag },
    });
    assert.equal(res2.statusCode, 304);
  });

  it('uses a distinct ETag when include_hidden=true', async () => {
    const resVisible = await app.inject({ method: 'GET', url: `/api/v1/photos/${SEEDS.PHOTO_1_ID}` });
    const resHidden = await app.inject({
      method: 'GET',
      url: `/api/v1/photos/${SEEDS.PHOTO_1_ID}?include_hidden=true`,
    });
    assert.notEqual(resVisible.headers['etag'], resHidden.headers['etag']);
  });
});

// ============================================================================
// GET /api/v1/photos/:uuid/image — binary stream
// ============================================================================

describe('GET /api/v1/photos/:uuid/image', () => {
  it('returns 200 with content-type image/webp', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/photos/${SEEDS.PHOTO_1_ID}/image` });
    assert.equal(res.statusCode, 200);
    assert.ok(res.headers['content-type']?.includes('image/webp'));
  });

  it('returns correct Content-Length matching blob size', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/photos/${SEEDS.PHOTO_1_ID}/image` });
    assert.equal(parseInt(res.headers['content-length'], 10), SEEDS.FULL_BLOB.length);
  });

  it('returns ETag header', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/photos/${SEEDS.PHOTO_1_ID}/image` });
    assert.ok(res.headers['etag']);
  });

  it('returns 304 when If-None-Match matches ETag', async () => {
    // First request to get the ETag
    const res1 = await app.inject({ method: 'GET', url: `/api/v1/photos/${SEEDS.PHOTO_1_ID}/image` });
    const etag = res1.headers['etag'];
    assert.ok(etag);

    // Second request with matching If-None-Match
    const res2 = await app.inject({
      method: 'GET',
      url: `/api/v1/photos/${SEEDS.PHOTO_1_ID}/image`,
      headers: { 'if-none-match': etag },
    });
    assert.equal(res2.statusCode, 304);
  });

  it('returns preview blob when quality=preview', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/photos/${SEEDS.PHOTO_1_ID}/image?quality=preview`,
    });
    assert.equal(res.statusCode, 200);
    assert.equal(parseInt(res.headers['content-length'], 10), SEEDS.PREVIEW_BLOB.length);
  });

  it('returns 404 for non-existent UUID', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/photos/00000000-0000-0000-0000-000000000000/image' });
    assert.equal(res.statusCode, 404);
  });

  it('falls back to full image when quality param is invalid', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/photos/${SEEDS.PHOTO_1_ID}/image?quality=invalid`,
    });
    assert.equal(res.statusCode, 200);
    assert.equal(parseInt(res.headers['content-length'], 10), SEEDS.FULL_BLOB.length);
  });

  it('returns immutable Cache-Control header', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/photos/${SEEDS.PHOTO_1_ID}/image` });
    assert.ok(res.headers['cache-control']?.includes('immutable'));
    assert.ok(res.headers['cache-control']?.includes('31536000'));
  });

  it('ETag is derived from uuid+quality (does not require reading the blob)', async () => {
    const full = await app.inject({ method: 'GET', url: `/api/v1/photos/${SEEDS.PHOTO_1_ID}/image` });
    const preview = await app.inject({ method: 'GET', url: `/api/v1/photos/${SEEDS.PHOTO_1_ID}/image?quality=preview` });
    // ETag determinístico embute o uuid e a quality, e difere entre variantes.
    assert.ok(full.headers['etag'].includes(SEEDS.PHOTO_1_ID));
    assert.ok(full.headers['etag'].includes('full'));
    assert.ok(preview.headers['etag'].includes('preview'));
    assert.notEqual(full.headers['etag'], preview.headers['etag']);
  });

  it('advertises Accept-Ranges: bytes', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/photos/${SEEDS.PHOTO_1_ID}/image` });
    assert.equal(res.headers['accept-ranges'], 'bytes');
  });

  it('does not set X-Accel-Buffering header', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/photos/${SEEDS.PHOTO_1_ID}/image` });
    assert.equal(res.headers['x-accel-buffering'], undefined);
  });

  it('responds 206 with Content-Range for a valid Range request', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/photos/${SEEDS.PHOTO_1_ID}/image`,
      headers: { range: 'bytes=0-4' },
    });
    assert.equal(res.statusCode, 206);
    assert.equal(res.headers['content-range'], `bytes 0-4/${SEEDS.FULL_BLOB.length}`);
    assert.equal(parseInt(res.headers['content-length'], 10), 5);
    assert.equal(res.rawPayload.length, 5);
    assert.deepEqual(res.rawPayload, SEEDS.FULL_BLOB.subarray(0, 5));
  });

  it('responds 416 for an unsatisfiable Range request', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/photos/${SEEDS.PHOTO_1_ID}/image`,
      headers: { range: `bytes=${SEEDS.FULL_BLOB.length + 10}-` },
    });
    assert.equal(res.statusCode, 416);
    assert.equal(res.headers['content-range'], `bytes */${SEEDS.FULL_BLOB.length}`);
  });

  it('serves the full image (200) for a non-byte Range unit', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/photos/${SEEDS.PHOTO_1_ID}/image`,
      headers: { range: 'items=0-4' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(parseInt(res.headers['content-length'], 10), SEEDS.FULL_BLOB.length);
  });

  it('serves many concurrent image requests under the in-flight limiter', async () => {
    // Mais requisicoes do que o teto de concorrencia: todas devem concluir 200,
    // confirmando que o limitador enfileira em vez de travar.
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        app.inject({ method: 'GET', url: `/api/v1/photos/${SEEDS.PHOTO_1_ID}/image` })),
    );
    for (const res of results) {
      assert.equal(res.statusCode, 200);
      assert.equal(parseInt(res.headers['content-length'], 10), SEEDS.FULL_BLOB.length);
    }
  });
});

// ============================================================================
// GET /api/v1/photos/by-name/:originalName
// ============================================================================

describe('GET /api/v1/photos/by-name/:originalName', () => {
  it('returns 200 with id, originalName, displayName for valid name', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/photos/by-name/${SEEDS.PHOTO_1_ORIGINAL_NAME}` });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.id, SEEDS.PHOTO_1_ID);
    assert.equal(body.originalName, SEEDS.PHOTO_1_ORIGINAL_NAME);
    assert.equal(body.displayName, SEEDS.PHOTO_1_DISPLAY_NAME);
  });

  it('returns 404 for non-existent original name', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/photos/by-name/NONEXISTENT.jpg' });
    assert.equal(res.statusCode, 404);
    const body = JSON.parse(res.body);
    assert.ok(body.error);
  });
});

// ============================================================================
// HEAD /api/v1/photos/:uuid
// ============================================================================

describe('HEAD /api/v1/photos/:uuid', () => {
  it('returns 200 for existing photo', async () => {
    const res = await app.inject({ method: 'HEAD', url: `/api/v1/photos/${SEEDS.PHOTO_1_ID}` });
    assert.equal(res.statusCode, 200);
  });

  it('returns 404 for non-existent UUID', async () => {
    const res = await app.inject({ method: 'HEAD', url: '/api/v1/photos/00000000-0000-0000-0000-000000000000' });
    assert.equal(res.statusCode, 404);
  });
});
