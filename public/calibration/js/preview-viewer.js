/**
 * @fileoverview Mini preview viewer for the calibration interface.
 * Two modes:
 * - Rear view (default): shows the current photo rotated 180°, green border,
 *   camera slaved to main viewer (opposite direction), markers rendered on overlay
 * - Target view: shows the selected target's photo, orange border, action buttons,
 *   independent camera orbit
 */

import * as THREE from 'three';
import { getPhotoImageUrl } from './api.js';
import { StreetViewProjector } from './projector.js';
import { NAV_CONSTANTS } from './constants.js';
import { getEffectiveOverride, state, isTargetHidden } from './state.js';

// ============================================================================
// CONSTANTS
// ============================================================================

const PREVIEW_WIDTH = 576;
const PREVIEW_HEIGHT = 396;

// Border colors
const BORDER_TARGET = 'rgba(250, 179, 135, 0.6)';
const BORDER_REAR = 'rgba(166, 227, 161, 0.6)';
const LABEL_COLOR_TARGET = '#fab387';
const LABEL_COLOR_REAR = '#a6e3a1';

// Marker colors (rear view — higher contrast for small canvas)
const MARKER_FILL = 'rgba(255, 255, 255, 0.85)';
const MARKER_FILL_SELECTED = 'rgba(250, 179, 135, 0.9)';
const MARKER_FILL_HIDDEN = 'rgba(255, 255, 255, 0.25)';
const MARKER_STROKE = 'rgba(0, 0, 0, 0.5)';
const MARKER_STROKE_SELECTED = 'rgba(250, 179, 135, 1)';
const MARKER_DOT = 'rgba(0, 0, 0, 0.45)';
const MARKER_DOT_SELECTED = 'rgba(180, 100, 50, 0.9)';
const MARKER_DOT_HIDDEN = 'rgba(0, 0, 0, 0.15)';

// ============================================================================
// MODULE STATE
// ============================================================================

let camera, scene, renderer, sphere, material;
let containerEl = null;
let canvasEl = null;
let navigateBtn = null;
let addTargetBtn = null;
let closeBtn = null;
let hideTargetBtn = null;
let setClickBtn = null;
let animationFrameId = null;
let onNavigateCallback = null;
let onCloseCallback = null;
let onAddTargetCallback = null;
let onHideCallback = null;
let onSetClickCallback = null;

// Camera orbit
let lon = 0;
let lat = 0;
const fov = 75;

// Drag state
let isDragging = false;
let dragStartX = 0;
let dragStartY = 0;
let dragStartLon = 0;
let dragStartLat = 0;

// Current state
let currentTargetId = null;
let currentMode = 'rear'; // 'rear' | 'target'
let rearPhotoId = null;
let rearRotationY = 180;
let rearRotationX = 0;
let rearRotationZ = 0;

// Marker overlay (rear view only)
let markerCanvas = null;
let markerCtx = null;
let markerProjector = null;
let rearTargets = [];
let rearCameraConfig = null;
let mainViewerFov = 75;

// Reusable Vector3
const _lookAtTarget = new THREE.Vector3();
const textureLoader = new THREE.TextureLoader();

// ============================================================================
// INITIALIZATION
// ============================================================================

/**
 * Creates the preview viewer container and Three.js scene.
 * @param {HTMLElement} parentContainer - The viewer container to append to
 * @param {Object} [options] - Options
 * @param {Function} [options.onNavigate] - Called with photoId when user clicks navigate button
 * @param {Function} [options.onClose] - Called when close button is clicked
 */
export function initPreviewViewer(parentContainer, options = {}) {
    onNavigateCallback = options.onNavigate || null;
    onCloseCallback = options.onClose || null;

    // Create overlay container
    containerEl = document.createElement('div');
    containerEl.id = 'preview-viewer';
    containerEl.style.cssText = `
        position: absolute;
        top: 12px;
        left: 12px;
        width: ${PREVIEW_WIDTH}px;
        height: ${PREVIEW_HEIGHT}px;
        border-radius: 8px;
        border: 2px solid ${BORDER_REAR};
        overflow: hidden;
        z-index: 15;
        display: none;
        background: #11111b;
        box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
    `;
    parentContainer.appendChild(containerEl);

    // Label
    const label = document.createElement('div');
    label.id = 'preview-viewer-label';
    label.style.cssText = `
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        padding: 4px 8px;
        background: rgba(24, 24, 37, 0.85);
        color: ${LABEL_COLOR_REAR};
        font-size: 11px;
        font-weight: 600;
        z-index: 2;
        pointer-events: none;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    `;
    containerEl.appendChild(label);

    // Close button
    closeBtn = document.createElement('button');
    closeBtn.id = 'preview-viewer-close';
    closeBtn.textContent = '\u00d7';
    closeBtn.style.cssText = `
        position: absolute;
        top: 2px;
        right: 4px;
        width: 22px;
        height: 22px;
        border: none;
        border-radius: 4px;
        background: rgba(205, 214, 244, 0.15);
        color: #cdd6f4;
        font-size: 16px;
        line-height: 20px;
        text-align: center;
        cursor: pointer;
        z-index: 3;
        pointer-events: auto;
        transition: background 0.15s;
        padding: 0;
        display: none;
    `;
    closeBtn.addEventListener('mouseenter', () => {
        closeBtn.style.background = 'rgba(243, 139, 168, 0.5)';
    });
    closeBtn.addEventListener('mouseleave', () => {
        closeBtn.style.background = 'rgba(205, 214, 244, 0.15)';
    });
    closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (onCloseCallback) onCloseCallback();
    });
    containerEl.appendChild(closeBtn);

    // Navigate button
    navigateBtn = document.createElement('button');
    navigateBtn.id = 'preview-viewer-navigate';
    navigateBtn.textContent = 'Ir para esta foto \u2192';
    navigateBtn.style.cssText = `
        position: absolute;
        bottom: 8px;
        right: 8px;
        padding: 5px 12px;
        border: none;
        border-radius: 6px;
        background: rgba(250, 179, 135, 0.9);
        color: #1e1e2e;
        font-size: 11px;
        font-weight: 600;
        cursor: pointer;
        z-index: 3;
        pointer-events: auto;
        transition: background 0.15s;
        display: none;
    `;
    navigateBtn.addEventListener('mouseenter', () => {
        navigateBtn.style.background = 'rgba(250, 179, 135, 1)';
    });
    navigateBtn.addEventListener('mouseleave', () => {
        navigateBtn.style.background = 'rgba(250, 179, 135, 0.9)';
    });
    navigateBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (onNavigateCallback && currentTargetId) onNavigateCallback(currentTargetId);
    });
    containerEl.appendChild(navigateBtn);

    // Add target button (for nearby photos)
    addTargetBtn = document.createElement('button');
    addTargetBtn.id = 'preview-viewer-add';
    addTargetBtn.textContent = 'Adicionar Conexao';
    addTargetBtn.style.cssText = `
        position: absolute;
        bottom: 36px;
        right: 8px;
        padding: 5px 12px;
        border: none;
        border-radius: 6px;
        background: rgba(166, 227, 161, 0.9);
        color: #1e1e2e;
        font-size: 11px;
        font-weight: 600;
        cursor: pointer;
        z-index: 3;
        pointer-events: auto;
        transition: background 0.15s;
        display: none;
    `;
    addTargetBtn.addEventListener('mouseenter', () => {
        addTargetBtn.style.background = 'rgba(166, 227, 161, 1)';
    });
    addTargetBtn.addEventListener('mouseleave', () => {
        addTargetBtn.style.background = 'rgba(166, 227, 161, 0.9)';
    });
    addTargetBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (onAddTargetCallback && currentTargetId) onAddTargetCallback(currentTargetId);
    });
    containerEl.appendChild(addTargetBtn);

    // Hide target button
    hideTargetBtn = document.createElement('button');
    hideTargetBtn.id = 'preview-viewer-hide';
    hideTargetBtn.textContent = 'Ocultar';
    hideTargetBtn.style.cssText = `
        position: absolute;
        bottom: 36px;
        right: 8px;
        padding: 5px 12px;
        border: none;
        border-radius: 6px;
        background: rgba(239, 68, 68, 0.9);
        color: #fff;
        font-size: 11px;
        font-weight: 600;
        cursor: pointer;
        z-index: 3;
        pointer-events: auto;
        transition: background 0.15s;
        display: none;
    `;
    hideTargetBtn.addEventListener('mouseenter', () => {
        hideTargetBtn.style.background = 'rgba(239, 68, 68, 1)';
    });
    hideTargetBtn.addEventListener('mouseleave', () => {
        hideTargetBtn.style.background = 'rgba(239, 68, 68, 0.9)';
    });
    hideTargetBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (onHideCallback) onHideCallback();
    });
    containerEl.appendChild(hideTargetBtn);

    // Set-from-click button
    setClickBtn = document.createElement('button');
    setClickBtn.id = 'preview-viewer-setclick';
    setClickBtn.textContent = 'Definir com Clique';
    setClickBtn.style.cssText = `
        position: absolute;
        bottom: 64px;
        right: 8px;
        padding: 5px 12px;
        border: none;
        border-radius: 6px;
        background: rgba(250, 179, 135, 0.9);
        color: #1e1e2e;
        font-size: 11px;
        font-weight: 600;
        cursor: pointer;
        z-index: 3;
        pointer-events: auto;
        transition: background 0.15s;
        display: none;
    `;
    setClickBtn.addEventListener('mouseenter', () => {
        setClickBtn.style.background = 'rgba(250, 179, 135, 1)';
    });
    setClickBtn.addEventListener('mouseleave', () => {
        setClickBtn.style.background = 'rgba(250, 179, 135, 0.9)';
    });
    setClickBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (onSetClickCallback) onSetClickCallback();
    });
    containerEl.appendChild(setClickBtn);

    // ── Three.js setup ──
    camera = new THREE.PerspectiveCamera(75, PREVIEW_WIDTH / PREVIEW_HEIGHT, 0.1, 1000);
    camera.position.set(0, -0.1, 0);
    camera.rotation.order = 'YXZ';

    scene = new THREE.Scene();
    scene.add(camera);

    const geometry = new THREE.SphereGeometry(500, 40, 30);
    geometry.scale(-1, 1, 1);

    material = new THREE.MeshBasicMaterial({ color: 0x111111 });
    sphere = new THREE.Mesh(geometry, material);
    sphere.rotation.order = 'ZXY'; // Match main viewer rotation order
    scene.add(sphere);

    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(PREVIEW_WIDTH, PREVIEW_HEIGHT);

    canvasEl = renderer.domElement;
    canvasEl.style.display = 'block';
    containerEl.appendChild(canvasEl);

    // ── Marker overlay canvas (for rear view markers) ──
    markerCanvas = document.createElement('canvas');
    markerCanvas.width = PREVIEW_WIDTH;
    markerCanvas.height = PREVIEW_HEIGHT;
    markerCanvas.style.cssText = `
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        pointer-events: none;
        z-index: 1;
    `;
    containerEl.appendChild(markerCanvas);
    markerCtx = markerCanvas.getContext('2d');
    markerProjector = new StreetViewProjector(PREVIEW_WIDTH, PREVIEW_HEIGHT);

    // Events (for orbiting the preview — only active in target mode)
    canvasEl.addEventListener('pointerdown', onPointerDown);
    canvasEl.addEventListener('pointermove', onPointerMove);
    canvasEl.addEventListener('pointerup', onPointerUp);

    // Prevent clicks from propagating to main viewer
    containerEl.addEventListener('pointerdown', (e) => e.stopPropagation());
    containerEl.addEventListener('click', (e) => e.stopPropagation());
    containerEl.addEventListener('wheel', (e) => e.stopPropagation());
}

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Shows the rear view of the current photo (rotated 180°).
 * @param {string} photoId - Current photo UUID
 * @param {number} meshRotationY - Current mesh rotation Y in degrees
 * @param {number} [meshRotationX=0] - Current mesh rotation X in degrees
 * @param {number} [meshRotationZ=0] - Current mesh rotation Z in degrees
 */
export async function showRearView(photoId, meshRotationY, meshRotationX = 0, meshRotationZ = 0) {
    if (!containerEl) return;

    currentMode = 'rear';
    currentTargetId = null;
    rearRotationY = meshRotationY;
    rearRotationX = meshRotationX;
    rearRotationZ = meshRotationZ;

    // Set rear view appearance
    containerEl.style.borderColor = BORDER_REAR;
    const label = document.getElementById('preview-viewer-label');
    if (label) {
        label.textContent = 'Visao Traseira';
        label.style.color = LABEL_COLOR_REAR;
    }

    // Hide all action buttons in rear view
    hideAllButtons();

    // Set sphere rotation (180° offset on Y, negate X/Z for rear view).
    // With Euler order ZXY (Rz·Rx·Ry), flipping Y by 180° inverts the
    // local X and Z axes, so corrections must be negated to stay aligned.
    if (sphere) {
        sphere.rotation.y = THREE.MathUtils.degToRad(meshRotationY + 180);
        sphere.rotation.x = THREE.MathUtils.degToRad(-meshRotationX);
        sphere.rotation.z = THREE.MathUtils.degToRad(-meshRotationZ);
    }

    // Reset camera orbit
    lon = 0;
    lat = 0;

    containerEl.style.display = 'block';

    // Start animation if not running
    if (!animationFrameId) animate();

    // Load image only if photo changed
    if (rearPhotoId !== photoId) {
        rearPhotoId = photoId;

        const previewUrl = getPhotoImageUrl(photoId, 'preview');
        const fullUrl = getPhotoImageUrl(photoId, 'full');

        try {
            await loadTexture(previewUrl, true);
        } catch {
            // Preview failed
        }

        if (currentMode === 'rear' && rearPhotoId === photoId) {
            try {
                await loadTexture(fullUrl, false);
            } catch (err) {
                console.error('Preview viewer: failed to load full image:', err);
            }
        }
    }
}

/**
 * Updates the rear view rotation when calibration parameters change.
 * Only acts in rear view mode.
 * @param {number} meshRotationY - Current mesh rotation Y in degrees
 * @param {number} meshRotationX - Current mesh rotation X in degrees
 * @param {number} meshRotationZ - Current mesh rotation Z in degrees
 */
export function updateRearViewRotation(meshRotationY, meshRotationX, meshRotationZ) {
    if (currentMode !== 'rear' || !sphere) return;
    rearRotationY = meshRotationY;
    rearRotationX = meshRotationX;
    rearRotationZ = meshRotationZ;
    sphere.rotation.y = THREE.MathUtils.degToRad(meshRotationY + 180);
    sphere.rotation.x = THREE.MathUtils.degToRad(-meshRotationX);
    sphere.rotation.z = THREE.MathUtils.degToRad(-meshRotationZ);
}

/**
 * Syncs the rear view camera direction with the main viewer.
 * In rear mode, the camera is slaved to the main viewer (same lon/lat).
 * Because the sphere has +180° rotation, this shows the opposite direction.
 * @param {number} mainLonDeg - Main viewer lon in degrees
 * @param {number} mainLatDeg - Main viewer lat in degrees
 * @param {number} mainFov - Main viewer field of view in degrees
 */
export function syncRearViewCamera(mainLonDeg, mainLatDeg, mainFov) {
    if (currentMode !== 'rear') return;
    lon = mainLonDeg;
    lat = Math.max(-85, Math.min(85, mainLatDeg));
    mainViewerFov = mainFov;
}

/**
 * Sets the target data for rendering markers on the rear view.
 * @param {Array} targets - Array of target objects from the API
 * @param {Object} cameraConfig - Camera metadata { heading, height, lon, lat, distance_scale, marker_scale }
 */
export function setRearViewTargets(targets, cameraConfig) {
    rearTargets = targets || [];
    rearCameraConfig = cameraConfig;
    if (markerProjector) {
        markerProjector.setCameraConfig(cameraConfig);
    }
}

/**
 * Shows the preview viewer with the given target photo.
 * @param {string} targetId - Target photo UUID
 * @param {string} displayName - Display name for the label
 * @param {number} [meshRotationY=180] - Mesh rotation Y for the target photo
 * @param {number} [meshRotationX=0] - Mesh rotation X for the target photo
 * @param {number} [meshRotationZ=0] - Mesh rotation Z for the target photo
 */
export async function showPreview(targetId, displayName, meshRotationY = 180, meshRotationX = 0, meshRotationZ = 0) {
    if (!containerEl) return;

    // Don't reload if same target
    if (currentTargetId === targetId && currentMode === 'target') {
        containerEl.style.display = 'block';
        return;
    }

    currentMode = 'target';
    currentTargetId = targetId;
    containerEl.style.display = 'block';

    // Set target view appearance
    containerEl.style.borderColor = BORDER_TARGET;
    const label = document.getElementById('preview-viewer-label');
    if (label) {
        label.textContent = `Target: ${displayName}`;
        label.style.color = LABEL_COLOR_TARGET;
    }

    // Show target action buttons
    if (closeBtn) closeBtn.style.display = 'block';
    if (navigateBtn) navigateBtn.style.display = 'block';

    // Clear marker overlay (no markers in target mode)
    clearMarkerOverlay();

    // Reset camera
    lon = 0;
    lat = 0;

    // Set mesh rotation
    if (sphere) {
        sphere.rotation.y = THREE.MathUtils.degToRad(meshRotationY);
        sphere.rotation.x = THREE.MathUtils.degToRad(meshRotationX);
        sphere.rotation.z = THREE.MathUtils.degToRad(meshRotationZ);
    }

    // Start animation if not running
    if (!animationFrameId) animate();

    // Load panorama (preview first for speed, then full)
    const previewUrl = getPhotoImageUrl(targetId, 'preview');
    const fullUrl = getPhotoImageUrl(targetId, 'full');

    try {
        await loadTexture(previewUrl, true);
    } catch {
        // Preview failed
    }

    // Only load full if still showing same target
    if (currentTargetId === targetId) {
        try {
            await loadTexture(fullUrl, false);
        } catch (err) {
            console.error('Preview viewer: failed to load full image:', err);
        }
    }
}

/**
 * Switches back to rear view (called when target is deselected).
 * Does NOT hide the preview viewer.
 */
export function hidePreview() {
    if (!containerEl) return;

    onAddTargetCallback = null;
    if (addTargetBtn) addTargetBtn.style.display = 'none';

    // Switch back to rear view if a photo is loaded
    if (rearPhotoId) {
        currentMode = 'rear';
        currentTargetId = null;

        containerEl.style.borderColor = BORDER_REAR;
        const label = document.getElementById('preview-viewer-label');
        if (label) {
            label.textContent = 'Visao Traseira';
            label.style.color = LABEL_COLOR_REAR;
        }

        hideAllButtons();

        if (sphere) {
            sphere.rotation.y = THREE.MathUtils.degToRad(rearRotationY + 180);
            sphere.rotation.x = THREE.MathUtils.degToRad(-rearRotationX);
            sphere.rotation.z = THREE.MathUtils.degToRad(-rearRotationZ);
        }

        lon = 0;
        lat = 0;

        // Reload rear photo texture
        const previewUrl = getPhotoImageUrl(rearPhotoId, 'preview');
        const fullUrl = getPhotoImageUrl(rearPhotoId, 'full');
        loadTexture(previewUrl, true).catch(() => {});
        loadTexture(fullUrl, false).catch(() => {});

        if (!animationFrameId) animate();
    } else {
        containerEl.style.display = 'none';
        currentTargetId = null;
        if (animationFrameId) {
            cancelAnimationFrame(animationFrameId);
            animationFrameId = null;
        }
    }
}

/**
 * Returns the current target ID being previewed.
 * @returns {string|null}
 */
export function getCurrentPreviewTarget() {
    return currentTargetId;
}

/**
 * Shows or hides the "Adicionar Conexao" button on the preview viewer.
 * @param {boolean} visible - Whether to show the add button
 * @param {Function|null} [onAdd=null] - Callback when add button is clicked
 */
export function showAddButton(visible, onAdd = null) {
    onAddTargetCallback = onAdd;
    if (addTargetBtn) {
        addTargetBtn.style.display = visible ? 'block' : 'none';
    }
}

/**
 * Shows or hides the target action buttons (hide + set-from-click).
 * @param {boolean} visible - Whether to show the buttons
 * @param {Object} [options] - Options
 * @param {Function} [options.onHide] - Callback when hide button is clicked
 * @param {Function} [options.onSetFromClick] - Callback when set-from-click button is clicked
 * @param {boolean} [options.isHidden] - Current hidden state of the target
 */
export function showTargetActions(visible, options = {}) {
    onHideCallback = options.onHide || null;
    onSetClickCallback = options.onSetFromClick || null;

    if (hideTargetBtn) {
        hideTargetBtn.style.display = visible ? 'block' : 'none';
        if (visible) {
            hideTargetBtn.textContent = options.isHidden ? 'Mostrar' : 'Ocultar';
        }
    }
    if (setClickBtn) {
        setClickBtn.style.display = visible ? 'block' : 'none';
    }
}

/**
 * Updates the hide button text without recreating it.
 * @param {boolean} isHidden - Whether the target is currently hidden
 */
export function updateHideButtonState(isHidden) {
    if (hideTargetBtn) {
        hideTargetBtn.textContent = isHidden ? 'Mostrar' : 'Ocultar';
    }
}

// ============================================================================
// INTERNAL HELPERS
// ============================================================================

function hideAllButtons() {
    if (closeBtn) closeBtn.style.display = 'none';
    if (navigateBtn) navigateBtn.style.display = 'none';
    if (addTargetBtn) addTargetBtn.style.display = 'none';
    if (hideTargetBtn) hideTargetBtn.style.display = 'none';
    if (setClickBtn) setClickBtn.style.display = 'none';
}

function clearMarkerOverlay() {
    if (markerCtx) {
        markerCtx.clearRect(0, 0, PREVIEW_WIDTH, PREVIEW_HEIGHT);
    }
}

// ============================================================================
// TEXTURE LOADING
// ============================================================================

function loadTexture(url, isPreview) {
    return new Promise((resolve, reject) => {
        textureLoader.load(
            url,
            (texture) => {
                texture.colorSpace = THREE.SRGBColorSpace;

                if (isPreview && material.map && material.map.userData?.isFull) {
                    resolve();
                    return;
                }

                if (material.map) {
                    material.map.dispose();
                }

                texture.userData = { isFull: !isPreview };
                material.map = texture;
                material.color.set(0xffffff);
                material.needsUpdate = true;
                resolve();
            },
            undefined,
            (err) => reject(err)
        );
    });
}

// ============================================================================
// INPUT HANDLERS (target mode orbit only)
// ============================================================================

function onPointerDown(e) {
    // No orbit in rear mode (camera is slaved to main viewer)
    if (currentMode === 'rear') return;

    isDragging = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    dragStartLon = lon;
    dragStartLat = lat;
    canvasEl.setPointerCapture(e.pointerId);
    e.stopPropagation();
}

function onPointerMove(e) {
    if (!isDragging || currentMode === 'rear') return;
    e.stopPropagation();

    const dx = e.clientX - dragStartX;
    const dy = e.clientY - dragStartY;

    const sensitivity = 0.15;
    lon = dragStartLon - dx * sensitivity;
    lat = dragStartLat + dy * sensitivity;
    lat = Math.max(-85, Math.min(85, lat));
}

function onPointerUp(e) {
    isDragging = false;
    e.stopPropagation();
}

// ============================================================================
// MARKER RENDERING (rear view only)
// ============================================================================

/**
 * Projects and renders navigation markers on the rear view overlay canvas.
 * Uses the same projection math as the main navigator but for the rear view camera.
 * Reads current edited state values for height/distance_scale/marker_scale so that
 * markers stay in sync with the main view during live slider previews.
 */
function renderRearMarkers() {
    if (!markerCtx || currentMode !== 'rear' || !rearCameraConfig) {
        clearMarkerOverlay();
        return;
    }

    markerCtx.clearRect(0, 0, PREVIEW_WIDTH, PREVIEW_HEIGHT);

    if (!rearTargets.length || !markerProjector) return;

    // Use current edited state values (same values the main navigator uses)
    // so that markers stay in sync when the user adjusts sliders.
    const cameraHeight = state.editedCameraHeight ?? rearCameraConfig.height ?? NAV_CONSTANTS.DEFAULT_CAMERA_HEIGHT;
    const distanceScale = state.editedDistanceScale ?? rearCameraConfig.distance_scale ?? 1.0;
    const markerScale = state.editedMarkerScale ?? rearCameraConfig.marker_scale ?? 1.0;

    // Update projector's camera config so calculateMarkerSize/calculateFlattenRatio
    // use the same values as the main navigator.
    const currentConfig = {
        ...rearCameraConfig,
        height: cameraHeight,
        distance_scale: distanceScale,
        marker_scale: markerScale,
    };
    markerProjector.setCameraConfig(currentConfig);

    // Compute projection yaw for rear view.
    // Main viewer: worldHeading = imageHeading + lon → yaw = -worldHeading * PI/180
    // Rear view: sphere has +180° extra rotation, so effective heading = imageHeading + 180 + lon
    const imageHeading = rearCameraConfig.heading ?? 0;
    const rearWorldHeading = imageHeading + 180 + lon;
    const yaw = -(rearWorldHeading * Math.PI) / 180;
    const pitch = (lat * Math.PI) / 180;

    for (const target of rearTargets) {
        const hidden = isTargetHidden(target.id);
        const override = getEffectiveOverride(target.id);

        let x, z, y, horizontalDistance;
        let heightOffset = 0;

        if (override && override.bearing !== null) {
            // Override position
            const headingRad = (override.bearing * Math.PI) / 180;
            const groundDistance = override.distance ?? 5;
            x = Math.sin(headingRad) * groundDistance;
            z = -Math.cos(headingRad) * groundDistance;
            heightOffset = override.height ?? 0;
            y = -cameraHeight + heightOffset;
            horizontalDistance = groundDistance;
        } else {
            // GPS position
            const meters = markerProjector.lonLatToMeters(
                target.lon, target.lat,
                rearCameraConfig.lon, rearCameraConfig.lat
            );
            x = meters.x * distanceScale;
            z = meters.z * distanceScale;
            y = -cameraHeight;
            horizontalDistance = Math.sqrt(x * x + z * z);
        }

        const projected = markerProjector.metersToScreen(x, y, z, yaw, pitch, fov);
        if (!projected.visible) continue;

        const radius = markerProjector.calculateMarkerSize(
            NAV_CONSTANTS.MARKER_WORLD_RADIUS, horizontalDistance, fov, heightOffset
        );
        const flattenY = markerProjector.calculateFlattenRatio(horizontalDistance, pitch, heightOffset);

        const isSelected = target.id === state.selectedTargetId;

        // Draw marker with shadow, outer ring, and inner dot (matches main renderer style)
        markerCtx.save();
        markerCtx.translate(projected.screenX, projected.screenY);

        if (hidden) {
            markerCtx.globalAlpha = 0.4;
        }

        // Shadow below marker
        markerCtx.save();
        markerCtx.scale(1, flattenY);
        markerCtx.beginPath();
        markerCtx.arc(0, 3 / flattenY, radius * 1.1, 0, Math.PI * 2);
        markerCtx.fillStyle = 'rgba(0, 0, 0, 0.3)';
        markerCtx.fill();
        markerCtx.restore();

        // Selection glow
        if (isSelected) {
            markerCtx.save();
            markerCtx.scale(1, flattenY);
            markerCtx.beginPath();
            markerCtx.arc(0, 0, radius * 1.4, 0, Math.PI * 2);
            markerCtx.fillStyle = 'rgba(250, 179, 135, 0.3)';
            markerCtx.fill();
            markerCtx.restore();
        }

        // Outer circle — fill
        markerCtx.save();
        markerCtx.scale(1, flattenY);
        markerCtx.beginPath();
        markerCtx.arc(0, 0, radius, 0, Math.PI * 2);
        markerCtx.restore();
        markerCtx.fillStyle = isSelected ? MARKER_FILL_SELECTED : hidden ? MARKER_FILL_HIDDEN : MARKER_FILL;
        markerCtx.fill();

        // Outer circle — border
        markerCtx.save();
        markerCtx.scale(1, flattenY);
        markerCtx.beginPath();
        markerCtx.arc(0, 0, radius, 0, Math.PI * 2);
        markerCtx.restore();
        markerCtx.strokeStyle = isSelected ? MARKER_STROKE_SELECTED : MARKER_STROKE;
        markerCtx.lineWidth = isSelected ? 3 : 2;
        markerCtx.stroke();

        // Inner dot
        const innerRadius = radius * 0.4;
        markerCtx.save();
        markerCtx.scale(1, flattenY);
        markerCtx.beginPath();
        markerCtx.arc(0, 0, innerRadius, 0, Math.PI * 2);
        markerCtx.restore();
        markerCtx.fillStyle = isSelected ? MARKER_DOT_SELECTED : hidden ? MARKER_DOT_HIDDEN : MARKER_DOT;
        markerCtx.fill();

        markerCtx.restore();
    }
}

// ============================================================================
// RENDER LOOP
// ============================================================================

function animate() {
    animationFrameId = requestAnimationFrame(animate);

    if (!camera || !scene || !renderer) return;

    const phi = THREE.MathUtils.degToRad(90 - lat);
    const theta = THREE.MathUtils.degToRad(lon);

    _lookAtTarget.set(
        500 * Math.sin(phi) * Math.cos(theta),
        500 * Math.cos(phi),
        500 * Math.sin(phi) * Math.sin(theta)
    );
    camera.lookAt(_lookAtTarget);

    renderer.render(scene, camera);

    // Render markers in rear view mode
    if (currentMode === 'rear') {
        renderRearMarkers();
    }
}

// ============================================================================
// CLEANUP
// ============================================================================

/**
 * Disposes the preview viewer and releases GPU resources.
 */
export function disposePreviewViewer() {
    if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
    }

    if (canvasEl) {
        canvasEl.removeEventListener('pointerdown', onPointerDown);
        canvasEl.removeEventListener('pointermove', onPointerMove);
        canvasEl.removeEventListener('pointerup', onPointerUp);
    }

    if (material?.map) {
        material.map.dispose();
    }
    material?.dispose();
    sphere?.geometry.dispose();
    renderer?.dispose();

    if (containerEl?.parentElement) {
        containerEl.parentElement.removeChild(containerEl);
    }

    scene = null;
    camera = null;
    renderer = null;
    sphere = null;
    material = null;
    containerEl = null;
    canvasEl = null;
    navigateBtn = null;
    addTargetBtn = null;
    closeBtn = null;
    hideTargetBtn = null;
    setClickBtn = null;
    currentTargetId = null;
    rearPhotoId = null;
    currentMode = 'rear';
    onNavigateCallback = null;
    onCloseCallback = null;
    onAddTargetCallback = null;
    onHideCallback = null;
    onSetClickCallback = null;
    markerCanvas = null;
    markerCtx = null;
    markerProjector = null;
    rearTargets = [];
    rearCameraConfig = null;
}
