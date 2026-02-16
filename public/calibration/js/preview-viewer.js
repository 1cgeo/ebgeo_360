/**
 * @fileoverview Mini preview viewer for the calibration interface.
 * Shows a small 360 panorama of the selected target photo in the top-right corner.
 * Helps the user understand which direction the target should appear from.
 */

import * as THREE from 'three';
import { getPhotoImageUrl } from './api.js';

// ============================================================================
// MODULE STATE
// ============================================================================

let camera, scene, renderer, sphere, material;
let containerEl = null;
let canvasEl = null;
let navigateBtn = null;
let addTargetBtn = null;
let closeBtn = null;
let animationFrameId = null;
let onNavigateCallback = null;
let onCloseCallback = null;
let onAddTargetCallback = null;

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

// Current target being previewed
let currentTargetId = null;

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
        width: 576px;
        height: 396px;
        border-radius: 8px;
        border: 2px solid rgba(250, 179, 135, 0.6);
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
        color: #fab387;
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
    `;
    closeBtn.addEventListener('mouseenter', () => {
        closeBtn.style.background = 'rgba(243, 139, 168, 0.5)';
    });
    closeBtn.addEventListener('mouseleave', () => {
        closeBtn.style.background = 'rgba(205, 214, 244, 0.15)';
    });
    closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (onCloseCallback) {
            onCloseCallback();
        }
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
    `;
    navigateBtn.addEventListener('mouseenter', () => {
        navigateBtn.style.background = 'rgba(250, 179, 135, 1)';
    });
    navigateBtn.addEventListener('mouseleave', () => {
        navigateBtn.style.background = 'rgba(250, 179, 135, 0.9)';
    });
    navigateBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (onNavigateCallback && currentTargetId) {
            onNavigateCallback(currentTargetId);
        }
    });
    containerEl.appendChild(navigateBtn);

    // Add target button (hidden by default, shown for nearby photos)
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
        if (onAddTargetCallback && currentTargetId) {
            onAddTargetCallback(currentTargetId);
        }
    });
    containerEl.appendChild(addTargetBtn);

    const width = 576;
    const height = 396;

    // Camera
    camera = new THREE.PerspectiveCamera(75, width / height, 0.1, 1000);
    camera.position.set(0, -0.1, 0);
    camera.rotation.order = 'YXZ';

    // Scene
    scene = new THREE.Scene();
    scene.add(camera);

    // Inverted sphere
    const geometry = new THREE.SphereGeometry(500, 40, 30);
    geometry.scale(-1, 1, 1);

    material = new THREE.MeshBasicMaterial({ color: 0x111111 });
    sphere = new THREE.Mesh(geometry, material);
    scene.add(sphere);

    // Renderer
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height);

    canvasEl = renderer.domElement;
    canvasEl.style.display = 'block';
    containerEl.appendChild(canvasEl);

    // Events (for orbiting the preview)
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
 * Shows the preview viewer with the given target photo.
 * @param {string} targetId - Target photo UUID
 * @param {string} displayName - Display name for the label
 * @param {number} [meshRotationY=180] - Mesh rotation for the target photo
 */
export async function showPreview(targetId, displayName, meshRotationY = 180) {
    if (!containerEl) return;

    // Don't reload if same target
    if (currentTargetId === targetId) {
        containerEl.style.display = 'block';
        return;
    }

    currentTargetId = targetId;
    containerEl.style.display = 'block';

    // Update label
    const label = document.getElementById('preview-viewer-label');
    if (label) {
        label.textContent = `Target: ${displayName}`;
    }

    // Reset camera
    lon = 0;
    lat = 0;

    // Set mesh rotation
    if (sphere) {
        sphere.rotation.y = THREE.MathUtils.degToRad(meshRotationY);
    }

    // Start animation if not running
    if (!animationFrameId) {
        animate();
    }

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
 * Hides the preview viewer.
 */
export function hidePreview() {
    if (!containerEl) return;
    containerEl.style.display = 'none';
    currentTargetId = null;
    onAddTargetCallback = null;

    // Hide add button
    if (addTargetBtn) {
        addTargetBtn.style.display = 'none';
    }

    // Stop animation when hidden
    if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
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
// INPUT HANDLERS
// ============================================================================

function onPointerDown(e) {
    isDragging = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    dragStartLon = lon;
    dragStartLat = lat;
    canvasEl.setPointerCapture(e.pointerId);
    e.stopPropagation();
}

function onPointerMove(e) {
    if (!isDragging) return;
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
    currentTargetId = null;
    onNavigateCallback = null;
    onCloseCallback = null;
    onAddTargetCallback = null;
}
