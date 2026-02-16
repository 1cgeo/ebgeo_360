/**
 * @fileoverview API client for the Street View 360 calibration service.
 * All endpoints are same-origin (served from the same Fastify server).
 */

const BASE = '/api/v1';

/**
 * Fetches all projects from the service.
 * @returns {Promise<Array>} Array of project objects
 */
export async function fetchProjects() {
    const response = await fetch(`${BASE}/projects`);
    if (!response.ok) {
        throw new Error(`Failed to fetch projects (HTTP ${response.status})`);
    }
    const data = await response.json();
    return data.projects;
}

/**
 * Fetches metadata for a photo by UUID.
 * @param {string} photoId - Photo UUID
 * @returns {Promise<Object>} Metadata with camera and targets
 */
export async function fetchPhotoMetadata(photoId) {
    const response = await fetch(`${BASE}/photos/${photoId}?include_hidden=true`, {
        cache: 'no-cache',
    });
    if (!response.ok) {
        throw new Error(`Photo not found: ${photoId} (HTTP ${response.status})`);
    }
    return response.json();
}

/**
 * Returns the URL for a photo image at a given quality.
 * Does not perform a fetch -- just builds the URL string.
 * @param {string} photoId - Photo UUID
 * @param {'full'|'preview'} [quality='full'] - Image quality variant
 * @returns {string} Image URL
 */
export function getPhotoImageUrl(photoId, quality = 'full') {
    return `${BASE}/photos/${photoId}/image?quality=${quality}`;
}

/**
 * Saves the mesh_rotation_y calibration value for a photo.
 * @param {string} photoId - Photo UUID
 * @param {number} meshRotationY - New mesh_rotation_y value in degrees
 * @returns {Promise<Object>} Server response
 */
export async function saveCalibration(photoId, meshRotationY) {
    const response = await fetch(`${BASE}/photos/${photoId}/calibration`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mesh_rotation_y: meshRotationY }),
    });
    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`Failed to save calibration for ${photoId} (HTTP ${response.status}): ${text}`);
    }
    return response.json();
}

/**
 * Saves the camera_height calibration value for a photo.
 * @param {string} photoId - Photo UUID
 * @param {number} cameraHeight - New camera height in meters
 * @returns {Promise<Object>} Server response
 */
export async function saveCameraHeight(photoId, cameraHeight) {
    const response = await fetch(`${BASE}/photos/${photoId}/height`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ camera_height: cameraHeight }),
    });
    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`Failed to save camera height for ${photoId} (HTTP ${response.status}): ${text}`);
    }
    return response.json();
}

/**
 * Saves a target bearing/distance override.
 * @param {string} sourceId - Source photo UUID
 * @param {string} targetId - Target photo UUID
 * @param {number} bearing - Override bearing in degrees (0-360)
 * @param {number} distance - Override ground distance in meters (0.5-500)
 * @returns {Promise<Object>} Server response
 */
export async function saveTargetOverride(sourceId, targetId, bearing, distance) {
    const response = await fetch(`${BASE}/targets/${sourceId}/${targetId}/override`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ override_bearing: bearing, override_distance: distance }),
    });
    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(
            `Failed to save target override ${sourceId} -> ${targetId} (HTTP ${response.status}): ${text}`
        );
    }
    return response.json();
}

/**
 * Clears a target bearing/distance override.
 * @param {string} sourceId - Source photo UUID
 * @param {string} targetId - Target photo UUID
 * @returns {Promise<Object>} Server response
 */
export async function clearTargetOverride(sourceId, targetId) {
    const response = await fetch(`${BASE}/targets/${sourceId}/${targetId}/override`, {
        method: 'DELETE',
    });
    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(
            `Failed to clear target override ${sourceId} -> ${targetId} (HTTP ${response.status}): ${text}`
        );
    }
    return response.json();
}

/**
 * Marks a photo as reviewed or unreviewed.
 * @param {string} photoId - Photo UUID
 * @param {boolean} reviewed - Whether the photo is reviewed
 * @returns {Promise<Object>} Server response
 */
export async function setPhotoReviewed(photoId, reviewed) {
    const response = await fetch(`${BASE}/photos/${photoId}/reviewed`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reviewed }),
    });
    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`Failed to set reviewed for ${photoId} (HTTP ${response.status}): ${text}`);
    }
    return response.json();
}

/**
 * Fetches the photo list for a project (calibration workflow).
 * @param {string} slug - Project slug
 * @returns {Promise<{photos: Array, reviewStats: {total: number, reviewed: number}}>}
 */
export async function fetchProjectPhotos(slug) {
    const response = await fetch(`${BASE}/projects/${slug}/photos`, {
        cache: 'no-cache',
    });
    if (!response.ok) {
        throw new Error(`Failed to fetch photos for project ${slug} (HTTP ${response.status})`);
    }
    return response.json();
}

/**
 * Saves the mesh_rotation_x calibration value for a photo.
 * @param {string} photoId - Photo UUID
 * @param {number} meshRotationX - New mesh_rotation_x value in degrees
 * @returns {Promise<Object>} Server response
 */
export async function saveMeshRotationX(photoId, meshRotationX) {
    const response = await fetch(`${BASE}/photos/${photoId}/rotation-x`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mesh_rotation_x: meshRotationX }),
    });
    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`Failed to save mesh_rotation_x for ${photoId} (HTTP ${response.status}): ${text}`);
    }
    return response.json();
}

/**
 * Saves the mesh_rotation_z calibration value for a photo.
 * @param {string} photoId - Photo UUID
 * @param {number} meshRotationZ - New mesh_rotation_z value in degrees
 * @returns {Promise<Object>} Server response
 */
export async function saveMeshRotationZ(photoId, meshRotationZ) {
    const response = await fetch(`${BASE}/photos/${photoId}/rotation-z`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mesh_rotation_z: meshRotationZ }),
    });
    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`Failed to save mesh_rotation_z for ${photoId} (HTTP ${response.status}): ${text}`);
    }
    return response.json();
}

/**
 * Saves the distance_scale calibration value for a photo.
 * @param {string} photoId - Photo UUID
 * @param {number} distanceScale - New distance scale multiplier
 * @returns {Promise<Object>} Server response
 */
export async function saveDistanceScale(photoId, distanceScale) {
    const response = await fetch(`${BASE}/photos/${photoId}/distance-scale`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ distance_scale: distanceScale }),
    });
    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`Failed to save distance_scale for ${photoId} (HTTP ${response.status}): ${text}`);
    }
    return response.json();
}

/**
 * Saves the marker_scale calibration value for a photo.
 * @param {string} photoId - Photo UUID
 * @param {number} markerScale - New marker scale multiplier
 * @returns {Promise<Object>} Server response
 */
export async function saveMarkerScale(photoId, markerScale) {
    const response = await fetch(`${BASE}/photos/${photoId}/marker-scale`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ marker_scale: markerScale }),
    });
    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`Failed to save marker_scale for ${photoId} (HTTP ${response.status}): ${text}`);
    }
    return response.json();
}

/**
 * Resets all photos in a project to unreviewed.
 * @param {string} slug - Project slug
 * @returns {Promise<Object>} Server response with photosReset count
 */
export async function resetProjectReviewed(slug) {
    const response = await fetch(`${BASE}/projects/${slug}/reset-reviewed`, {
        method: 'POST',
    });
    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`Failed to reset reviewed for project ${slug} (HTTP ${response.status}): ${text}`);
    }
    return response.json();
}

/**
 * Batch updates calibration fields for all photos in a project.
 * @param {string} slug - Project slug
 * @param {Object} values - Values to update
 * @param {number} [values.mesh_rotation_y] - New mesh_rotation_y for all photos
 * @param {number} [values.camera_height] - New camera_height for all photos
 * @returns {Promise<Object>} Server response with update counts
 */
export async function batchUpdateProject(slug, values) {
    const response = await fetch(`${BASE}/projects/${slug}/batch-calibration`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
    });
    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`Failed to batch update project ${slug} (HTTP ${response.status}): ${text}`);
    }
    return response.json();
}

/**
 * Saves the visibility (hidden) state of a target.
 * @param {string} sourceId - Source photo UUID
 * @param {string} targetId - Target photo UUID
 * @param {boolean} hidden - Whether the target should be hidden
 * @returns {Promise<Object>} Server response
 */
export async function saveTargetVisibility(sourceId, targetId, hidden) {
    const response = await fetch(`${BASE}/targets/${sourceId}/${targetId}/visibility`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hidden }),
    });
    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(
            `Failed to set visibility ${sourceId} -> ${targetId} (HTTP ${response.status}): ${text}`
        );
    }
    return response.json();
}

/**
 * Fetches nearby unconnected photos for a given photo.
 * @param {string} photoId - Photo UUID
 * @param {number} [radius=100] - Search radius in meters
 * @returns {Promise<{photos: Array}>} Nearby photos with distance and bearing
 */
export async function fetchNearbyPhotos(photoId, radius = 100) {
    const response = await fetch(`${BASE}/photos/${photoId}/nearby?radius=${radius}`, {
        cache: 'no-cache',
    });
    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`Failed to fetch nearby photos for ${photoId} (HTTP ${response.status}): ${text}`);
    }
    return response.json();
}

/**
 * Creates a new target connection between two photos.
 * @param {string} sourceId - Source photo UUID
 * @param {string} targetId - Target photo UUID
 * @returns {Promise<Object>} Server response with the created target
 */
export async function createTarget(sourceId, targetId) {
    const response = await fetch(`${BASE}/targets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source_id: sourceId, target_id: targetId }),
    });
    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(
            `Failed to create target ${sourceId} -> ${targetId} (HTTP ${response.status}): ${text}`
        );
    }
    return response.json();
}

/**
 * Deletes a manually-created target connection.
 * @param {string} sourceId - Source photo UUID
 * @param {string} targetId - Target photo UUID
 * @returns {Promise<Object>} Server response
 */
export async function deleteTargetConnection(sourceId, targetId) {
    const response = await fetch(`${BASE}/targets/${sourceId}/${targetId}`, {
        method: 'DELETE',
    });
    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(
            `Failed to delete target ${sourceId} -> ${targetId} (HTTP ${response.status}): ${text}`
        );
    }
    return response.json();
}
