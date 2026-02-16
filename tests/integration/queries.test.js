/**
 * @module tests/integration/queries.test
 * @description Integration tests for db/queries.js against real temp SQLite databases.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestData, destroyTestData, SEEDS } from '../helpers/test-db.js';

let dataDir;

// Query functions are imported dynamically after env setup
let getAllProjects, getProjectBySlug, getProjectByPhotoId;
let getPhotoById, getPhotoByOriginalName, getTargetsBySourceId, getImageBlob;
let updatePhotoMeshRotationY, updateTargetOverride, clearTargetOverride;

before(async () => {
  ({ dataDir } = createTestData());
  process.env.STREETVIEW_DATA_DIR = dataDir;

  // Dynamic import after env is set
  const queries = await import('../../src/db/queries.js');
  getAllProjects = queries.getAllProjects;
  getProjectBySlug = queries.getProjectBySlug;
  getProjectByPhotoId = queries.getProjectByPhotoId;
  getPhotoById = queries.getPhotoById;
  getPhotoByOriginalName = queries.getPhotoByOriginalName;
  getTargetsBySourceId = queries.getTargetsBySourceId;
  getImageBlob = queries.getImageBlob;
  updatePhotoMeshRotationY = queries.updatePhotoMeshRotationY;
  updateTargetOverride = queries.updateTargetOverride;
  clearTargetOverride = queries.clearTargetOverride;
});

after(async () => {
  await destroyTestData(dataDir);
});

// ============================================================================
// getAllProjects
// ============================================================================

describe('getAllProjects', () => {
  it('returns array with 1 project', () => {
    const projects = getAllProjects();
    assert.equal(Array.isArray(projects), true);
    assert.equal(projects.length, 1);
    assert.equal(projects[0].slug, SEEDS.PROJECT_SLUG);
  });
});

// ============================================================================
// getProjectBySlug
// ============================================================================

describe('getProjectBySlug', () => {
  it('returns project for valid slug', () => {
    const project = getProjectBySlug(SEEDS.PROJECT_SLUG);
    assert.ok(project);
    assert.equal(project.id, SEEDS.PROJECT_ID);
    assert.equal(project.name, SEEDS.PROJECT_NAME);
    assert.equal(project.entry_photo_id, SEEDS.PHOTO_1_ID);
    assert.equal(project.photo_count, 3);
  });

  it('returns undefined for non-existent slug', () => {
    const project = getProjectBySlug('non-existent-slug');
    assert.equal(project, undefined);
  });
});

// ============================================================================
// getProjectByPhotoId
// ============================================================================

describe('getProjectByPhotoId', () => {
  it('returns project for valid photo UUID', () => {
    const project = getProjectByPhotoId(SEEDS.PHOTO_1_ID);
    assert.ok(project);
    assert.equal(project.id, SEEDS.PROJECT_ID);
    assert.equal(project.db_filename, SEEDS.DB_FILENAME);
  });

  it('returns undefined for unknown photo UUID', () => {
    const project = getProjectByPhotoId('00000000-0000-0000-0000-000000000000');
    assert.equal(project, undefined);
  });
});

// ============================================================================
// getPhotoById
// ============================================================================

describe('getPhotoById', () => {
  it('returns full photo metadata for valid UUID', () => {
    const photo = getPhotoById(SEEDS.PHOTO_1_ID);
    assert.ok(photo);
    assert.equal(photo.id, SEEDS.PHOTO_1_ID);
    assert.equal(photo.original_name, SEEDS.PHOTO_1_ORIGINAL_NAME);
    assert.equal(photo.display_name, SEEDS.PHOTO_1_DISPLAY_NAME);
    assert.equal(photo.lat, SEEDS.PHOTO_1_LAT);
    assert.equal(photo.lon, SEEDS.PHOTO_1_LON);
    assert.equal(photo.ele, SEEDS.PHOTO_1_ELE);
    assert.equal(photo.heading, SEEDS.PHOTO_1_HEADING);
    assert.equal(photo.camera_height, SEEDS.PHOTO_1_CAMERA_HEIGHT);
    assert.equal(photo.mesh_rotation_y, SEEDS.PHOTO_1_MESH_ROTATION_Y);
    assert.equal(photo.floor_level, 1);
  });

  it('returns undefined for unknown UUID', () => {
    const photo = getPhotoById('00000000-0000-0000-0000-000000000000');
    assert.equal(photo, undefined);
  });
});

// ============================================================================
// getPhotoByOriginalName
// ============================================================================

describe('getPhotoByOriginalName', () => {
  it('returns photo for existing original_name', () => {
    const photo = getPhotoByOriginalName(SEEDS.PHOTO_1_ORIGINAL_NAME);
    assert.ok(photo);
    assert.equal(photo.id, SEEDS.PHOTO_1_ID);
    assert.equal(photo.display_name, SEEDS.PHOTO_1_DISPLAY_NAME);
  });

  it('returns undefined for unknown name', () => {
    const photo = getPhotoByOriginalName('NONEXISTENT.jpg');
    assert.equal(photo, undefined);
  });
});

// ============================================================================
// getTargetsBySourceId
// ============================================================================

describe('getTargetsBySourceId', () => {
  it('returns targets ordered by is_next DESC, distance_m ASC', () => {
    const targets = getTargetsBySourceId(SEEDS.PHOTO_1_ID);
    assert.equal(targets.length, 1);
    assert.equal(targets[0].target_id, SEEDS.PHOTO_2_ID);
    assert.equal(targets[0].is_next, 1);
    assert.equal(targets[0].distance_m, SEEDS.TARGET_1_TO_2_DISTANCE);
  });

  it('includes override_bearing/override_distance from seed data', () => {
    const targets = getTargetsBySourceId(SEEDS.PHOTO_1_ID);
    assert.equal(targets[0].override_bearing, SEEDS.TARGET_1_TO_2_OVERRIDE_BEARING);
    assert.equal(targets[0].override_distance, SEEDS.TARGET_1_TO_2_OVERRIDE_DISTANCE);

    // Target from PHOTO_2 has no override
    const targets2 = getTargetsBySourceId(SEEDS.PHOTO_2_ID);
    assert.equal(targets2[0].override_bearing, null);
    assert.equal(targets2[0].override_distance, null);
  });

  it('returns empty array for photo with no outbound targets', () => {
    const targets = getTargetsBySourceId('00000000-0000-0000-0000-000000000000');
    assert.equal(targets.length, 0);
  });
});

// ============================================================================
// getImageBlob
// ============================================================================

describe('getImageBlob', () => {
  it('returns Buffer for valid photo and full_webp column', () => {
    const blob = getImageBlob(SEEDS.DB_FILENAME, SEEDS.PHOTO_1_ID, 'full_webp');
    assert.ok(Buffer.isBuffer(blob));
    assert.deepEqual(blob, SEEDS.FULL_BLOB);
  });

  it('returns Buffer for valid photo and preview_webp column', () => {
    const blob = getImageBlob(SEEDS.DB_FILENAME, SEEDS.PHOTO_1_ID, 'preview_webp');
    assert.ok(Buffer.isBuffer(blob));
    assert.deepEqual(blob, SEEDS.PREVIEW_BLOB);
  });

  it('returns null for invalid column name (SQL injection guard)', () => {
    const blob = getImageBlob(SEEDS.DB_FILENAME, SEEDS.PHOTO_1_ID, 'DROP TABLE images');
    assert.equal(blob, null);
  });

  it('returns null for non-existent photo_id', () => {
    const blob = getImageBlob(SEEDS.DB_FILENAME, '00000000-0000-0000-0000-000000000000', 'full_webp');
    assert.equal(blob, null);
  });

  it('returns null for non-existent db filename', () => {
    const blob = getImageBlob('nonexistent.db', SEEDS.PHOTO_1_ID, 'full_webp');
    assert.equal(blob, null);
  });
});

// ============================================================================
// updatePhotoMeshRotationY
// ============================================================================

describe('updatePhotoMeshRotationY', () => {
  it('updates mesh_rotation_y and returns changes: 1', () => {
    const result = updatePhotoMeshRotationY(SEEDS.PHOTO_1_ID, 200.5);
    assert.equal(result.changes, 1);

    // Verify persisted
    const photo = getPhotoById(SEEDS.PHOTO_1_ID);
    assert.equal(photo.mesh_rotation_y, 200.5);
  });

  it('returns changes: 0 for non-existent photo', () => {
    const result = updatePhotoMeshRotationY('00000000-0000-0000-0000-000000000000', 180);
    assert.equal(result.changes, 0);
  });
});

// ============================================================================
// updateTargetOverride
// ============================================================================

describe('updateTargetOverride', () => {
  it('updates override fields and returns changes: 1', () => {
    const result = updateTargetOverride(SEEDS.PHOTO_1_ID, SEEDS.PHOTO_2_ID, 100.0, 8.0);
    assert.equal(result.changes, 1);

    const targets = getTargetsBySourceId(SEEDS.PHOTO_1_ID);
    assert.equal(targets[0].override_bearing, 100.0);
    assert.equal(targets[0].override_distance, 8.0);
  });

  it('accepts null values to clear overrides', () => {
    const result = updateTargetOverride(SEEDS.PHOTO_1_ID, SEEDS.PHOTO_2_ID, null, null);
    assert.equal(result.changes, 1);

    const targets = getTargetsBySourceId(SEEDS.PHOTO_1_ID);
    assert.equal(targets[0].override_bearing, null);
    assert.equal(targets[0].override_distance, null);
  });

  it('returns changes: 0 for non-existent target pair', () => {
    const result = updateTargetOverride('00000000-0000-0000-0000-000000000000', SEEDS.PHOTO_2_ID, 0, 0);
    assert.equal(result.changes, 0);
  });
});

// ============================================================================
// clearTargetOverride
// ============================================================================

describe('clearTargetOverride', () => {
  it('sets override fields to NULL', () => {
    // Re-set override first (previous tests may have cleared it)
    updateTargetOverride(SEEDS.PHOTO_1_ID, SEEDS.PHOTO_2_ID, 50.0, 10.0);
    let targets = getTargetsBySourceId(SEEDS.PHOTO_1_ID);
    assert.ok(targets[0].override_bearing !== null);

    const result = clearTargetOverride(SEEDS.PHOTO_1_ID, SEEDS.PHOTO_2_ID);
    assert.equal(result.changes, 1);

    // Verify cleared
    targets = getTargetsBySourceId(SEEDS.PHOTO_1_ID);
    assert.equal(targets[0].override_bearing, null);
    assert.equal(targets[0].override_distance, null);
  });

  it('returns changes: 0 for non-existent target pair', () => {
    const result = clearTargetOverride('00000000-0000-0000-0000-000000000000', SEEDS.PHOTO_2_ID);
    assert.equal(result.changes, 0);
  });
});
