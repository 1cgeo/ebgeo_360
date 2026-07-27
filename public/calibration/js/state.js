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
    // So mesh rotation y/x/z e o estado hidden dos alvos sao editaveis. Os
    // campos camera_height/distance_scale/marker_scale e os overrides por alvo
    // sairam com o modelo de chao: as colunas continuam no banco (inertes), mas
    // nada na UI as edita, entao nao ha edited/original a rastrear aqui.
    originalMeshRotationY: null,
    editedMeshRotationY: null,
    originalMeshRotationX: null,
    editedMeshRotationX: null,
    originalMeshRotationZ: null,
    editedMeshRotationZ: null,
    originalTargetHidden: new Map(),   // targetId -> boolean
    editedTargetHidden: new Map(),     // targetId -> boolean
    nearbyPhotos: [],                  // nearby unconnected photos from API
    selectedTargetId: null,
    // Review workflow
    currentProjectSlug: null,
    projectPhotos: [],         // [{id, displayName, sequenceNumber, reviewed}]
    reviewStats: null,         // {total, reviewed}
    calibrationReviewed: false,
    // Versao da LISTA de fotos do projeto: muda quando a identidade/ordem dos
    // itens muda (troca de projeto, exclusao de foto, reset de revisoes), nunca
    // quando so o estado de revisao de uma foto muda. O painel usa isso para
    // decidir se precisa reconstruir a lista — com 17 mil fotos, reconstrui-la a
    // cada troca de foto era o custo dominante da interface.
    projectPhotosVersion: 0,
};

// Indices da lista de fotos do projeto (id -> foto, id -> posicao).
//
// Sem eles cada consulta era uma varredura linear, e o painel fazia uma
// varredura POR ITEM renderizado — quadratico sobre 17.590 fotos no maior
// projeto. Reconstruidos junto com projectPhotos em setProjectContext.
const photoById = new Map();
const photoIndexById = new Map();

function rebuildPhotoIndex() {
    photoById.clear();
    photoIndexById.clear();
    state.projectPhotos.forEach((p, i) => {
        photoById.set(p.id, p);
        photoIndexById.set(p.id, i);
    });
}

/**
 * Returns a photo of the current project by id, in constant time.
 * @param {string} photoId - Photo UUID
 * @returns {Object|undefined}
 */
export function getProjectPhoto(photoId) {
    return photoById.get(photoId);
}

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

// Coalesce multiple notify() calls disparados na mesma "tick"/frame em uma unica
// rodada de listeners, evitando rebuilds redundantes do painel quando uma acao
// dispara varias mutacoes de estado em sequencia.
let notifyScheduled = false;
const scheduleFrame =
    typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame
        : (cb) => setTimeout(cb, 16);

/**
 * Executa todos os listeners com o estado atual.
 */
function flushListeners() {
    notifyScheduled = false;
    listeners.forEach(fn => fn(state));
}

/**
 * Notifies all listeners of a state change.
 * As notificacoes sao agrupadas por frame: multiplas chamadas dentro do mesmo
 * frame resultam em uma unica execucao dos listeners com o estado mais recente.
 */
function notify() {
    if (notifyScheduled) return;
    notifyScheduled = true;
    scheduleFrame(flushListeners);
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

    const meshRotX = metadata.camera?.mesh_rotation_x ?? 0;
    state.originalMeshRotationX = meshRotX;
    state.editedMeshRotationX = meshRotX;

    const meshRotZ = metadata.camera?.mesh_rotation_z ?? 0;
    state.originalMeshRotationZ = meshRotZ;
    state.editedMeshRotationZ = meshRotZ;

    // Extract existing hidden state from metadata
    state.originalTargetHidden.clear();
    state.editedTargetHidden.clear();

    if (metadata.targets) {
        for (const target of metadata.targets) {
            if (target.hidden) {
                state.originalTargetHidden.set(target.id, true);
                state.editedTargetHidden.set(target.id, true);
            }
        }
    }

    state.nearbyPhotos = [];
    state.selectedTargetId = null;
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

    // Rebuild hidden state from fresh metadata
    state.originalTargetHidden.clear();
    state.editedTargetHidden.clear();

    if (metadata.targets) {
        for (const target of metadata.targets) {
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
 * Selects a target (to show its Ocultar/Remover actions).
 * @param {string} targetId - Target photo UUID
 */
export function selectTarget(targetId) {
    state.selectedTargetId = targetId;
    notify();
}

/**
 * Deselects the currently selected target.
 */
export function deselectTarget() {
    state.selectedTargetId = null;
    notify();
}

/**
 * Discards all edits and restores original values.
 */
export function discardChanges() {
    state.editedMeshRotationY = state.originalMeshRotationY;
    state.editedMeshRotationX = state.originalMeshRotationX;
    state.editedMeshRotationZ = state.originalMeshRotationZ;

    state.editedTargetHidden.clear();
    for (const [targetId, hidden] of state.originalTargetHidden) {
        state.editedTargetHidden.set(targetId, hidden);
    }

    notify();
}

/**
 * Marks the current edits as saved (updates originals to match edits).
 */
export function markSaved() {
    state.originalMeshRotationY = state.editedMeshRotationY;
    state.originalMeshRotationX = state.editedMeshRotationX;
    state.originalMeshRotationZ = state.editedMeshRotationZ;

    state.originalTargetHidden.clear();
    for (const [targetId, hidden] of state.editedTargetHidden) {
        if (hidden) {
            state.originalTargetHidden.set(targetId, true);
        }
    }

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
    state.projectPhotosVersion++;
    rebuildPhotoIndex();
    notify();
}

/**
 * Updates the reviewed status for the current photo in the local state.
 * @param {boolean} reviewed
 */
export function setCalibrationReviewed(reviewed) {
    state.calibrationReviewed = reviewed;
    // Also update in the projectPhotos list
    const photo = photoById.get(state.currentPhotoId);
    const wasReviewed = Boolean(photo?.reviewed);
    if (photo) {
        photo.reviewed = reviewed;
    }
    // Contador ajustado pelo delta desta foto. Recontar a lista inteira a cada
    // marcacao era uma varredura sobre as 17 mil fotos do projeto.
    if (state.reviewStats && photo && wasReviewed !== reviewed) {
        const delta = reviewed ? 1 : -1;
        state.reviewStats = {
            ...state.reviewStats,
            reviewed: state.reviewStats.reviewed + delta,
        };
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
    // Toda a lista mudou de aparencia: forca o painel a redesenha-la, em vez de
    // aplicar a atualizacao pontual de uma foto so.
    state.projectPhotosVersion++;
    notify();
}

/**
 * Gets the next unreviewed photo ID, or the next photo if all reviewed.
 * @returns {string|null}
 */
export function getNextPhotoId() {
    if (!state.projectPhotos.length || !state.currentPhotoId) return null;
    const currentIdx = photoIndexById.get(state.currentPhotoId) ?? -1;
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
    const currentIdx = photoIndexById.get(state.currentPhotoId) ?? -1;
    if (currentIdx <= 0) return null;
    return state.projectPhotos[currentIdx - 1].id;
}

/**
 * Gets the current photo index (1-based) in the project photo list.
 * @returns {number}
 */
export function getCurrentPhotoIndex() {
    if (!state.projectPhotos.length || !state.currentPhotoId) return 0;
    return (photoIndexById.get(state.currentPhotoId) ?? -1) + 1;
}
