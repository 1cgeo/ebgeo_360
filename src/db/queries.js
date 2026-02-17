/**
 * @module db/queries
 * @description Prepared statement wrappers for index.db and project DBs.
 * All queries are prepared once and reused for performance.
 */

import { getIndexDb, getProjectDb } from './connection.js';

// Lazily initialized prepared statements
let _stmts = null;

function stmts() {
  if (_stmts) return _stmts;

  const db = getIndexDb();

  _stmts = {
    // ---- Projects ----
    allProjects: db.prepare(`
      SELECT id, slug, name, description, capture_date, location,
             center_lat, center_lon, entry_photo_id, photo_count, db_filename
      FROM projects
      ORDER BY name
    `),

    projectBySlug: db.prepare(`
      SELECT id, slug, name, description, capture_date, location,
             center_lat, center_lon, entry_photo_id, photo_count, db_filename
      FROM projects
      WHERE slug = ?
    `),

    projectByPhotoId: db.prepare(`
      SELECT p.id, p.slug, p.name, p.db_filename, p.capture_date
      FROM projects p
      JOIN photos ph ON ph.project_id = p.id
      WHERE ph.id = ?
    `),

    // ---- Photos ----
    photoById: db.prepare(`
      SELECT id, project_id, original_name, display_name, sequence_number,
             lat, lon, ele, heading, camera_height,
             mesh_rotation_y, mesh_rotation_x, mesh_rotation_z,
             distance_scale, marker_scale, floor_level,
             full_size_bytes, preview_size_bytes,
             calibration_reviewed
      FROM photos
      WHERE id = ?
    `),

    photoByOriginalName: db.prepare(`
      SELECT id, project_id, original_name, display_name
      FROM photos
      WHERE original_name = ?
    `),

    // ---- Targets ----
    targetsBySourceId: db.prepare(`
      SELECT t.target_id, t.distance_m, t.bearing_deg, t.is_next, t.is_original,
             t.override_bearing, t.override_distance, t.override_height, t.hidden,
             ph.lat, ph.lon, ph.ele, ph.display_name
      FROM targets t
      JOIN photos ph ON ph.id = t.target_id
      WHERE t.source_id = ?
      ORDER BY t.is_next DESC, t.distance_m ASC
    `),

    visibleTargetsBySourceId: db.prepare(`
      SELECT t.target_id, t.distance_m, t.bearing_deg, t.is_next, t.is_original,
             t.override_bearing, t.override_distance, t.override_height,
             ph.lat, ph.lon, ph.ele, ph.display_name
      FROM targets t
      JOIN photos ph ON ph.id = t.target_id
      WHERE t.source_id = ? AND t.hidden = 0
      ORDER BY t.is_next DESC, t.distance_m ASC
    `),

    // ---- Calibration (writes) ----
    updateMeshRotationY: db.prepare(
      'UPDATE photos SET mesh_rotation_y = ? WHERE id = ?'
    ),

    updateCameraHeight: db.prepare(
      'UPDATE photos SET camera_height = ? WHERE id = ?'
    ),

    updateTargetOverride: db.prepare(
      'UPDATE targets SET override_bearing = ?, override_distance = ?, override_height = ? WHERE source_id = ? AND target_id = ?'
    ),

    clearTargetOverride: db.prepare(
      'UPDATE targets SET override_bearing = NULL, override_distance = NULL, override_height = NULL WHERE source_id = ? AND target_id = ?'
    ),

    updateTargetVisibility: db.prepare(
      'UPDATE targets SET hidden = ? WHERE source_id = ? AND target_id = ?'
    ),

    insertTarget: db.prepare(
      'INSERT INTO targets (source_id, target_id, distance_m, bearing_deg, is_next, is_original) VALUES (?, ?, ?, ?, 0, 0)'
    ),

    deleteTarget: db.prepare(
      'DELETE FROM targets WHERE source_id = ? AND target_id = ? AND is_original = 0'
    ),

    targetByPair: db.prepare(
      'SELECT source_id, target_id, is_original FROM targets WHERE source_id = ? AND target_id = ?'
    ),

    nearbyPhotos: db.prepare(`
      SELECT ph.id, ph.display_name, ph.lat, ph.lon, ph.ele
      FROM photos_rowid pr
      JOIN photos_rtree rt ON rt.rowid_id = pr.rowid_id
      JOIN photos ph ON ph.id = pr.photo_id
      WHERE ph.project_id = (SELECT project_id FROM photos WHERE id = ?)
        AND ph.id != ?
        AND ph.id NOT IN (SELECT target_id FROM targets WHERE source_id = ?)
        AND rt.min_lon >= ? AND rt.max_lon <= ?
        AND rt.min_lat >= ? AND rt.max_lat <= ?
      ORDER BY ph.sequence_number
    `),

    // ---- Calibration review ----
    updateCalibrationReviewed: db.prepare(
      'UPDATE photos SET calibration_reviewed = ? WHERE id = ?'
    ),

    photosByProjectSlug: db.prepare(`
      SELECT ph.id, ph.display_name, ph.sequence_number, ph.calibration_reviewed
      FROM photos ph
      JOIN projects p ON p.id = ph.project_id
      WHERE p.slug = ?
      ORDER BY ph.sequence_number ASC
    `),

    reviewStatsByProjectSlug: db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN ph.calibration_reviewed = 1 THEN 1 ELSE 0 END) AS reviewed
      FROM photos ph
      JOIN projects p ON p.id = ph.project_id
      WHERE p.slug = ?
    `),

    // ---- Batch calibration (writes) ----
    batchUpdateMeshRotationY: db.prepare(`
      UPDATE photos SET mesh_rotation_y = ?
      WHERE project_id = (SELECT id FROM projects WHERE slug = ?)
    `),

    batchUpdateCameraHeight: db.prepare(`
      UPDATE photos SET camera_height = ?
      WHERE project_id = (SELECT id FROM projects WHERE slug = ?)
    `),

    // ---- Mesh rotation X/Z and distance scale ----
    updateMeshRotationX: db.prepare(
      'UPDATE photos SET mesh_rotation_x = ? WHERE id = ?'
    ),

    updateMeshRotationZ: db.prepare(
      'UPDATE photos SET mesh_rotation_z = ? WHERE id = ?'
    ),

    updateDistanceScale: db.prepare(
      'UPDATE photos SET distance_scale = ? WHERE id = ?'
    ),

    updateMarkerScale: db.prepare(
      'UPDATE photos SET marker_scale = ? WHERE id = ?'
    ),

    batchUpdateMeshRotationX: db.prepare(`
      UPDATE photos SET mesh_rotation_x = ?
      WHERE project_id = (SELECT id FROM projects WHERE slug = ?)
    `),

    batchUpdateMeshRotationZ: db.prepare(`
      UPDATE photos SET mesh_rotation_z = ?
      WHERE project_id = (SELECT id FROM projects WHERE slug = ?)
    `),

    batchUpdateDistanceScale: db.prepare(`
      UPDATE photos SET distance_scale = ?
      WHERE project_id = (SELECT id FROM projects WHERE slug = ?)
    `),

    batchUpdateMarkerScale: db.prepare(`
      UPDATE photos SET marker_scale = ?
      WHERE project_id = (SELECT id FROM projects WHERE slug = ?)
    `),

    // ---- Reset reviewed ----
    batchResetReviewed: db.prepare(`
      UPDATE photos SET calibration_reviewed = 0
      WHERE project_id = (SELECT id FROM projects WHERE slug = ?)
    `),
  };

  return _stmts;
}

// ---- Public query functions ----

export function getAllProjects() {
  return stmts().allProjects.all();
}

export function getProjectBySlug(slug) {
  return stmts().projectBySlug.get(slug);
}

export function getProjectByPhotoId(photoId) {
  return stmts().projectByPhotoId.get(photoId);
}

export function getPhotoById(photoId) {
  return stmts().photoById.get(photoId);
}

export function getPhotoByOriginalName(originalName) {
  return stmts().photoByOriginalName.get(originalName);
}

export function getTargetsBySourceId(sourceId) {
  return stmts().targetsBySourceId.all(sourceId);
}

export function getVisibleTargetsBySourceId(sourceId) {
  return stmts().visibleTargetsBySourceId.all(sourceId);
}

/**
 * Reads an image BLOB from a project database.
 * Uses better-sqlite3's synchronous API. For streaming in the HTTP handler,
 * the caller wraps the Buffer in a Readable stream.
 *
 * @param {string} dbFilename - Project DB filename (e.g., "alegrete.db")
 * @param {string} photoId - Photo UUID
 * @param {'full_webp'|'preview_webp'} column - Which image variant to read
 * @returns {Buffer|null} The image data or null if not found
 */
export function getImageBlob(dbFilename, photoId, column) {
  const db = getProjectDb(dbFilename);
  if (!db) return null;

  // Validate column name to prevent SQL injection
  const validColumns = ['full_webp', 'preview_webp'];
  if (!validColumns.includes(column)) return null;

  // Use a fresh prepared statement per project DB
  const stmt = db.prepare(`SELECT ${column} FROM images WHERE photo_id = ?`);
  const row = stmt.get(photoId);
  return row ? row[column] : null;
}

// ---- Calibration write functions ----

/**
 * Updates the mesh rotation for a photo.
 * @param {string} photoId - Photo UUID
 * @param {number} meshRotationY - Rotation in degrees (0-360)
 * @returns {Object} Run result with changes count
 */
export function updatePhotoMeshRotationY(photoId, meshRotationY) {
  return stmts().updateMeshRotationY.run(meshRotationY, photoId);
}

/**
 * Updates the camera height for a photo.
 * @param {string} photoId - Photo UUID
 * @param {number} cameraHeight - Height in meters (0.5-10)
 * @returns {Object} Run result with changes count
 */
export function updatePhotoCameraHeight(photoId, cameraHeight) {
  return stmts().updateCameraHeight.run(cameraHeight, photoId);
}

/**
 * Sets override bearing/distance/height for a target.
 * @param {string} sourceId - Source photo UUID
 * @param {string} targetId - Target photo UUID
 * @param {number|null} overrideBearing - Bearing 0-360 degrees or null
 * @param {number|null} overrideDistance - Ground distance 0.5-500 meters or null
 * @param {number|null} [overrideHeight=null] - Vertical offset in meters or null (0 = ground)
 * @returns {Object} Run result with changes count
 */
export function updateTargetOverride(sourceId, targetId, overrideBearing, overrideDistance, overrideHeight = null) {
  return stmts().updateTargetOverride.run(overrideBearing, overrideDistance, overrideHeight, sourceId, targetId);
}

/**
 * Clears override bearing/distance for a target (sets to NULL).
 * @param {string} sourceId - Source photo UUID
 * @param {string} targetId - Target photo UUID
 * @returns {Object} Run result with changes count
 */
export function clearTargetOverride(sourceId, targetId) {
  return stmts().clearTargetOverride.run(sourceId, targetId);
}

/**
 * Sets the hidden flag for a target.
 * @param {string} sourceId - Source photo UUID
 * @param {string} targetId - Target photo UUID
 * @param {boolean} hidden - Whether to hide the target
 * @returns {Object} Run result with changes count
 */
export function updateTargetVisibility(sourceId, targetId, hidden) {
  return stmts().updateTargetVisibility.run(hidden ? 1 : 0, sourceId, targetId);
}

/**
 * Inserts a new manually-created target connection.
 * @param {string} sourceId - Source photo UUID
 * @param {string} targetId - Target photo UUID
 * @param {number} distanceM - Distance in meters
 * @param {number} bearingDeg - Bearing in degrees (0-360)
 * @returns {Object} Run result with changes count
 */
export function insertTarget(sourceId, targetId, distanceM, bearingDeg) {
  return stmts().insertTarget.run(sourceId, targetId, distanceM, bearingDeg);
}

/**
 * Deletes a manually-created target (is_original=0 only).
 * @param {string} sourceId - Source photo UUID
 * @param {string} targetId - Target photo UUID
 * @returns {Object} Run result with changes count
 */
export function deleteTarget(sourceId, targetId) {
  return stmts().deleteTarget.run(sourceId, targetId);
}

/**
 * Gets a single target by source/target pair.
 * @param {string} sourceId - Source photo UUID
 * @param {string} targetId - Target photo UUID
 * @returns {Object|undefined} Target row or undefined
 */
export function getTargetByPair(sourceId, targetId) {
  return stmts().targetByPair.get(sourceId, targetId);
}

/**
 * Finds nearby photos within a bounding box that are not already targets.
 * @param {string} sourceId - Source photo UUID
 * @param {number} minLon - Minimum longitude
 * @param {number} maxLon - Maximum longitude
 * @param {number} minLat - Minimum latitude
 * @param {number} maxLat - Maximum latitude
 * @returns {Array} Array of nearby photo rows
 */
export function getNearbyPhotos(sourceId, minLon, maxLon, minLat, maxLat) {
  return stmts().nearbyPhotos.all(sourceId, sourceId, sourceId, minLon, maxLon, minLat, maxLat);
}

// ---- Calibration review functions ----

/**
 * Sets the calibration_reviewed flag for a photo.
 * @param {string} photoId - Photo UUID
 * @param {boolean} reviewed - Whether the photo has been reviewed
 * @returns {Object} Run result with changes count
 */
export function updateCalibrationReviewed(photoId, reviewed) {
  return stmts().updateCalibrationReviewed.run(reviewed ? 1 : 0, photoId);
}

/**
 * Gets all photos for a project by slug (for calibration review workflow).
 * @param {string} slug - Project slug
 * @returns {Array} Photo list with id, display_name, sequence_number, calibration_reviewed
 */
export function getPhotosByProjectSlug(slug) {
  return stmts().photosByProjectSlug.all(slug);
}

/**
 * Gets review stats (total/reviewed count) for a project.
 * @param {string} slug - Project slug
 * @returns {{total: number, reviewed: number}}
 */
export function getReviewStatsByProjectSlug(slug) {
  return stmts().reviewStatsByProjectSlug.get(slug);
}

// ---- Batch calibration functions ----

/**
 * Updates mesh_rotation_y for all photos in a project.
 * @param {string} slug - Project slug
 * @param {number} meshRotationY - Rotation in degrees (0-360)
 * @returns {Object} Run result with changes count
 */
export function batchUpdateMeshRotationY(slug, meshRotationY) {
  return stmts().batchUpdateMeshRotationY.run(meshRotationY, slug);
}

/**
 * Updates camera_height for all photos in a project.
 * @param {string} slug - Project slug
 * @param {number} cameraHeight - Height in meters
 * @returns {Object} Run result with changes count
 */
export function batchUpdateCameraHeight(slug, cameraHeight) {
  return stmts().batchUpdateCameraHeight.run(cameraHeight, slug);
}

// ---- Mesh rotation X/Z, distance scale, and review reset ----

/**
 * Updates mesh_rotation_x for a photo.
 * @param {string} photoId - Photo UUID
 * @param {number} meshRotationX - Rotation in degrees (-30 to +30)
 * @returns {Object} Run result with changes count
 */
export function updatePhotoMeshRotationX(photoId, meshRotationX) {
  return stmts().updateMeshRotationX.run(meshRotationX, photoId);
}

/**
 * Updates mesh_rotation_z for a photo.
 * @param {string} photoId - Photo UUID
 * @param {number} meshRotationZ - Rotation in degrees (-30 to +30)
 * @returns {Object} Run result with changes count
 */
export function updatePhotoMeshRotationZ(photoId, meshRotationZ) {
  return stmts().updateMeshRotationZ.run(meshRotationZ, photoId);
}

/**
 * Updates distance_scale for a photo.
 * @param {string} photoId - Photo UUID
 * @param {number} distanceScale - Scale multiplier (0.1-5.0)
 * @returns {Object} Run result with changes count
 */
export function updatePhotoDistanceScale(photoId, distanceScale) {
  return stmts().updateDistanceScale.run(distanceScale, photoId);
}

/**
 * Updates marker_scale for a photo.
 * @param {string} photoId - Photo UUID
 * @param {number} markerScale - Scale multiplier (0.1-5.0)
 * @returns {Object} Run result with changes count
 */
export function updatePhotoMarkerScale(photoId, markerScale) {
  return stmts().updateMarkerScale.run(markerScale, photoId);
}

/**
 * Updates mesh_rotation_x for all photos in a project.
 * @param {string} slug - Project slug
 * @param {number} meshRotationX - Rotation in degrees
 * @returns {Object} Run result with changes count
 */
export function batchUpdateMeshRotationX(slug, meshRotationX) {
  return stmts().batchUpdateMeshRotationX.run(meshRotationX, slug);
}

/**
 * Updates mesh_rotation_z for all photos in a project.
 * @param {string} slug - Project slug
 * @param {number} meshRotationZ - Rotation in degrees
 * @returns {Object} Run result with changes count
 */
export function batchUpdateMeshRotationZ(slug, meshRotationZ) {
  return stmts().batchUpdateMeshRotationZ.run(meshRotationZ, slug);
}

/**
 * Updates distance_scale for all photos in a project.
 * @param {string} slug - Project slug
 * @param {number} distanceScale - Scale multiplier
 * @returns {Object} Run result with changes count
 */
export function batchUpdateDistanceScale(slug, distanceScale) {
  return stmts().batchUpdateDistanceScale.run(distanceScale, slug);
}

/**
 * Updates marker_scale for all photos in a project.
 * @param {string} slug - Project slug
 * @param {number} markerScale - Scale multiplier
 * @returns {Object} Run result with changes count
 */
export function batchUpdateMarkerScale(slug, markerScale) {
  return stmts().batchUpdateMarkerScale.run(markerScale, slug);
}

/**
 * Resets calibration_reviewed to 0 for all photos in a project.
 * @param {string} slug - Project slug
 * @returns {Object} Run result with changes count
 */
export function batchResetReviewed(slug) {
  return stmts().batchResetReviewed.run(slug);
}

/**
 * Resets prepared statements (for testing or after schema changes).
 */
export function resetStatements() {
  _stmts = null;
}
