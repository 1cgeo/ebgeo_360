/**
 * @module routes/calibration
 * @description Write endpoints for the calibration interface.
 * Allows updating photo mesh_rotation_y and target override bearing/distance.
 */

import {
  getPhotoById,
  getTargetsBySourceId,
  getTargetByPair,
  updatePhotoMeshRotationY,
  updatePhotoCameraHeight,
  updatePhotoMeshRotationX,
  updatePhotoMeshRotationZ,
  updatePhotoDistanceScale,
  updatePhotoMarkerScale,
  updateTargetOverride,
  clearTargetOverride,
  updateTargetVisibility,
  insertTarget,
  deleteTarget,
  getNearbyPhotos,
  updateCalibrationReviewed,
  getPhotosByProjectSlug,
  getReviewStatsByProjectSlug,
  batchUpdateMeshRotationY,
  batchUpdateCameraHeight,
  batchUpdateMeshRotationX,
  batchUpdateMeshRotationZ,
  batchUpdateDistanceScale,
  batchUpdateMarkerScale,
  batchResetReviewed,
} from '../db/queries.js';

export default async function calibrationRoutes(fastify) {
  // PUT /api/v1/photos/:uuid/calibration — update mesh_rotation_y
  fastify.put('/api/v1/photos/:uuid/calibration', async (request, reply) => {
    const { uuid } = request.params;
    const { mesh_rotation_y } = request.body || {};

    // Validate
    if (typeof mesh_rotation_y !== 'number' || Number.isNaN(mesh_rotation_y)) {
      reply.code(400);
      return { error: 'mesh_rotation_y must be a number' };
    }

    if (mesh_rotation_y < 0 || mesh_rotation_y > 360) {
      reply.code(400);
      return { error: 'mesh_rotation_y must be between 0 and 360' };
    }

    // Check photo exists
    const photo = getPhotoById(uuid);
    if (!photo) {
      reply.code(404);
      return { error: 'Photo not found' };
    }

    const result = updatePhotoMeshRotationY(uuid, mesh_rotation_y);
    if (result.changes === 0) {
      reply.code(500);
      return { error: 'Failed to update' };
    }

    return { ok: true, mesh_rotation_y };
  });

  // PUT /api/v1/photos/:uuid/height — update camera_height
  fastify.put('/api/v1/photos/:uuid/height', async (request, reply) => {
    const { uuid } = request.params;
    const { camera_height } = request.body || {};

    if (typeof camera_height !== 'number' || Number.isNaN(camera_height)) {
      reply.code(400);
      return { error: 'camera_height must be a number' };
    }

    if (camera_height < 0.1 || camera_height > 20) {
      reply.code(400);
      return { error: 'camera_height must be between 0.1 and 20' };
    }

    const photo = getPhotoById(uuid);
    if (!photo) {
      reply.code(404);
      return { error: 'Photo not found' };
    }

    const result = updatePhotoCameraHeight(uuid, camera_height);
    if (result.changes === 0) {
      reply.code(500);
      return { error: 'Failed to update' };
    }

    return { ok: true, camera_height };
  });

  // PUT /api/v1/photos/:uuid/rotation-x — update mesh_rotation_x
  fastify.put('/api/v1/photos/:uuid/rotation-x', async (request, reply) => {
    const { uuid } = request.params;
    const { mesh_rotation_x } = request.body || {};

    if (typeof mesh_rotation_x !== 'number' || Number.isNaN(mesh_rotation_x)) {
      reply.code(400);
      return { error: 'mesh_rotation_x must be a number' };
    }

    if (mesh_rotation_x < -30 || mesh_rotation_x > 30) {
      reply.code(400);
      return { error: 'mesh_rotation_x must be between -30 and 30' };
    }

    const photo = getPhotoById(uuid);
    if (!photo) {
      reply.code(404);
      return { error: 'Photo not found' };
    }

    const result = updatePhotoMeshRotationX(uuid, mesh_rotation_x);
    if (result.changes === 0) {
      reply.code(500);
      return { error: 'Failed to update' };
    }

    return { ok: true, mesh_rotation_x };
  });

  // PUT /api/v1/photos/:uuid/rotation-z — update mesh_rotation_z
  fastify.put('/api/v1/photos/:uuid/rotation-z', async (request, reply) => {
    const { uuid } = request.params;
    const { mesh_rotation_z } = request.body || {};

    if (typeof mesh_rotation_z !== 'number' || Number.isNaN(mesh_rotation_z)) {
      reply.code(400);
      return { error: 'mesh_rotation_z must be a number' };
    }

    if (mesh_rotation_z < -30 || mesh_rotation_z > 30) {
      reply.code(400);
      return { error: 'mesh_rotation_z must be between -30 and 30' };
    }

    const photo = getPhotoById(uuid);
    if (!photo) {
      reply.code(404);
      return { error: 'Photo not found' };
    }

    const result = updatePhotoMeshRotationZ(uuid, mesh_rotation_z);
    if (result.changes === 0) {
      reply.code(500);
      return { error: 'Failed to update' };
    }

    return { ok: true, mesh_rotation_z };
  });

  // PUT /api/v1/photos/:uuid/distance-scale — update distance_scale
  fastify.put('/api/v1/photos/:uuid/distance-scale', async (request, reply) => {
    const { uuid } = request.params;
    const { distance_scale } = request.body || {};

    if (typeof distance_scale !== 'number' || Number.isNaN(distance_scale)) {
      reply.code(400);
      return { error: 'distance_scale must be a number' };
    }

    if (distance_scale < 0.1 || distance_scale > 5.0) {
      reply.code(400);
      return { error: 'distance_scale must be between 0.1 and 5.0' };
    }

    const photo = getPhotoById(uuid);
    if (!photo) {
      reply.code(404);
      return { error: 'Photo not found' };
    }

    const result = updatePhotoDistanceScale(uuid, distance_scale);
    if (result.changes === 0) {
      reply.code(500);
      return { error: 'Failed to update' };
    }

    return { ok: true, distance_scale };
  });

  // PUT /api/v1/photos/:uuid/marker-scale — update marker_scale
  fastify.put('/api/v1/photos/:uuid/marker-scale', async (request, reply) => {
    const { uuid } = request.params;
    const { marker_scale } = request.body || {};

    if (typeof marker_scale !== 'number' || Number.isNaN(marker_scale)) {
      reply.code(400);
      return { error: 'marker_scale must be a number' };
    }

    if (marker_scale < 0.1 || marker_scale > 5.0) {
      reply.code(400);
      return { error: 'marker_scale must be between 0.1 and 5.0' };
    }

    const photo = getPhotoById(uuid);
    if (!photo) {
      reply.code(404);
      return { error: 'Photo not found' };
    }

    const result = updatePhotoMarkerScale(uuid, marker_scale);
    if (result.changes === 0) {
      reply.code(500);
      return { error: 'Failed to update' };
    }

    return { ok: true, marker_scale };
  });

  // PUT /api/v1/targets/:sourceId/:targetId/override — set override bearing/distance
  fastify.put('/api/v1/targets/:sourceId/:targetId/override', async (request, reply) => {
    const { sourceId, targetId } = request.params;
    const { override_bearing, override_distance } = request.body || {};

    // Validate bearing (degrees 0-360)
    if (override_bearing !== null && override_bearing !== undefined) {
      if (typeof override_bearing !== 'number' || Number.isNaN(override_bearing)) {
        reply.code(400);
        return { error: 'override_bearing must be a number or null' };
      }
      if (override_bearing < 0 || override_bearing > 360) {
        reply.code(400);
        return { error: 'override_bearing must be between 0 and 360' };
      }
    }

    // Validate distance (ground distance in meters)
    if (override_distance !== null && override_distance !== undefined) {
      if (typeof override_distance !== 'number' || Number.isNaN(override_distance)) {
        reply.code(400);
        return { error: 'override_distance must be a number or null' };
      }
      if (override_distance < 0.5 || override_distance > 500) {
        reply.code(400);
        return { error: 'override_distance must be between 0.5 and 500' };
      }
    }

    // Check source photo and target exist
    const photo = getPhotoById(sourceId);
    if (!photo) {
      reply.code(404);
      return { error: 'Source photo not found' };
    }

    const targets = getTargetsBySourceId(sourceId);
    const targetExists = targets.some(t => t.target_id === targetId);
    if (!targetExists) {
      reply.code(404);
      return { error: 'Target not found for this source' };
    }

    const bearing = override_bearing ?? null;
    const distance = override_distance ?? null;

    const result = updateTargetOverride(sourceId, targetId, bearing, distance);
    if (result.changes === 0) {
      reply.code(500);
      return { error: 'Failed to update' };
    }

    return { ok: true, override_bearing: bearing, override_distance: distance };
  });

  // DELETE /api/v1/targets/:sourceId/:targetId/override — clear overrides
  fastify.delete('/api/v1/targets/:sourceId/:targetId/override', async (request, reply) => {
    const { sourceId, targetId } = request.params;

    const result = clearTargetOverride(sourceId, targetId);
    if (result.changes === 0) {
      reply.code(404);
      return { error: 'Target not found' };
    }

    return { ok: true };
  });

  // PUT /api/v1/photos/:uuid/reviewed — mark photo as reviewed/unreviewed
  fastify.put('/api/v1/photos/:uuid/reviewed', async (request, reply) => {
    const { uuid } = request.params;
    const { reviewed } = request.body || {};

    if (typeof reviewed !== 'boolean') {
      reply.code(400);
      return { error: 'reviewed must be a boolean' };
    }

    const photo = getPhotoById(uuid);
    if (!photo) {
      reply.code(404);
      return { error: 'Photo not found' };
    }

    const result = updateCalibrationReviewed(uuid, reviewed);
    if (result.changes === 0) {
      reply.code(500);
      return { error: 'Failed to update' };
    }

    return { ok: true, reviewed };
  });

  // GET /api/v1/projects/:slug/photos — list photos for a project (calibration workflow)
  fastify.get('/api/v1/projects/:slug/photos', async (request, reply) => {
    const { slug } = request.params;

    const photos = getPhotosByProjectSlug(slug);
    if (!photos.length) {
      reply.code(404);
      return { error: 'Project not found or has no photos' };
    }

    const stats = getReviewStatsByProjectSlug(slug);

    return {
      photos: photos.map(p => ({
        id: p.id,
        displayName: p.display_name,
        sequenceNumber: p.sequence_number,
        reviewed: Boolean(p.calibration_reviewed),
      })),
      reviewStats: {
        total: stats.total,
        reviewed: stats.reviewed,
      },
    };
  });

  // POST /api/v1/projects/:slug/reset-reviewed — reset all photos to unreviewed
  fastify.post('/api/v1/projects/:slug/reset-reviewed', async (request, reply) => {
    const { slug } = request.params;

    const photos = getPhotosByProjectSlug(slug);
    if (!photos.length) {
      reply.code(404);
      return { error: 'Project not found or has no photos' };
    }

    const result = batchResetReviewed(slug);
    return { ok: true, photosReset: result.changes };
  });

  // PUT /api/v1/projects/:slug/batch-calibration — update calibration fields for all photos
  fastify.put('/api/v1/projects/:slug/batch-calibration', async (request, reply) => {
    const { slug } = request.params;
    const {
      mesh_rotation_y, camera_height,
      mesh_rotation_x, mesh_rotation_z, distance_scale, marker_scale,
    } = request.body || {};

    // Must provide at least one field
    if (
      mesh_rotation_y === undefined &&
      camera_height === undefined &&
      mesh_rotation_x === undefined &&
      mesh_rotation_z === undefined &&
      distance_scale === undefined &&
      marker_scale === undefined
    ) {
      reply.code(400);
      return { error: 'Must provide at least one calibration field' };
    }

    // Validate mesh_rotation_y if provided
    if (mesh_rotation_y !== undefined) {
      if (typeof mesh_rotation_y !== 'number' || Number.isNaN(mesh_rotation_y)) {
        reply.code(400);
        return { error: 'mesh_rotation_y must be a number' };
      }
      if (mesh_rotation_y < 0 || mesh_rotation_y > 360) {
        reply.code(400);
        return { error: 'mesh_rotation_y must be between 0 and 360' };
      }
    }

    // Validate camera_height if provided
    if (camera_height !== undefined) {
      if (typeof camera_height !== 'number' || Number.isNaN(camera_height)) {
        reply.code(400);
        return { error: 'camera_height must be a number' };
      }
      if (camera_height < 0.1 || camera_height > 20) {
        reply.code(400);
        return { error: 'camera_height must be between 0.1 and 20' };
      }
    }

    // Validate mesh_rotation_x if provided
    if (mesh_rotation_x !== undefined) {
      if (typeof mesh_rotation_x !== 'number' || Number.isNaN(mesh_rotation_x)) {
        reply.code(400);
        return { error: 'mesh_rotation_x must be a number' };
      }
      if (mesh_rotation_x < -30 || mesh_rotation_x > 30) {
        reply.code(400);
        return { error: 'mesh_rotation_x must be between -30 and 30' };
      }
    }

    // Validate mesh_rotation_z if provided
    if (mesh_rotation_z !== undefined) {
      if (typeof mesh_rotation_z !== 'number' || Number.isNaN(mesh_rotation_z)) {
        reply.code(400);
        return { error: 'mesh_rotation_z must be a number' };
      }
      if (mesh_rotation_z < -30 || mesh_rotation_z > 30) {
        reply.code(400);
        return { error: 'mesh_rotation_z must be between -30 and 30' };
      }
    }

    // Validate distance_scale if provided
    if (distance_scale !== undefined) {
      if (typeof distance_scale !== 'number' || Number.isNaN(distance_scale)) {
        reply.code(400);
        return { error: 'distance_scale must be a number' };
      }
      if (distance_scale < 0.1 || distance_scale > 5.0) {
        reply.code(400);
        return { error: 'distance_scale must be between 0.1 and 5.0' };
      }
    }

    // Validate marker_scale if provided
    if (marker_scale !== undefined) {
      if (typeof marker_scale !== 'number' || Number.isNaN(marker_scale)) {
        reply.code(400);
        return { error: 'marker_scale must be a number' };
      }
      if (marker_scale < 0.1 || marker_scale > 5.0) {
        reply.code(400);
        return { error: 'marker_scale must be between 0.1 and 5.0' };
      }
    }

    // Check project has photos
    const photos = getPhotosByProjectSlug(slug);
    if (!photos.length) {
      reply.code(404);
      return { error: 'Project not found or has no photos' };
    }

    const updated = {};

    if (mesh_rotation_y !== undefined) {
      const result = batchUpdateMeshRotationY(slug, mesh_rotation_y);
      updated.mesh_rotation_y = { value: mesh_rotation_y, photosUpdated: result.changes };
    }

    if (camera_height !== undefined) {
      const result = batchUpdateCameraHeight(slug, camera_height);
      updated.camera_height = { value: camera_height, photosUpdated: result.changes };
    }

    if (mesh_rotation_x !== undefined) {
      const result = batchUpdateMeshRotationX(slug, mesh_rotation_x);
      updated.mesh_rotation_x = { value: mesh_rotation_x, photosUpdated: result.changes };
    }

    if (mesh_rotation_z !== undefined) {
      const result = batchUpdateMeshRotationZ(slug, mesh_rotation_z);
      updated.mesh_rotation_z = { value: mesh_rotation_z, photosUpdated: result.changes };
    }

    if (distance_scale !== undefined) {
      const result = batchUpdateDistanceScale(slug, distance_scale);
      updated.distance_scale = { value: distance_scale, photosUpdated: result.changes };
    }

    if (marker_scale !== undefined) {
      const result = batchUpdateMarkerScale(slug, marker_scale);
      updated.marker_scale = { value: marker_scale, photosUpdated: result.changes };
    }

    return { ok: true, updated };
  });

  // PUT /api/v1/targets/:sourceId/:targetId/visibility — hide/show a target
  fastify.put('/api/v1/targets/:sourceId/:targetId/visibility', async (request, reply) => {
    const { sourceId, targetId } = request.params;
    const { hidden } = request.body || {};

    if (typeof hidden !== 'boolean') {
      reply.code(400);
      return { error: 'hidden must be a boolean' };
    }

    const photo = getPhotoById(sourceId);
    if (!photo) {
      reply.code(404);
      return { error: 'Source photo not found' };
    }

    const targets = getTargetsBySourceId(sourceId);
    const targetExists = targets.some(t => t.target_id === targetId);
    if (!targetExists) {
      reply.code(404);
      return { error: 'Target not found for this source' };
    }

    const result = updateTargetVisibility(sourceId, targetId, hidden);
    if (result.changes === 0) {
      reply.code(500);
      return { error: 'Failed to update' };
    }

    return { ok: true, hidden };
  });

  // GET /api/v1/photos/:uuid/nearby — find nearby unconnected photos
  fastify.get('/api/v1/photos/:uuid/nearby', async (request, reply) => {
    const { uuid } = request.params;
    const radius = Number(request.query.radius) || 100;

    const photo = getPhotoById(uuid);
    if (!photo) {
      reply.code(404);
      return { error: 'Photo not found' };
    }

    // Calculate bounding box from photo coords + radius
    const latOffset = radius / 111320;
    const lonOffset = radius / (111320 * Math.cos(photo.lat * Math.PI / 180));

    const minLon = photo.lon - lonOffset;
    const maxLon = photo.lon + lonOffset;
    const minLat = photo.lat - latOffset;
    const maxLat = photo.lat + latOffset;

    const nearby = getNearbyPhotos(uuid, minLon, maxLon, minLat, maxLat);

    // Calculate distance and bearing for each nearby photo
    const DEG_TO_RAD = Math.PI / 180;
    const R = 6_371_000;

    const photos = nearby.map(p => {
      const dLat = (p.lat - photo.lat) * DEG_TO_RAD;
      const dLon = (p.lon - photo.lon) * DEG_TO_RAD;
      const a = Math.sin(dLat / 2) ** 2
        + Math.cos(photo.lat * DEG_TO_RAD) * Math.cos(p.lat * DEG_TO_RAD)
        * Math.sin(dLon / 2) ** 2;
      const distance = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

      const y = Math.sin(dLon) * Math.cos(p.lat * DEG_TO_RAD);
      const x = Math.cos(photo.lat * DEG_TO_RAD) * Math.sin(p.lat * DEG_TO_RAD)
        - Math.sin(photo.lat * DEG_TO_RAD) * Math.cos(p.lat * DEG_TO_RAD) * Math.cos(dLon);
      const bearing = ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;

      return {
        id: p.id,
        displayName: p.display_name,
        lat: p.lat,
        lon: p.lon,
        ele: p.ele,
        distance: Math.round(distance * 100) / 100,
        bearing: Math.round(bearing * 100) / 100,
      };
    });

    // Sort by distance and filter to actual radius
    const filtered = photos
      .filter(p => p.distance <= radius)
      .sort((a, b) => a.distance - b.distance);

    return { photos: filtered };
  });

  // POST /api/v1/targets — create a new target connection
  fastify.post('/api/v1/targets', async (request, reply) => {
    const { source_id, target_id } = request.body || {};

    if (!source_id || !target_id) {
      reply.code(400);
      return { error: 'source_id and target_id are required' };
    }

    if (source_id === target_id) {
      reply.code(400);
      return { error: 'source_id and target_id must be different' };
    }

    const sourcePhoto = getPhotoById(source_id);
    if (!sourcePhoto) {
      reply.code(404);
      return { error: 'Source photo not found' };
    }

    const targetPhoto = getPhotoById(target_id);
    if (!targetPhoto) {
      reply.code(404);
      return { error: 'Target photo not found' };
    }

    if (sourcePhoto.project_id !== targetPhoto.project_id) {
      reply.code(400);
      return { error: 'Photos must be in the same project' };
    }

    // Check if connection already exists
    const existing = getTargetByPair(source_id, target_id);
    if (existing) {
      reply.code(409);
      return { error: 'Target connection already exists' };
    }

    // Calculate distance and bearing
    const DEG_TO_RAD = Math.PI / 180;
    const R = 6_371_000;
    const dLat = (targetPhoto.lat - sourcePhoto.lat) * DEG_TO_RAD;
    const dLon = (targetPhoto.lon - sourcePhoto.lon) * DEG_TO_RAD;
    const a = Math.sin(dLat / 2) ** 2
      + Math.cos(sourcePhoto.lat * DEG_TO_RAD) * Math.cos(targetPhoto.lat * DEG_TO_RAD)
      * Math.sin(dLon / 2) ** 2;
    const distanceM = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    const y = Math.sin(dLon) * Math.cos(targetPhoto.lat * DEG_TO_RAD);
    const x = Math.cos(sourcePhoto.lat * DEG_TO_RAD) * Math.sin(targetPhoto.lat * DEG_TO_RAD)
      - Math.sin(sourcePhoto.lat * DEG_TO_RAD) * Math.cos(targetPhoto.lat * DEG_TO_RAD) * Math.cos(dLon);
    const bearingDeg = ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;

    const result = insertTarget(
      source_id, target_id,
      Math.round(distanceM * 100) / 100,
      Math.round(bearingDeg * 100) / 100,
    );

    if (result.changes === 0) {
      reply.code(500);
      return { error: 'Failed to create target' };
    }

    reply.code(201);
    return {
      ok: true,
      target: {
        source_id,
        target_id,
        distance_m: Math.round(distanceM * 100) / 100,
        bearing_deg: Math.round(bearingDeg * 100) / 100,
        is_next: false,
        is_original: false,
      },
    };
  });

  // DELETE /api/v1/targets/:sourceId/:targetId — remove a manually-created target
  fastify.delete('/api/v1/targets/:sourceId/:targetId', async (request, reply) => {
    const { sourceId, targetId } = request.params;

    const existing = getTargetByPair(sourceId, targetId);
    if (!existing) {
      reply.code(404);
      return { error: 'Target not found' };
    }

    if (existing.is_original) {
      reply.code(400);
      return { error: 'Cannot delete original targets. Use visibility to hide them instead.' };
    }

    const result = deleteTarget(sourceId, targetId);
    if (result.changes === 0) {
      reply.code(500);
      return { error: 'Failed to delete' };
    }

    return { ok: true };
  });
}
