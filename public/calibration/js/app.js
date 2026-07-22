/**
 * @fileoverview Entry point for the Street View 360 calibration interface.
 * Orchestrates viewer, navigator, minimap, and calibration panel.
 * Handles URL routing, navigation between photos, save/discard, and keyboard shortcuts.
 */

import {
    fetchProjects, fetchPhotoMetadata, getPhotoImageUrl,
    saveCalibration, saveMeshRotationX, saveMeshRotationZ,
    setPhotoReviewed, fetchProjectPhotos,
    saveTargetVisibility, fetchNearbyPhotos, createTarget, deleteTargetConnection,
    deletePhoto,
} from './api.js';
import {
    state, isDirty, loadPhoto, discardChanges, markSaved, onChange,
    selectTarget, deselectTarget,
    setProjectContext, setCalibrationReviewed, getNextPhotoId, getPrevPhotoId,
    setNearbyPhotos, isTargetHidden, refreshTargets,
    setMeshRotationX, setMeshRotationY, setMeshRotationZ,
    setTargetHidden as stateSetTargetHidden,
} from './state.js';
import {
    initViewer, loadProgressive, setMeshRotationY as viewerSetMeshRotationY,
    setMeshRotationX as viewerSetMeshRotationX, setMeshRotationZ as viewerSetMeshRotationZ,
    setHeading, getHeading, forceResize, setGridVisible, isGridVisible,
    dispose as disposeViewer,
} from './viewer.js';
import {
    initNavigator, setCameraConfig, setTargets,
    update as updateNavigator, handleClick, updateCameraState, setHoveredFromMinimap,
    setNearbyPhotos as navSetNearbyPhotos, setNearbyPreviewMode,
    disposeNavigator,
} from './navigator.js';
import {
    initMinimap, updateCamera, setViewDirection, updateTargets, setSelectedTarget,
    updateNearbyPhotos, disposeMinimap,
} from './minimap.js';
import { initPanel, showToast, setSphericalGridToggleState, clearNearbyPreview, getNearbyPreviewState } from './calibration-panel.js';
import {
    initPreviewViewer, showPreview, hidePreview, showAddButton,
    showRearView, updateRearViewRotation, showTargetActions, updateHideButtonState,
    syncRearViewCamera, setRearViewTargets, disposePreviewViewer,
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
    document.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onWindowBlur);

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

    // Desmonta os subsistemas da sessao de calibracao ao voltar ao seletor:
    // libera o contexto WebGL do MapLibre, o render loop, os contextos WebGL
    // do viewer/preview e os listeners globais (resize/scroll/mousemove).
    // Os subsistemas serao re-inicializados na proxima carga de foto.
    teardownSubsystems();

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
 * @param {string} slug - Project slug
 * @param {AbortSignal} [signal] - Signal opcional para cancelar a requisicao
 */
async function loadProjectContext(slug, signal) {
    try {
        const data = await fetchProjectPhotos(slug, { signal });
        setProjectContext(slug, data.photos, data.reviewStats);
    } catch (err) {
        if (err?.name === 'AbortError') return;
        console.error('Failed to load project context:', err);
    }
}

// ============================================================================
// CALIBRATION SESSION
// ============================================================================

let initialized = false;
// Unsubscribe do listener onChange registrado em initializeSubsystems,
// chamado no teardown para nao acumular listeners duplicados ao re-inicializar.
let unsubscribeOnChange = null;
// Canvas do viewer principal, removido do DOM no teardown (o dispose() do
// viewer nao remove o proprio canvas).
let viewerCanvasEl = null;

// ── Token de geracao para descartar cargas obsoletas em navegacao rapida ──
// Cada chamada de startCalibration incrementa loadGeneration e captura seu
// proprio myGen. Apos cada await, comparamos myGen com loadGeneration: se
// divergir, outra navegacao comecou e os resultados desta carga sao ignorados
// (evita exibir panorama/targets/camera de uma foto sobre outra).
let loadGeneration = 0;
// AbortController da carga em andamento, abortado ao iniciar a proxima.
let currentLoadController = null;

async function startCalibration(photoId) {
    // Aborta a requisicao de carga anterior (metadata/nearby ainda em voo).
    if (currentLoadController) {
        currentLoadController.abort();
    }
    const controller = new AbortController();
    currentLoadController = controller;
    const myGen = ++loadGeneration;

    showLoading(true);

    try {
        // Fetch metadata
        const metadata = await fetchPhotoMetadata(photoId, { signal: controller.signal });

        // Carga obsoleta: outra navegacao comecou enquanto buscavamos metadados.
        if (myGen !== loadGeneration) return;

        // Auto-load project context if not already loaded
        if (metadata.projectSlug && state.currentProjectSlug !== metadata.projectSlug) {
            await loadProjectContext(metadata.projectSlug, controller.signal);
            if (myGen !== loadGeneration) return;
        }

        // Onde a camera estava olhando NO MUNDO, antes de trocar de foto.
        // Lido aqui porque loadPhoto logo abaixo sobrescreve o metadata anterior.
        const prevWorldHeading = state.currentPhotoId
            ? (state.currentMetadata?.camera?.heading ?? 0) + getHeading()
            : null;

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
        setRearViewTargets(metadata.targets, metadata.camera);

        // Trocar de foto mantem a direcao do MUNDO, nao o lon. Zerar o lon
        // girava a vista a cada salto, e o operador perdia a referencia de onde
        // estava olhando, que e justamente o que a calibracao pede.
        // A navegacao adiciona imageHeading para achar o yaw do mundo, entao
        // lon = worldHeading - imageHeading. Na primeira foto, lon = 0, que e
        // olhar na direcao do proprio imageHeading.
        const imageHeading = metadata.camera?.heading ?? 0;
        setHeading(prevWorldHeading === null ? 0 : prevWorldHeading - imageHeading);

        // Set mesh rotations
        viewerSetMeshRotationY(metadata.camera?.mesh_rotation_y ?? 180);
        viewerSetMeshRotationX(metadata.camera?.mesh_rotation_x ?? 0);
        viewerSetMeshRotationZ(metadata.camera?.mesh_rotation_z ?? 0);

        // Load panorama (progressive: preview then full)
        const previewUrl = getPhotoImageUrl(photoId, 'preview');
        const fullUrl = getPhotoImageUrl(photoId, 'full');
        await loadProgressive(previewUrl, fullUrl);

        // Carga obsoleta apos a textura terminar de carregar: descarta o resto.
        if (myGen !== loadGeneration) return;

        // Show rear view in preview viewer
        showRearView(
            photoId,
            metadata.camera?.mesh_rotation_y ?? 180,
            metadata.camera?.mesh_rotation_x ?? 0,
            metadata.camera?.mesh_rotation_z ?? 0,
        );

        // Update minimap
        updateCamera(metadata.camera);
        updateTargets(metadata.targets);

        // Fetch nearby unconnected photos (non-blocking)
        fetchNearbyPhotos(photoId, 100, { signal: controller.signal }).then(data => {
            // Ignora resultado se a foto ja mudou.
            if (myGen !== loadGeneration) return;
            const photos = data.photos || [];
            setNearbyPhotos(photos);
            updateNearbyPhotos(photos);
            navSetNearbyPhotos(photos);
        }).catch(err => {
            if (err?.name === 'AbortError') return;
            console.warn('Failed to load nearby photos:', err);
        });

        showLoading(false);

        // Force resize after layout settles
        requestAnimationFrame(() => forceResize());
    } catch (err) {
        // Requisicao cancelada por navegacao mais recente: silencioso.
        if (err?.name === 'AbortError' || myGen !== loadGeneration) return;
        console.error('Failed to load photo:', err);
        showLoading(false);
        showToast(`Erro ao carregar foto: ${err.message}`, 'error');
    }
}

function initializeSubsystems() {
    // Initialize Three.js viewer
    const viewerHandle = initViewer(viewerContainer, {
        onRender: onViewerRender,
        onClick: onViewerClick,
    });
    // Guarda o canvas do viewer para remove-lo do DOM no teardown: dispose()
    // do viewer libera o contexto WebGL mas nao remove o proprio canvas, entao
    // sem isso um re-init empilharia canvases mortos no container.
    viewerCanvasEl = viewerHandle?.canvas ?? null;

    // Initialize navigation overlay
    initNavigator(viewerContainer, {
        onTargetSelect: (targetId) => selectTarget(targetId),
    });

    // Initialize minimap
    initMinimap(minimapContainer, {
        onTargetClick: (targetId) => selectTarget(targetId),
        // Vinculo minimapa -> 360: apontar o alvo na planta acende o marcador
        // correspondente na foto.
        onTargetHover: (targetId) => setHoveredFromMinimap(targetId),
    });

    // Initialize calibration panel
    initPanel(panelContainer, {
        onSave: handleSave,
        onDiscard: handleDiscard,
        onMeshRotationPreview: (degrees) => {
            viewerSetMeshRotationY(degrees);
            updateRearViewRotation(degrees, state.editedMeshRotationX ?? 0, state.editedMeshRotationZ ?? 0);
        },
        onMeshRotationXPreview: (degrees) => {
            viewerSetMeshRotationX(degrees);
            updateRearViewRotation(state.editedMeshRotationY ?? 180, degrees, state.editedMeshRotationZ ?? 0);
        },
        onMeshRotationZPreview: (degrees) => {
            viewerSetMeshRotationZ(degrees);
            updateRearViewRotation(state.editedMeshRotationY ?? 180, state.editedMeshRotationX ?? 0, degrees);
        },
        onNavigateToPhoto: (photoId) => navigateToPhoto(photoId),
        onMarkReviewed: handleMarkReviewed,
        onNextPhoto: handleNextPhoto,
        onPrevPhoto: handlePrevPhoto,
        onBackToProjects: () => showProjectSelector(),
        onSphericalGridToggle: (visible) => setGridVisible(visible),
        onAddTarget: handleAddTarget,
        onDeleteTarget: handleDeleteTarget,
        onNearbyPreviewToggle: handleNearbyPreviewToggle,
        onNearbySelect: handleNearbySelect,
        onDeletePhoto: handleDeletePhoto,
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

    // Sync minimap target selection and preview viewer with state.
    // Track last fetched target to avoid re-fetching on every notify (e.g. slider changes).
    let lastPreviewTargetId = null;

    unsubscribeOnChange = onChange((s) => {
        setSelectedTarget(s.selectedTargetId);

        // Show/hide preview viewer only when the selected target changes
        if (s.selectedTargetId && s.selectedTargetId !== lastPreviewTargetId && s.currentMetadata?.targets) {
            const target = s.currentMetadata.targets.find(t => t.id === s.selectedTargetId);
            if (target) {
                lastPreviewTargetId = s.selectedTargetId;

                // Clear nearby preview when selecting a real target
                clearNearbyPreview();
                showAddButton(false);

                // Fetch target photo metadata to get its mesh_rotation_y/x/z
                fetchPhotoMetadata(target.id).then(meta => {
                    // Only show if still the same target
                    if (state.selectedTargetId === target.id) {
                        showPreview(
                            target.id,
                            target.display_name || target.id.slice(0, 8),
                            meta.camera?.mesh_rotation_y ?? 180,
                            meta.camera?.mesh_rotation_x ?? 0,
                            meta.camera?.mesh_rotation_z ?? 0,
                        );
                        showTargetActions(true, {
                            onHide: () => {
                                const hidden = isTargetHidden(state.selectedTargetId);
                                stateSetTargetHidden(state.selectedTargetId, !hidden);
                                updateHideButtonState(!hidden);
                            },
                            isHidden: isTargetHidden(target.id),
                        });
                    }
                }).catch(() => {
                    // Still show without correct mesh rotation
                    if (state.selectedTargetId === target.id) {
                        showPreview(target.id, target.display_name || target.id.slice(0, 8));
                        showTargetActions(true, {
                            onHide: () => {
                                const hidden = isTargetHidden(state.selectedTargetId);
                                stateSetTargetHidden(state.selectedTargetId, !hidden);
                                updateHideButtonState(!hidden);
                            },
                            isHidden: isTargetHidden(target.id),
                        });
                    }
                });
            }
        } else if (!s.selectedTargetId) {
            lastPreviewTargetId = null;
            showTargetActions(false);
            // Switch back to rear view (or hide if no nearby preview)
            const { previewingId } = getNearbyPreviewState();
            if (!previewingId) {
                hidePreview();
            }
        }
    });
}

/**
 * Desmonta todos os subsistemas da sessao de calibracao (viewer, navigator,
 * minimap, preview-viewer) e o listener de estado, liberando contextos WebGL,
 * o mapa MapLibre e listeners globais. Idempotente: sai cedo se nada foi
 * inicializado. Apos o teardown, a proxima carga de foto re-inicializa tudo.
 */
function teardownSubsystems() {
    if (!initialized) return;

    // Cancela qualquer carga em andamento e invalida cargas obsoletas.
    if (currentLoadController) {
        currentLoadController.abort();
        currentLoadController = null;
    }
    loadGeneration++;

    // Remove o listener de estado antes de descartar os subsistemas que ele usa.
    if (unsubscribeOnChange) {
        unsubscribeOnChange();
        unsubscribeOnChange = null;
    }

    disposeNavigator();
    disposeMinimap();
    disposePreviewViewer();
    disposeViewer();

    // Remove o canvas do viewer (dispose() do viewer nao o remove do DOM).
    if (viewerCanvasEl?.parentElement) {
        viewerCanvasEl.parentElement.removeChild(viewerCanvasEl);
    }
    viewerCanvasEl = null;

    initialized = false;
}

// ============================================================================
// RENDER LOOP CALLBACK
// ============================================================================

function onViewerRender(cameraState) {
    // Update navigator projection each frame
    updateCameraState(cameraState);
    updateNavigator(cameraState);

    // Sync rear view camera direction with main viewer (opposite direction)
    const lonDeg = (cameraState.yaw * 180) / Math.PI;
    const latDeg = (cameraState.pitch * 180) / Math.PI;
    syncRearViewCamera(lonDeg, latDeg, cameraState.fov);

    // Aponta o cone do minimapa para a direcao do olhar
    setViewDirection(lonDeg, cameraState.fov);
}

// ============================================================================
// CLICK HANDLERS
// ============================================================================

function onViewerClick(event) {
    handleClick(event);
}

// ============================================================================
// NAVIGATION
// ============================================================================

// Trava de reentrancia: enquanto o dialogo de dirty esta aberto (ou um save
// disparado por ele esta em curso), novas navegacoes/atalhos sao ignorados,
// evitando que edicoes/saves/discards concorrentes leiam estado vivo
// inconsistente durante o await do dialogo.
let isNavigating = false;

async function navigateToPhoto(photoIdOrTargetId) {
    if (isNavigating) return;

    // Check dirty state
    if (isDirty()) {
        isNavigating = true;
        try {
            const action = await showDirtyDialog();
            if (action === 'cancel') return;
            if (action === 'save') {
                const saved = await handleSave();
                // Save falhou (total ou parcial): nao navega para nao perder
                // as edicoes nem deixar o estado dirty divergente.
                if (!saved) return;
            }
            if (action === 'discard') discardChanges();
        } finally {
            isNavigating = false;
        }
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

/**
 * Salva todas as alteracoes pendentes da foto atual.
 * @returns {Promise<boolean>} true se tudo foi salvo (ou nao havia nada a
 *   salvar); false se houve falha total ou parcial.
 */
async function handleSave() {
    // Captura o photoId alvo no momento do save. Nao confiar em
    // state.currentPhotoId apos os awaits, pois a foto pode ter mudado
    // (navegacao concorrente) — isso salvaria calibracao na foto errada.
    const photoId = state.currentPhotoId;
    if (!photoId) return false;

    try {
        const promises = [];

        // Save mesh_rotation_y if changed
        if (
            state.editedMeshRotationY !== null &&
            state.editedMeshRotationY !== state.originalMeshRotationY
        ) {
            promises.push(
                saveCalibration(photoId, state.editedMeshRotationY)
            );
        }

        // Save mesh_rotation_x if changed
        if (
            state.editedMeshRotationX !== null &&
            state.editedMeshRotationX !== state.originalMeshRotationX
        ) {
            promises.push(
                saveMeshRotationX(photoId, state.editedMeshRotationX)
            );
        }

        // Save mesh_rotation_z if changed
        if (
            state.editedMeshRotationZ !== null &&
            state.editedMeshRotationZ !== state.originalMeshRotationZ
        ) {
            promises.push(
                saveMeshRotationZ(photoId, state.editedMeshRotationZ)
            );
        }

        // camera_height, distance_scale, marker_scale e os overrides de alvo
        // saíram do salvar: nenhum deles afeta o marcador, e nada na interface
        // os edita mais.

        // Save changed target visibility
        for (const [targetId, editedHidden] of state.editedTargetHidden) {
            const originalHidden = state.originalTargetHidden.get(targetId) ?? false;
            if (editedHidden !== originalHidden) {
                promises.push(
                    saveTargetVisibility(photoId, targetId, editedHidden)
                );
            }
        }
        // Check if a target was un-hidden (removed from editedTargetHidden but exists in original)
        for (const [targetId] of state.originalTargetHidden) {
            if (!state.editedTargetHidden.has(targetId)) {
                promises.push(
                    saveTargetVisibility(photoId, targetId, false)
                );
            }
        }

        if (promises.length === 0) {
            showToast('Nenhuma alteracao para salvar', 'info');
            return true;
        }

        // allSettled em vez de Promise.all: precisamos saber se houve falha
        // parcial. Em falha parcial NAO marcamos como limpo (markSaved), para
        // que o snapshot local nao divirja do banco e o usuario possa re-salvar.
        const results = await Promise.allSettled(promises);
        const failures = results.filter(r => r.status === 'rejected');

        if (failures.length > 0) {
            const succeeded = results.length - failures.length;
            console.error('Save partially failed:', failures.map(f => f.reason));
            showToast(
                `Falha ao salvar ${failures.length} de ${results.length} alteracao(oes). ` +
                `${succeeded} salva(s). Tente salvar novamente.`,
                'error'
            );
            return false;
        }

        // So marca como salvo se a foto editada ainda for a atual. Se o usuario
        // navegou durante o save, o snapshot local ja pertence a outra foto e
        // markSaved() corromperia o estado dirty da nova foto.
        if (state.currentPhotoId === photoId) {
            markSaved();
        }
        showToast(`${results.length} alteracao(oes) salva(s)`, 'success');
        return true;
    } catch (err) {
        console.error('Save failed:', err);
        showToast(`Erro ao salvar: ${err.message}`, 'error');
        return false;
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

// ============================================================================
// DELETE PHOTO (soft-delete)
// ============================================================================

async function handleDeletePhoto() {
    const photoId = state.currentPhotoId;
    const displayName = state.currentMetadata?.camera?.display_name || photoId?.slice(0, 8);

    const confirmed = await showDeletePhotoDialog(displayName);
    if (!confirmed) return;

    try {
        const result = await deletePhoto(photoId);
        showToast(`Foto ${displayName} excluida`, 'success');

        // Refresh project photo list
        const slug = state.currentProjectSlug || result.projectSlug;
        if (slug) {
            await loadProjectContext(slug);
        }

        // Navigate to previous (or next if at start, or back to projects)
        const prevId = getPrevPhotoId();
        const nextId = getNextPhotoId();
        if (prevId) {
            startCalibration(prevId);
        } else if (nextId) {
            startCalibration(nextId);
        } else {
            // No photos left — go back to project selector
            showProjectSelector();
        }
    } catch (err) {
        console.error('Failed to delete photo:', err);
        showToast(`Erro ao excluir foto: ${err.message}`, 'error');
    }
}

/**
 * Shows a large destructive confirmation dialog for deleting a photo.
 * @param {string} displayName - Display name of the photo being deleted
 * @returns {Promise<boolean>} Whether the user confirmed
 */
function showDeletePhotoDialog(displayName) {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'cal-dialog-overlay';
        overlay.innerHTML = `
            <div class="cal-dialog">
                <h3 class="cal-dialog__title">Excluir foto permanentemente?</h3>
                <p class="cal-dialog__text">
                    <strong>${displayName}</strong><br><br>
                    Todas as conexoes desta foto serao removidas.
                    Ela nao aparecera mais na navegacao.<br><br>
                    <em>O PMTiles precisara ser regenerado para remover o ponto do mapa.</em>
                </p>
                <div class="cal-dialog__actions">
                    <button class="cal-panel__btn cal-panel__btn--destructive" data-action="confirm">Excluir</button>
                    <button class="cal-panel__btn cal-panel__btn--ghost" data-action="cancel">Cancelar</button>
                </div>
            </div>
        `;

        overlay.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-action]');
            if (btn) {
                overlay.remove();
                resolve(btn.dataset.action === 'confirm');
            }
        });

        document.body.appendChild(overlay);
    });
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
        setRearViewTargets(metadata.targets, metadata.camera);
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

// ── Held-key state for smooth WASD rotation ──
const heldKeys = new Set();
let heldKeysAnimId = null;
let lastHeldKeyTime = 0;
const ROTATION_RATE = 20; // degrees per second

function onKeyDown(e) {
    // Don't handle shortcuts when typing in inputs
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    // Trava de navegacao: enquanto o dialogo de dirty/save esta aberto, ignora
    // todos os atalhos (WASD editam estado vivo, Q/E navegam) para nao gerar
    // edicoes/navegacoes concorrentes durante o await do dialogo.
    if (isNavigating) return;

    // Ctrl+S / Cmd+S = Save
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        if (isDirty()) handleSave();
        return;
    }

    // Escape = Deselect target
    if (e.key === 'Escape') {
        if (state.selectedTargetId) {
            deselectTarget();
        }
        return;
    }

    // ── Smooth rotation keys (WASD) — held for continuous rotation ──
    if (['w', 'a', 's', 'd'].includes(e.key)) {
        e.preventDefault();
        if (!heldKeys.has(e.key)) {
            heldKeys.add(e.key);
            if (!heldKeysAnimId) startHeldKeysLoop();
        }
        return;
    }

    // ── Instant action shortcuts ──

    // Q = Previous photo
    if (e.key === 'q') handlePrevPhoto();

    // E = Save + mark reviewed + next
    if (e.key === 'e') handleMarkReviewedAndNext();

    // R = Toggle hide selected marker (requires selected target)
    if (e.key === 'r' && state.selectedTargetId) {
        stateSetTargetHidden(state.selectedTargetId, !isTargetHidden(state.selectedTargetId));
    }


    // G = Toggle spherical grid
    if (e.key === 'g') {
        const newState = !isGridVisible();
        setGridVisible(newState);
        setSphericalGridToggleState(newState);
    }

    // Z = Reset mesh_rotation_z to 0
    if (e.key === 'z') {
        resetMeshRotationZ();
    }

    // X = Reset mesh_rotation_x to 0
    if (e.key === 'x') {
        resetMeshRotationX();
    }
}

function onKeyUp(e) {
    if (['w', 'a', 's', 'd'].includes(e.key)) {
        heldKeys.delete(e.key);
        if (heldKeys.size === 0) {
            stopHeldKeysLoop();
            flushHeldKeyState();
        }
    }
}

function onWindowBlur() {
    if (heldKeys.size > 0) {
        heldKeys.clear();
        stopHeldKeysLoop();
        flushHeldKeyState();
    }
}

function startHeldKeysLoop() {
    lastHeldKeyTime = 0;
    function tick(timestamp) {
        if (heldKeys.size === 0) {
            heldKeysAnimId = null;
            return;
        }
        if (!lastHeldKeyTime) lastHeldKeyTime = timestamp;
        const dt = Math.min((timestamp - lastHeldKeyTime) / 1000, 0.1);
        lastHeldKeyTime = timestamp;
        const delta = ROTATION_RATE * dt;

        if (heldKeys.has('w')) adjustMeshRotationZ(+delta, true);
        if (heldKeys.has('s')) adjustMeshRotationZ(-delta, true);
        if (heldKeys.has('a')) adjustMeshRotationX(+delta, true);
        if (heldKeys.has('d')) adjustMeshRotationX(-delta, true);

        heldKeysAnimId = requestAnimationFrame(tick);
    }
    heldKeysAnimId = requestAnimationFrame(tick);
}

function stopHeldKeysLoop() {
    if (heldKeysAnimId) {
        cancelAnimationFrame(heldKeysAnimId);
        heldKeysAnimId = null;
    }
    lastHeldKeyTime = 0;
}

/** Triggers panel re-render after held-key rotation ends. */
function flushHeldKeyState() {
    const x = state.editedMeshRotationX;
    if (x !== null && x !== undefined) {
        setMeshRotationX(x); // non-silent → triggers notify/re-render
    } else {
        const z = state.editedMeshRotationZ;
        if (z !== null && z !== undefined) {
            setMeshRotationZ(z);
        }
    }
}

function adjustMeshRotationX(delta, silent = false) {
    const current = state.editedMeshRotationX ?? 0;
    const newVal = Math.max(-30, Math.min(30, current + delta));
    setMeshRotationX(newVal, silent);
    viewerSetMeshRotationX(newVal);
    updateRearViewRotation(state.editedMeshRotationY ?? 180, newVal, state.editedMeshRotationZ ?? 0);
}

function adjustMeshRotationZ(delta, silent = false) {
    const current = state.editedMeshRotationZ ?? 0;
    const newVal = Math.max(-30, Math.min(30, current + delta));
    setMeshRotationZ(newVal, silent);
    viewerSetMeshRotationZ(newVal);
    updateRearViewRotation(state.editedMeshRotationY ?? 180, state.editedMeshRotationX ?? 0, newVal);
}

function resetMeshRotationX() {
    const original = state.originalMeshRotationX ?? 0;
    setMeshRotationX(original);
    viewerSetMeshRotationX(original);
    updateRearViewRotation(state.editedMeshRotationY ?? 180, original, state.editedMeshRotationZ ?? 0);
}

function resetMeshRotationZ() {
    const original = state.originalMeshRotationZ ?? 0;
    setMeshRotationZ(original);
    viewerSetMeshRotationZ(original);
    updateRearViewRotation(state.editedMeshRotationY ?? 180, state.editedMeshRotationX ?? 0, original);
}

async function handleMarkReviewedAndNext() {
    if (isDirty()) {
        const saved = await handleSave();
        // Save falhou (total ou parcial): nao marca como revisada nem avanca,
        // para nao registrar revisao sobre um estado nao persistido.
        if (!saved) return;
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
