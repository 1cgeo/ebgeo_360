/**
 * @fileoverview Central state management for the Street View 360 calibration interface.
 * Simple event emitter pattern for tracking calibration edits, dirty state, and target overrides.
 */

// ============================================================================
// STATE
// ============================================================================

export const state = {
    currentPhotoId: null,
    currentMetadata: null,
    originalMeshRotationY: null,
    editedMeshRotationY: null,
    originalCameraHeight: null,
    editedCameraHeight: null,
    originalMeshRotationX: null,
    editedMeshRotationX: null,
    originalMeshRotationZ: null,
    editedMeshRotationZ: null,
    originalDistanceScale: null,
    editedDistanceScale: null,
    originalMarkerScale: null,
    editedMarkerScale: null,
    originalTargetOverrides: new Map(),
    editedTargetOverrides: new Map(),
    originalTargetHidden: new Map(),   // targetId -> boolean
    editedTargetHidden: new Map(),     // targetId -> boolean
    nearbyPhotos: [],                  // nearby unconnected photos from API
    selectedTargetId: null,
    setFromClickMode: false,
    // Review workflow
    currentProjectSlug: null,
    projectPhotos: [],         // [{id, displayName, sequenceNumber, reviewed}]
    reviewStats: null,         // {total, reviewed}
    calibrationReviewed: false,
};

// ============================================================================
// LISTENERS
// ============================================================================

const listeners = new Set();

/**
 * Subscribes to state changes.
 * @param {Function} fn - Callback invoked with the current state on every change
 * @returns {Function} Unsubscribe function
 */
export function onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

/**
 * Notifies all listeners of a state change.
 */
function notify() {
    listeners.forEach(fn => fn(state));
}

// ============================================================================
// COMPUTED
// ============================================================================

/**
 * Returns true if any calibration value has been edited and differs from the original.
 * @returns {boolean}
 */
export function isDirty() {
    // Check mesh_rotation_y
    if (
        state.editedMeshRotationY !== null &&
        state.editedMeshRotationY !== state.originalMeshRotationY
    ) {
        return true;
    }

    // Check camera_height
    if (
        state.editedCameraHeight !== null &&
        state.editedCameraHeight !== state.originalCameraHeight
    ) {
        return true;
    }

    // Check mesh_rotation_x
    if (
        state.editedMeshRotationX !== null &&
        state.editedMeshRotationX !== state.originalMeshRotationX
    ) {
        return true;
    }

    // Check mesh_rotation_z
    if (
        state.editedMeshRotationZ !== null &&
        state.editedMeshRotationZ !== state.originalMeshRotationZ
    ) {
        return true;
    }

    // Check distance_scale
    if (
        state.editedDistanceScale !== null &&
        state.editedDistanceScale !== state.originalDistanceScale
    ) {
        return true;
    }

    // Check marker_scale
    if (
        state.editedMarkerScale !== null &&
        state.editedMarkerScale !== state.originalMarkerScale
    ) {
        return true;
    }

    // Check target overrides
    for (const [targetId, edited] of state.editedTargetOverrides) {
        const original = state.originalTargetOverrides.get(targetId);
        const origB = original?.bearing ?? null;
        const origD = original?.distance ?? null;
        const origH = original?.height ?? 0;
        if (edited.bearing !== origB || edited.distance !== origD || (edited.height ?? 0) !== origH) {
            return true;
        }
    }

    // Check target hidden changes
    for (const [targetId, editedHidden] of state.editedTargetHidden) {
        const originalHidden = state.originalTargetHidden.get(targetId) ?? false;
        if (editedHidden !== originalHidden) {
            return true;
        }
    }
    // Check if a target was un-hidden (removed from editedTargetHidden but exists in original)
    for (const [targetId] of state.originalTargetHidden) {
        if (!state.editedTargetHidden.has(targetId)) {
            return true;
        }
    }

    return false;
}

// ============================================================================
// ACTIONS
// ============================================================================

/**
 * Loads a photo into state, resetting all edits.
 * @param {string} photoId - Photo UUID
 * @param {Object} metadata - Photo metadata from the API
 */
export function loadPhoto(photoId, metadata) {
    state.currentPhotoId = photoId;
    state.currentMetadata = metadata;

    const meshRotY = metadata.camera?.mesh_rotation_y ?? 180;
    state.originalMeshRotationY = meshRotY;
    state.editedMeshRotationY = meshRotY;

    const camHeight = metadata.camera?.height ?? 2.5;
    state.originalCameraHeight = camHeight;
    state.editedCameraHeight = camHeight;

    const meshRotX = metadata.camera?.mesh_rotation_x ?? 0;
    state.originalMeshRotationX = meshRotX;
    state.editedMeshRotationX = meshRotX;

    const meshRotZ = metadata.camera?.mesh_rotation_z ?? 0;
    state.originalMeshRotationZ = meshRotZ;
    state.editedMeshRotationZ = meshRotZ;

    const distScale = metadata.camera?.distance_scale ?? 1.0;
    state.originalDistanceScale = distScale;
    state.editedDistanceScale = distScale;

    const markScale = metadata.camera?.marker_scale ?? 1.0;
    state.originalMarkerScale = markScale;
    state.editedMarkerScale = markScale;

    // Extract existing target overrides and hidden state from metadata
    state.originalTargetOverrides.clear();
    state.editedTargetOverrides.clear();
    state.originalTargetHidden.clear();
    state.editedTargetHidden.clear();

    if (metadata.targets) {
        for (const target of metadata.targets) {
            if (target.override_bearing != null) {
                const override = {
                    bearing: target.override_bearing,
                    distance: target.override_distance ?? 5,
                    height: target.override_height ?? 0,
                };
                state.originalTargetOverrides.set(target.id, { ...override });
                state.editedTargetOverrides.set(target.id, { ...override });
            }
            if (target.hidden) {
                state.originalTargetHidden.set(target.id, true);
                state.editedTargetHidden.set(target.id, true);
            }
        }
    }

    state.nearbyPhotos = [];
    state.selectedTargetId = null;
    state.setFromClickMode = false;
    state.calibrationReviewed = Boolean(metadata.camera?.calibration_reviewed);

    notify();
}

/**
 * Updates targets and their overrides/hidden state without resetting calibration edits.
 * Used after creating or deleting a target connection to refresh the targets list
 * without reloading the panorama or losing in-progress calibration work.
 * @param {Object} metadata - Fresh metadata from the API
 */
export function refreshTargets(metadata) {
    state.currentMetadata = { ...state.currentMetadata, targets: metadata.targets };

    // Rebuild target overrides and hidden state from fresh metadata
    state.originalTargetOverrides.clear();
    state.editedTargetOverrides.clear();
    state.originalTargetHidden.clear();
    state.editedTargetHidden.clear();

    if (metadata.targets) {
        for (const target of metadata.targets) {
            if (target.override_bearing != null) {
                const override = {
                    bearing: target.override_bearing,
                    distance: target.override_distance ?? 5,
                    height: target.override_height ?? 0,
                };
                state.originalTargetOverrides.set(target.id, { ...override });
                state.editedTargetOverrides.set(target.id, { ...override });
            }
            if (target.hidden) {
                state.originalTargetHidden.set(target.id, true);
                state.editedTargetHidden.set(target.id, true);
            }
        }
    }

    notify();
}

/**
 * Updates the edited mesh_rotation_y value.
 * @param {number} value - New rotation value in degrees
 * @param {boolean} [silent=false] - If true, skip notifying listeners (for live slider dragging)
 */
export function setMeshRotationY(value, silent = false) {
    state.editedMeshRotationY = value;
    if (!silent) notify();
}

/**
 * Updates the edited camera_height value.
 * @param {number} value - New height value in meters
 * @param {boolean} [silent=false] - If true, skip notifying listeners (for live slider dragging)
 */
export function setCameraHeight(value, silent = false) {
    state.editedCameraHeight = value;
    if (!silent) notify();
}

/**
 * Updates the edited mesh_rotation_x value.
 * @param {number} value - New rotation value in degrees
 * @param {boolean} [silent=false] - If true, skip notifying listeners
 */
export function setMeshRotationX(value, silent = false) {
    state.editedMeshRotationX = value;
    if (!silent) notify();
}

/**
 * Updates the edited mesh_rotation_z value.
 * @param {number} value - New rotation value in degrees
 * @param {boolean} [silent=false] - If true, skip notifying listeners
 */
export function setMeshRotationZ(value, silent = false) {
    state.editedMeshRotationZ = value;
    if (!silent) notify();
}

/**
 * Updates the edited distance_scale value.
 * @param {number} value - New distance scale multiplier
 * @param {boolean} [silent=false] - If true, skip notifying listeners
 */
export function setDistanceScale(value, silent = false) {
    state.editedDistanceScale = value;
    if (!silent) notify();
}

/**
 * Updates the edited marker_scale value.
 * @param {number} value - New marker scale multiplier
 * @param {boolean} [silent=false] - If true, skip notifying listeners
 */
export function setMarkerScale(value, silent = false) {
    state.editedMarkerScale = value;
    if (!silent) notify();
}

/**
 * Sets a target override (bearing/distance/height).
 * @param {string} targetId - Target photo UUID
 * @param {number} bearing - Override bearing in degrees (0-360)
 * @param {number} distance - Override ground distance in meters (0.5-500)
 * @param {number} [height=0] - Vertical offset in meters (-10 to +10)
 * @param {boolean} [silent=false] - If true, skip notifying listeners (for live slider dragging)
 */
export function setTargetOverride(targetId, bearing, distance, height = 0, silent = false) {
    state.editedTargetOverrides.set(targetId, { bearing, distance, height });
    if (!silent) notify();
}

/**
 * Sets the hidden state for a target.
 * @param {string} targetId - Target photo UUID
 * @param {boolean} hidden - Whether the target is hidden
 */
export function setTargetHidden(targetId, hidden) {
    if (hidden) {
        state.editedTargetHidden.set(targetId, true);
    } else {
        state.editedTargetHidden.delete(targetId);
    }
    notify();
}

/**
 * Returns whether a target is currently hidden (in edited state).
 * @param {string} targetId - Target photo UUID
 * @returns {boolean}
 */
export function isTargetHidden(targetId) {
    return state.editedTargetHidden.get(targetId) ?? false;
}

/**
 * Sets the list of nearby unconnected photos.
 * @param {Array} photos - Nearby photos from API
 */
export function setNearbyPhotos(photos) {
    state.nearbyPhotos = photos;
    notify();
}

/**
 * Clears the edited override for a target (reverts to original or removes).
 * @param {string} targetId - Target photo UUID
 */
export function clearTargetOverrideEdit(targetId) {
    // If there was an original override, revert to it
    const original = state.originalTargetOverrides.get(targetId);
    if (original) {
        // Mark as "cleared" by setting bearing/distance/height to null
        state.editedTargetOverrides.set(targetId, { bearing: null, distance: null, height: null });
    } else {
        // No original override, just remove the edit
        state.editedTargetOverrides.delete(targetId);
    }
    notify();
}

/**
 * Selects a target for editing its override.
 * @param {string} targetId - Target photo UUID
 */
export function selectTarget(targetId) {
    state.selectedTargetId = targetId;
    state.setFromClickMode = false;
    notify();
}

/**
 * Deselects the currently selected target.
 */
export function deselectTarget() {
    state.selectedTargetId = null;
    state.setFromClickMode = false;
    notify();
}

/**
 * Discards all edits and restores original values.
 */
export function discardChanges() {
    state.editedMeshRotationY = state.originalMeshRotationY;
    state.editedCameraHeight = state.originalCameraHeight;
    state.editedMeshRotationX = state.originalMeshRotationX;
    state.editedMeshRotationZ = state.originalMeshRotationZ;
    state.editedDistanceScale = state.originalDistanceScale;
    state.editedMarkerScale = state.originalMarkerScale;

    state.editedTargetOverrides.clear();
    for (const [targetId, override] of state.originalTargetOverrides) {
        state.editedTargetOverrides.set(targetId, { ...override });
    }

    state.editedTargetHidden.clear();
    for (const [targetId, hidden] of state.originalTargetHidden) {
        state.editedTargetHidden.set(targetId, hidden);
    }

    state.setFromClickMode = false;
    notify();
}

/**
 * Marks the current edits as saved (updates originals to match edits).
 */
export function markSaved() {
    state.originalMeshRotationY = state.editedMeshRotationY;
    state.originalCameraHeight = state.editedCameraHeight;
    state.originalMeshRotationX = state.editedMeshRotationX;
    state.originalMeshRotationZ = state.editedMeshRotationZ;
    state.originalDistanceScale = state.editedDistanceScale;
    state.originalMarkerScale = state.editedMarkerScale;

    state.originalTargetOverrides.clear();
    for (const [targetId, edited] of state.editedTargetOverrides) {
        if (edited.bearing !== null && edited.distance !== null) {
            state.originalTargetOverrides.set(targetId, { ...edited });
        }
    }

    // Clean up null overrides from edits (bearing+distance null = cleared)
    for (const [targetId, edited] of state.editedTargetOverrides) {
        if (edited.bearing === null && edited.distance === null) {
            state.editedTargetOverrides.delete(targetId);
        }
    }

    state.originalTargetHidden.clear();
    for (const [targetId, hidden] of state.editedTargetHidden) {
        if (hidden) {
            state.originalTargetHidden.set(targetId, true);
        }
    }

    notify();
}

/**
 * Returns the effective override for a target (edited if exists, else original).
 * @param {string} targetId - Target photo UUID
 * @returns {{bearing: number|null, distance: number|null}|null}
 */
export function getEffectiveOverride(targetId) {
    if (state.editedTargetOverrides.has(targetId)) {
        const edited = state.editedTargetOverrides.get(targetId);
        // Null bearing/distance means override was cleared
        if (edited.bearing === null && edited.distance === null) {
            return null;
        }
        return edited;
    }

    if (state.originalTargetOverrides.has(targetId)) {
        return state.originalTargetOverrides.get(targetId);
    }

    return null;
}

/**
 * Updates only the height field of an existing target override, preserving bearing and distance.
 * @param {string} targetId - Target photo UUID
 * @param {number} height - Vertical offset in meters
 * @param {boolean} [silent=false] - If true, skip notifying listeners
 */
export function setTargetOverrideHeight(targetId, height, silent = false) {
    const current = state.editedTargetOverrides.get(targetId);
    if (current) {
        current.height = height;
    }
    if (!silent) notify();
}

/**
 * Enables or disables "set from click" mode for capturing bearing/distance from the viewer.
 * @param {boolean} active - Whether the mode is active
 */
export function setSetFromClickMode(active) {
    state.setFromClickMode = active;
    notify();
}

// ============================================================================
// REVIEW WORKFLOW
// ============================================================================

/**
 * Sets the project context for the review workflow.
 * @param {string} slug - Project slug
 * @param {Array} photos - Photo list from API
 * @param {{total: number, reviewed: number}} reviewStats - Review statistics
 */
export function setProjectContext(slug, photos, reviewStats) {
    state.currentProjectSlug = slug;
    state.projectPhotos = photos;
    state.reviewStats = reviewStats;
    notify();
}

/**
 * Updates the reviewed status for the current photo in the local state.
 * @param {boolean} reviewed
 */
export function setCalibrationReviewed(reviewed) {
    state.calibrationReviewed = reviewed;
    // Also update in the projectPhotos list
    const photo = state.projectPhotos.find(p => p.id === state.currentPhotoId);
    if (photo) {
        photo.reviewed = reviewed;
    }
    // Update stats
    if (state.reviewStats) {
        const reviewedCount = state.projectPhotos.filter(p => p.reviewed).length;
        state.reviewStats = { ...state.reviewStats, reviewed: reviewedCount };
    }
    notify();
}

/**
 * Resets all project photos to unreviewed in the local state.
 * Called after the server confirms the reset.
 */
export function resetAllReviewedState() {
    for (const photo of state.projectPhotos) {
        photo.reviewed = false;
    }
    state.calibrationReviewed = false;
    if (state.reviewStats) {
        state.reviewStats = { ...state.reviewStats, reviewed: 0 };
    }
    notify();
}

/**
 * Gets the next unreviewed photo ID, or the next photo if all reviewed.
 * @returns {string|null}
 */
export function getNextPhotoId() {
    if (!state.projectPhotos.length || !state.currentPhotoId) return null;
    const currentIdx = state.projectPhotos.findIndex(p => p.id === state.currentPhotoId);
    if (currentIdx === -1) return null;

    // First try: next unreviewed after current
    for (let i = currentIdx + 1; i < state.projectPhotos.length; i++) {
        if (!state.projectPhotos[i].reviewed) return state.projectPhotos[i].id;
    }
    // Wrap around: unreviewed before current
    for (let i = 0; i < currentIdx; i++) {
        if (!state.projectPhotos[i].reviewed) return state.projectPhotos[i].id;
    }
    // All reviewed: go to next sequentially
    if (currentIdx + 1 < state.projectPhotos.length) {
        return state.projectPhotos[currentIdx + 1].id;
    }
    return null;
}

/**
 * Gets the previous photo ID sequentially.
 * @returns {string|null}
 */
export function getPrevPhotoId() {
    if (!state.projectPhotos.length || !state.currentPhotoId) return null;
    const currentIdx = state.projectPhotos.findIndex(p => p.id === state.currentPhotoId);
    if (currentIdx <= 0) return null;
    return state.projectPhotos[currentIdx - 1].id;
}

/**
 * Gets the current photo index (1-based) in the project photo list.
 * @returns {number}
 */
export function getCurrentPhotoIndex() {
    if (!state.projectPhotos.length || !state.currentPhotoId) return 0;
    return state.projectPhotos.findIndex(p => p.id === state.currentPhotoId) + 1;
}
