/**
 * @fileoverview Entry point for the Street View 360 calibration interface.
 * Orchestrates viewer, navigator, minimap, and calibration panel.
 * Handles URL routing, navigation between photos, save/discard, and keyboard shortcuts.
 */

import {
    fetchProjects, fetchPhotoMetadata, getPhotoImageUrl,
    saveCalibration, saveCameraHeight, saveMeshRotationX, saveMeshRotationZ, saveDistanceScale, saveMarkerScale,
    saveTargetOverride, clearTargetOverride,
    setPhotoReviewed, fetchProjectPhotos,
    saveTargetVisibility, fetchNearbyPhotos, createTarget, deleteTargetConnection,
} from './api.js';
import {
    state, isDirty, loadPhoto, discardChanges, markSaved, onChange,
    setTargetOverride as stateSetTargetOverride,
    selectTarget, deselectTarget, setSetFromClickMode,
    setProjectContext, setCalibrationReviewed, getNextPhotoId, getPrevPhotoId,
    setNearbyPhotos, isTargetHidden, refreshTargets,
} from './state.js';
import {
    initViewer, loadProgressive, setMeshRotationY as viewerSetMeshRotationY,
    setMeshRotationX as viewerSetMeshRotationX, setMeshRotationZ as viewerSetMeshRotationZ,
    setHeading, forceResize, setGridVisible, isGridVisible,
} from './viewer.js';
import {
    initNavigator, setCameraConfig, setTargets,
    update as updateNavigator, handleClick, updateCameraState,
    refreshCursor, setGroundGridVisible,
    setNearbyPhotos as navSetNearbyPhotos, setNearbyPreviewMode,
} from './navigator.js';
import {
    initMinimap, updateCamera, updateTargets, setSelectedTarget,
    updateNearbyPhotos,
} from './minimap.js';
import { initPanel, showToast, setGridToggleState, clearNearbyPreview, getNearbyPreviewState } from './calibration-panel.js';
import {
    initPreviewViewer, showPreview, hidePreview, showAddButton,
} from './preview-viewer.js';

// ============================================================================
// DOM ELEMENTS
// ============================================================================

let viewerContainer;
let panelContainer;
let minimapContainer;
let loadingOverlay;
let projectSelector;

// ============================================================================
// INITIALIZATION
// ============================================================================

document.addEventListener('DOMContentLoaded', () => {
    viewerContainer = document.getElementById('viewer-container');
    panelContainer = document.getElementById('calibration-panel');
    minimapContainer = document.getElementById('minimap-container');
    loadingOverlay = document.getElementById('loading-overlay');
    projectSelector = document.getElementById('project-selector');

    const params = new URLSearchParams(window.location.search);
    const photoId = params.get('photo');

    if (photoId) {
        startCalibration(photoId);
    } else {
        showProjectSelector();
    }

    // Keyboard shortcuts
    document.addEventListener('keydown', onKeyDown);

    // Prevent data loss on tab close
    window.addEventListener('beforeunload', (e) => {
        if (isDirty()) {
            e.preventDefault();
            e.returnValue = '';
        }
    });
});

// ============================================================================
// PROJECT SELECTOR (landing page when no ?photo= param)
// ============================================================================

async function showProjectSelector() {
    if (!projectSelector) return;
    projectSelector.style.display = 'flex';
    viewerContainer.style.display = 'none';
    panelContainer.style.display = 'none';

    try {
        const projects = await fetchProjects();

        // Fetch review stats for all projects in parallel
        const statsResults = await Promise.allSettled(
            projects.map(p => fetchProjectPhotos(p.slug))
        );
        const statsMap = {};
        projects.forEach((p, i) => {
            if (statsResults[i].status === 'fulfilled') {
                statsMap[p.slug] = statsResults[i].value.reviewStats;
            }
        });

        projectSelector.innerHTML = `
            <h1 class="project-selector__title">Street View 360 — Calibração</h1>
            <p class="project-selector__subtitle">Selecione um projeto para iniciar</p>
            <div class="project-selector__grid">
                ${projects.map(p => {
                    const stats = statsMap[p.slug];
                    const reviewed = stats?.reviewed ?? 0;
                    const total = stats?.total ?? p.photoCount;
                    const pct = total > 0 ? Math.round((reviewed / total) * 100) : 0;
                    return `
                    <div class="project-selector__card" data-photo-id="${p.entryPhotoId}" data-slug="${p.slug}">
                        <h3 class="project-selector__card-title">${p.name}</h3>
                        <p class="project-selector__card-info">${p.photoCount} fotos</p>
                        <div class="project-selector__review-stats">
                            <div class="project-selector__progress-bar">
                                <div class="project-selector__progress-fill" style="width: ${pct}%"></div>
                            </div>
                            <span class="project-selector__review-text">${reviewed}/${total} revisadas (${pct}%)</span>
                        </div>
                        ${p.location ? `<p class="project-selector__card-location">${p.location}</p>` : ''}
                    </div>
                    `;
                }).join('')}
            </div>
        `;

        // Card click handlers
        projectSelector.querySelectorAll('[data-photo-id]').forEach(card => {
            card.addEventListener('click', async () => {
                const entryPhotoId = card.dataset.photoId;
                const slug = card.dataset.slug;
                if (entryPhotoId && slug) {
                    projectSelector.style.display = 'none';
                    viewerContainer.style.display = 'block';
                    panelContainer.style.display = 'flex';
                    await loadProjectContext(slug);
                    startCalibration(entryPhotoId);
                }
            });
        });
    } catch (err) {
        projectSelector.innerHTML = `
            <h1 class="project-selector__title">Erro</h1>
            <p class="project-selector__error">${err.message}</p>
        `;
    }
}

/**
 * Loads the project photo list and review stats into state.
 */
async function loadProjectContext(slug) {
    try {
        const data = await fetchProjectPhotos(slug);
        setProjectContext(slug, data.photos, data.reviewStats);
    } catch (err) {
        console.error('Failed to load project context:', err);
    }
}

// ============================================================================
// CALIBRATION SESSION
// ============================================================================

let initialized = false;

async function startCalibration(photoId) {
    showLoading(true);

    try {
        // Fetch metadata
        const metadata = await fetchPhotoMetadata(photoId);

        // Auto-load project context if not already loaded
        if (metadata.projectSlug && state.currentProjectSlug !== metadata.projectSlug) {
            await loadProjectContext(metadata.projectSlug);
        }

        // Load state (after project context so review info is available)
        loadPhoto(photoId, metadata);

        // Initialize subsystems (only once)
        if (!initialized) {
            initializeSubsystems();
            initialized = true;
        }

        // Update URL
        const url = new URL(window.location);
        url.searchParams.set('photo', photoId);
        history.replaceState(null, '', url);

        // Configure navigator
        setCameraConfig(metadata.camera);
        setTargets(metadata.targets);

        // Reset camera to look straight at the image center (lon=0).
        // The navigator adds imageHeading when computing world yaw,
        // so lon=0 means looking in the imageHeading direction.
        setHeading(0);

        // Set mesh rotations
        viewerSetMeshRotationY(metadata.camera?.mesh_rotation_y ?? 180);
        viewerSetMeshRotationX(metadata.camera?.mesh_rotation_x ?? 0);
        viewerSetMeshRotationZ(metadata.camera?.mesh_rotation_z ?? 0);

        // Load panorama (progressive: preview then full)
        const previewUrl = getPhotoImageUrl(photoId, 'preview');
        const fullUrl = getPhotoImageUrl(photoId, 'full');
        await loadProgressive(previewUrl, fullUrl);

        // Update minimap
        updateCamera(metadata.camera);
        updateTargets(metadata.targets);

        // Fetch nearby unconnected photos (non-blocking)
        fetchNearbyPhotos(photoId).then(data => {
            const photos = data.photos || [];
            setNearbyPhotos(photos);
            updateNearbyPhotos(photos);
            navSetNearbyPhotos(photos);
        }).catch(err => {
            console.warn('Failed to load nearby photos:', err);
        });

        showLoading(false);

        // Force resize after layout settles
        requestAnimationFrame(() => forceResize());
    } catch (err) {
        console.error('Failed to load photo:', err);
        showLoading(false);
        showToast(`Erro ao carregar foto: ${err.message}`, 'error');
    }
}

function initializeSubsystems() {
    // Initialize Three.js viewer
    initViewer(viewerContainer, {
        onRender: onViewerRender,
        onClick: onViewerClick,
    });

    // Initialize navigation overlay
    initNavigator(viewerContainer, {
        onNavigate: (targetId) => navigateToPhoto(targetId),
        onTargetSelect: (targetId) => selectTarget(targetId),
        onSetFromClick: onSetFromClick,
    });

    // Initialize minimap
    initMinimap(minimapContainer, {
        onTargetClick: (targetId) => selectTarget(targetId),
    });

    // Initialize calibration panel
    initPanel(panelContainer, {
        onSave: handleSave,
        onDiscard: handleDiscard,
        onMeshRotationPreview: (degrees) => viewerSetMeshRotationY(degrees),
        onCameraHeightPreview: (height) => {
            // Update navigator camera config live for ground-plane projection preview
            if (state.currentMetadata?.camera) {
                setCameraConfig({ ...state.currentMetadata.camera, height, distance_scale: state.editedDistanceScale, marker_scale: state.editedMarkerScale });
            }
        },
        onMeshRotationXPreview: (degrees) => viewerSetMeshRotationX(degrees),
        onMeshRotationZPreview: (degrees) => viewerSetMeshRotationZ(degrees),
        onDistanceScalePreview: (scale) => {
            // Update navigator camera config with new distance_scale
            if (state.currentMetadata?.camera) {
                setCameraConfig({ ...state.currentMetadata.camera, height: state.editedCameraHeight, distance_scale: scale, marker_scale: state.editedMarkerScale });
            }
        },
        onMarkerScalePreview: (scale) => {
            // Update navigator camera config with new marker_scale
            if (state.currentMetadata?.camera) {
                setCameraConfig({ ...state.currentMetadata.camera, height: state.editedCameraHeight, distance_scale: state.editedDistanceScale, marker_scale: scale });
            }
        },
        onNavigateToPhoto: (photoId) => navigateToPhoto(photoId),
        onMarkReviewed: handleMarkReviewed,
        onNextPhoto: handleNextPhoto,
        onPrevPhoto: handlePrevPhoto,
        onBackToProjects: () => showProjectSelector(),
        onGridToggle: (visible) => {
            setGridVisible(visible);
            setGroundGridVisible(visible);
        },
        onAddTarget: handleAddTarget,
        onDeleteTarget: handleDeleteTarget,
        onNearbyPreviewToggle: handleNearbyPreviewToggle,
        onNearbySelect: handleNearbySelect,
    });

    // Initialize preview viewer (shows target photo when selected)
    initPreviewViewer(viewerContainer, {
        onNavigate: (photoId) => navigateToPhoto(photoId),
        onClose: () => {
            // Clear nearby preview if active, otherwise deselect target
            clearNearbyPreview();
            showAddButton(false);
            deselectTarget();
        },
    });

    // Sync minimap target selection and preview viewer with state
    onChange((s) => {
        setSelectedTarget(s.selectedTargetId);

        // Show/hide preview viewer based on selected target
        if (s.selectedTargetId && s.currentMetadata?.targets) {
            const target = s.currentMetadata.targets.find(t => t.id === s.selectedTargetId);
            if (target) {
                // Clear nearby preview when selecting a real target
                clearNearbyPreview();
                showAddButton(false);

                // Fetch target photo metadata to get its mesh_rotation_y
                fetchPhotoMetadata(target.id).then(meta => {
                    // Only show if still the same target
                    if (state.selectedTargetId === target.id) {
                        showPreview(
                            target.id,
                            target.display_name || target.id.slice(0, 8),
                            meta.camera?.mesh_rotation_y ?? 180
                        );
                    }
                }).catch(() => {
                    // Still show without correct mesh rotation
                    if (state.selectedTargetId === target.id) {
                        showPreview(target.id, target.display_name || target.id.slice(0, 8));
                    }
                });
            }
        } else if (!s.selectedTargetId) {
            // Only hide preview if no nearby preview is active
            const { previewingId } = getNearbyPreviewState();
            if (!previewingId) {
                hidePreview();
            }
        }
    });
}

// ============================================================================
// RENDER LOOP CALLBACK
// ============================================================================

function onViewerRender(cameraState) {
    // Update navigator projection each frame
    updateCameraState(cameraState);
    updateNavigator(cameraState);
}

// ============================================================================
// CLICK HANDLERS
// ============================================================================

function onViewerClick(event) {
    handleClick(event);
}

function onSetFromClick(groundOverride) {
    if (!state.selectedTargetId) return;

    // groundOverride = { bearing: bearingDeg, distance: groundDistanceMeters }
    const bearingDeg = groundOverride.bearing;
    const distance = groundOverride.distance;

    stateSetTargetOverride(state.selectedTargetId, bearingDeg, distance);
    setSetFromClickMode(false);
    refreshCursor();
    showToast(`Override definido: bearing=${bearingDeg.toFixed(1)}°, dist=${distance.toFixed(1)}m`, 'success');
}

// ============================================================================
// NAVIGATION
// ============================================================================

async function navigateToPhoto(photoIdOrTargetId) {
    // Check dirty state
    if (isDirty()) {
        const action = await showDirtyDialog();
        if (action === 'cancel') return;
        if (action === 'save') await handleSave();
        if (action === 'discard') discardChanges();
    }

    // The parameter might be a target ID (which is also a photo ID)
    startCalibration(photoIdOrTargetId);
}

function showDirtyDialog() {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'cal-dialog-overlay';
        overlay.innerHTML = `
            <div class="cal-dialog">
                <h3 class="cal-dialog__title">Alteracoes nao salvas</h3>
                <p class="cal-dialog__text">Deseja salvar as alteracoes antes de navegar?</p>
                <div class="cal-dialog__actions">
                    <button class="cal-panel__btn cal-panel__btn--save" data-action="save">Salvar e Navegar</button>
                    <button class="cal-panel__btn cal-panel__btn--discard" data-action="discard">Descartar e Navegar</button>
                    <button class="cal-panel__btn cal-panel__btn--ghost" data-action="cancel">Cancelar</button>
                </div>
            </div>
        `;

        overlay.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-action]');
            if (btn) {
                overlay.remove();
                resolve(btn.dataset.action);
            }
        });

        document.body.appendChild(overlay);
    });
}

// ============================================================================
// SAVE / DISCARD
// ============================================================================

async function handleSave() {
    try {
        const promises = [];

        // Save mesh_rotation_y if changed
        if (
            state.editedMeshRotationY !== null &&
            state.editedMeshRotationY !== state.originalMeshRotationY
        ) {
            promises.push(
                saveCalibration(state.currentPhotoId, state.editedMeshRotationY)
            );
        }

        // Save camera_height if changed
        if (
            state.editedCameraHeight !== null &&
            state.editedCameraHeight !== state.originalCameraHeight
        ) {
            promises.push(
                saveCameraHeight(state.currentPhotoId, state.editedCameraHeight)
            );
        }

        // Save mesh_rotation_x if changed
        if (
            state.editedMeshRotationX !== null &&
            state.editedMeshRotationX !== state.originalMeshRotationX
        ) {
            promises.push(
                saveMeshRotationX(state.currentPhotoId, state.editedMeshRotationX)
            );
        }

        // Save mesh_rotation_z if changed
        if (
            state.editedMeshRotationZ !== null &&
            state.editedMeshRotationZ !== state.originalMeshRotationZ
        ) {
            promises.push(
                saveMeshRotationZ(state.currentPhotoId, state.editedMeshRotationZ)
            );
        }

        // Save distance_scale if changed
        if (
            state.editedDistanceScale !== null &&
            state.editedDistanceScale !== state.originalDistanceScale
        ) {
            promises.push(
                saveDistanceScale(state.currentPhotoId, state.editedDistanceScale)
            );
        }

        // Save marker_scale if changed
        if (
            state.editedMarkerScale !== null &&
            state.editedMarkerScale !== state.originalMarkerScale
        ) {
            promises.push(
                saveMarkerScale(state.currentPhotoId, state.editedMarkerScale)
            );
        }

        // Save changed target overrides
        for (const [targetId, edited] of state.editedTargetOverrides) {
            const original = state.originalTargetOverrides.get(targetId);
            const origB = original?.bearing ?? null;
            const origD = original?.distance ?? null;
            const origH = original?.height ?? 0;

            if (edited.bearing !== origB || edited.distance !== origD || (edited.height ?? 0) !== origH) {
                if (edited.bearing === null && edited.distance === null) {
                    // Override cleared
                    promises.push(
                        clearTargetOverride(state.currentPhotoId, targetId)
                    );
                } else {
                    // Override set/updated
                    promises.push(
                        saveTargetOverride(
                            state.currentPhotoId, targetId,
                            edited.bearing, edited.distance,
                            edited.height ?? 0
                        )
                    );
                }
            }
        }

        // Save changed target visibility
        for (const [targetId, editedHidden] of state.editedTargetHidden) {
            const originalHidden = state.originalTargetHidden.get(targetId) ?? false;
            if (editedHidden !== originalHidden) {
                promises.push(
                    saveTargetVisibility(state.currentPhotoId, targetId, editedHidden)
                );
            }
        }
        // Check if a target was un-hidden (removed from editedTargetHidden but exists in original)
        for (const [targetId] of state.originalTargetHidden) {
            if (!state.editedTargetHidden.has(targetId)) {
                promises.push(
                    saveTargetVisibility(state.currentPhotoId, targetId, false)
                );
            }
        }

        if (promises.length === 0) {
            showToast('Nenhuma alteracao para salvar', 'info');
            return;
        }

        await Promise.all(promises);
        markSaved();
        showToast(`${promises.length} alteracao(oes) salva(s)`, 'success');
    } catch (err) {
        console.error('Save failed:', err);
        showToast(`Erro ao salvar: ${err.message}`, 'error');
    }
}

function handleDiscard() {
    discardChanges();
    // Reset viewer mesh rotations to original
    viewerSetMeshRotationY(state.originalMeshRotationY);
    viewerSetMeshRotationX(state.originalMeshRotationX);
    viewerSetMeshRotationZ(state.originalMeshRotationZ);
    // Reset navigator camera config to original height, distance_scale and marker_scale
    if (state.currentMetadata?.camera) {
        setCameraConfig({
            ...state.currentMetadata.camera,
            height: state.originalCameraHeight,
            distance_scale: state.originalDistanceScale,
            marker_scale: state.originalMarkerScale,
        });
    }
    showToast('Alteracoes descartadas', 'info');
}

// ============================================================================
// REVIEW WORKFLOW
// ============================================================================

async function handleMarkReviewed(reviewed) {
    try {
        await setPhotoReviewed(state.currentPhotoId, reviewed);
        setCalibrationReviewed(reviewed);
        showToast(reviewed ? 'Foto marcada como revisada' : 'Revisao removida', 'success');
    } catch (err) {
        console.error('Failed to set reviewed:', err);
        showToast(`Erro: ${err.message}`, 'error');
    }
}

async function handleNextPhoto() {
    const nextId = getNextPhotoId();
    if (nextId) {
        await navigateToPhoto(nextId);
    } else {
        showToast('Nenhuma foto restante', 'info');
    }
}

async function handlePrevPhoto() {
    const prevId = getPrevPhotoId();
    if (prevId) {
        await navigateToPhoto(prevId);
    } else {
        showToast('Ja esta na primeira foto', 'info');
    }
}

// ============================================================================
// ADD / DELETE TARGETS
// ============================================================================

async function handleAddTarget(targetPhotoId) {
    try {
        await createTarget(state.currentPhotoId, targetPhotoId);
        showToast('Conexao criada', 'success');
        // Close preview and clear nearby preview state
        clearNearbyPreview();
        showAddButton(false);
        hidePreview();
        // Refresh targets and nearby without full page reload
        await refreshTargetsAndNearby();
    } catch (err) {
        console.error('Failed to create target:', err);
        showToast(`Erro ao criar conexao: ${err.message}`, 'error');
    }
}

async function handleDeleteTarget(targetId) {
    const confirmed = window.confirm('Remover esta conexao manual? Esta acao nao pode ser desfeita.');
    if (!confirmed) return;

    try {
        await deleteTargetConnection(state.currentPhotoId, targetId);
        deselectTarget();
        showToast('Conexao removida', 'success');
        // Refresh targets and nearby without full page reload
        await refreshTargetsAndNearby();
    } catch (err) {
        console.error('Failed to delete target:', err);
        showToast(`Erro ao remover conexao: ${err.message}`, 'error');
    }
}

/**
 * Refreshes targets and nearby photos without reloading the panorama.
 * Preserves the current camera view and calibration edits.
 */
async function refreshTargetsAndNearby() {
    try {
        const metadata = await fetchPhotoMetadata(state.currentPhotoId);

        // Update targets in state (triggers panel re-render via notify)
        refreshTargets(metadata);

        // Update navigator and minimap with new targets
        setCameraConfig(metadata.camera);
        setTargets(metadata.targets);
        updateTargets(metadata.targets);

        // Re-fetch nearby photos
        fetchNearbyPhotos(state.currentPhotoId).then(data => {
            const photos = data.photos || [];
            setNearbyPhotos(photos);
            updateNearbyPhotos(photos);
            navSetNearbyPhotos(photos);
        }).catch(err => {
            console.warn('Failed to reload nearby photos:', err);
        });
    } catch (err) {
        console.error('Failed to refresh targets:', err);
        showToast(`Erro ao atualizar: ${err.message}`, 'error');
    }
}

// ============================================================================
// NEARBY PREVIEW
// ============================================================================

/**
 * Handles toggling nearby preview mode on/off.
 * @param {boolean} enabled - Whether nearby preview is now enabled
 */
function handleNearbyPreviewToggle(enabled) {
    setNearbyPreviewMode(enabled, enabled ? handleNearbySelect : null);
    if (!enabled) {
        // Close preview if showing a nearby photo
        clearNearbyPreview();
        showAddButton(false);
        hidePreview();
    }
}

/**
 * Handles selecting a nearby photo for preview (from panel list or canvas click).
 * @param {Object} nearbyPhoto - Nearby photo data { id, displayName, ... }
 */
function handleNearbySelect(nearbyPhoto) {
    if (!nearbyPhoto?.id) return;

    // Deselect any currently selected target
    deselectTarget();

    // Fetch target photo metadata to get mesh_rotation_y
    fetchPhotoMetadata(nearbyPhoto.id).then(meta => {
        showPreview(
            nearbyPhoto.id,
            `Foto Proxima: ${nearbyPhoto.displayName || nearbyPhoto.id.slice(0, 8)}`,
            meta.camera?.mesh_rotation_y ?? 180
        );
        // Show "Adicionar Conexao" button
        showAddButton(true, () => handleAddTarget(nearbyPhoto.id));
    }).catch(() => {
        showPreview(
            nearbyPhoto.id,
            `Foto Proxima: ${nearbyPhoto.displayName || nearbyPhoto.id.slice(0, 8)}`
        );
        showAddButton(true, () => handleAddTarget(nearbyPhoto.id));
    });
}

// ============================================================================
// KEYBOARD SHORTCUTS
// ============================================================================

function onKeyDown(e) {
    // Don't handle shortcuts when typing in inputs
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    // Ctrl+S / Cmd+S = Save
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        if (isDirty()) {
            handleSave();
        }
    }

    // Escape = Deselect target
    if (e.key === 'Escape') {
        if (state.setFromClickMode) {
            setSetFromClickMode(false);
            refreshCursor();
        } else if (state.selectedTargetId) {
            deselectTarget();
        }
    }

    // Review workflow shortcuts
    // R = Toggle reviewed
    if (e.key === 'r' && !e.ctrlKey && !e.metaKey) {
        handleMarkReviewed(!state.calibrationReviewed);
    }

    // N or ] = Next photo
    if ((e.key === 'n' || e.key === ']') && !e.ctrlKey && !e.metaKey) {
        handleNextPhoto();
    }

    // P or [ = Previous photo
    if ((e.key === 'p' || e.key === '[') && !e.ctrlKey && !e.metaKey) {
        handlePrevPhoto();
    }

    // E = Mark reviewed + go to next (efficient workflow)
    if (e.key === 'e' && !e.ctrlKey && !e.metaKey) {
        handleMarkReviewedAndNext();
    }

    // G = Toggle perspective grid
    if (e.key === 'g' && !e.ctrlKey && !e.metaKey) {
        const newState = !isGridVisible();
        setGridVisible(newState);
        setGroundGridVisible(newState);
        setGridToggleState(newState);
    }
}

async function handleMarkReviewedAndNext() {
    if (isDirty()) {
        await handleSave();
    }
    await handleMarkReviewed(true);
    await handleNextPhoto();
}

// ============================================================================
// UI HELPERS
// ============================================================================

function showLoading(show) {
    if (loadingOverlay) {
        loadingOverlay.style.display = show ? 'flex' : 'none';
    }
}
