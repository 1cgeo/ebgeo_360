/**
 * @fileoverview Three.js 360 panorama viewer for the calibration interface.
 * Renders an equirectangular photo on an inverted sphere with orbit-style controls.
 * Supports progressive loading (preview first, then full) and live mesh_rotation_y preview.
 */

import * as THREE from 'three';

// ============================================================================
// MODULE STATE
// ============================================================================

let camera, scene, renderer, sphere, material;
let containerEl, canvasEl;

// Camera orbit state (degrees)
let lon = 0;
let lat = 0;
let fov = 75;

// Drag state
let isDragging = false;
let dragStartX = 0;
let dragStartY = 0;
let dragStartLon = 0;
let dragStartLat = 0;
let pointerDownTime = 0;

// Current mesh rotation applied
let currentMeshRotationY = 180;
let currentMeshRotationX = 0;
let currentMeshRotationZ = 0;

// Perspective grid
let gridGroup = null;
let gridVisible = false;

// Animation
let animationFrameId = null;

// Reusable Vector3 for lookAt target (avoids allocation in render loop)
const _lookAtTarget = new THREE.Vector3();

// Callbacks
let onRenderCallback = null;
let onClickCallback = null;

// ============================================================================
// INITIALIZATION
// ============================================================================

/**
 * Initializes the Three.js panorama viewer.
 * @param {HTMLElement} container - DOM element to mount the viewer in
 * @param {Object} [options] - Options
 * @param {Function} [options.onRender] - Called each frame with { yaw, pitch, fov }
 * @param {Function} [options.onClick] - Called on click with { clientX, clientY }
 * @returns {{ canvas: HTMLCanvasElement }}
 */
export function initViewer(container, options = {}) {
    containerEl = container;
    onRenderCallback = options.onRender || null;
    onClickCallback = options.onClick || null;

    const width = container.clientWidth;
    const height = container.clientHeight;

    // Camera
    camera = new THREE.PerspectiveCamera(75, width / height, 0.1, 1000);
    camera.position.set(0, -0.1, 0);
    camera.rotation.order = 'YXZ';

    // Scene
    scene = new THREE.Scene();
    scene.add(camera);

    // Inverted sphere for 360 panorama
    const geometry = new THREE.SphereGeometry(500, 60, 40);
    geometry.scale(-1, 1, 1);

    material = new THREE.MeshBasicMaterial({ color: 0x111111 });

    sphere = new THREE.Mesh(geometry, material);
    sphere.rotation.order = 'ZXY';
    scene.add(sphere);

    // Renderer
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(width, height);

    canvasEl = renderer.domElement;
    canvasEl.style.display = 'block';
    container.appendChild(canvasEl);

    // Events
    canvasEl.addEventListener('pointerdown', onPointerDown);
    canvasEl.addEventListener('pointermove', onPointerMove);
    canvasEl.addEventListener('pointerup', onPointerUp);
    canvasEl.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('resize', onResize);

    // Start render loop
    animate();

    return { canvas: canvasEl };
}

// ============================================================================
// TEXTURE LOADING
// ============================================================================

const textureLoader = new THREE.TextureLoader();

/**
 * Loads a panorama image onto the sphere.
 * @param {string} url - Image URL
 * @param {boolean} [isPreview=false] - Whether this is a low-quality preview
 * @returns {Promise<void>}
 */
export function loadPanorama(url, isPreview = false) {
    return new Promise((resolve, reject) => {
        textureLoader.load(
            url,
            (texture) => {
                texture.colorSpace = THREE.SRGBColorSpace;

                // Don't replace full-quality texture with preview
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

/**
 * Loads a photo with progressive quality (preview first, then full).
 * @param {string} previewUrl - Preview image URL
 * @param {string} fullUrl - Full quality image URL
 */
export async function loadProgressive(previewUrl, fullUrl) {
    // Load preview first for fast display
    try {
        await loadPanorama(previewUrl, true);
    } catch {
        // Preview failed, will try full directly
    }

    // Then load full quality
    try {
        await loadPanorama(fullUrl, false);
    } catch (err) {
        console.error('Failed to load full panorama:', err);
    }
}

// ============================================================================
// MESH ROTATION
// ============================================================================

/**
 * Sets the mesh rotation Y (live preview for calibration slider).
 * @param {number} degrees - Rotation in degrees (0-360)
 */
export function setMeshRotationY(degrees) {
    currentMeshRotationY = degrees;
    if (sphere) {
        sphere.rotation.y = THREE.MathUtils.degToRad(degrees);
    }
}

/**
 * Gets the current mesh rotation Y in degrees.
 * @returns {number}
 */
export function getMeshRotationY() {
    return currentMeshRotationY;
}

/**
 * Sets the mesh rotation X (pitch tilt for calibration).
 * @param {number} degrees - Rotation in degrees (-30 to +30)
 */
export function setMeshRotationX(degrees) {
    currentMeshRotationX = degrees;
    if (sphere) {
        sphere.rotation.x = THREE.MathUtils.degToRad(degrees);
    }
}

/**
 * Sets the mesh rotation Z (roll tilt for calibration).
 * @param {number} degrees - Rotation in degrees (-30 to +30)
 */
export function setMeshRotationZ(degrees) {
    currentMeshRotationZ = degrees;
    if (sphere) {
        sphere.rotation.z = THREE.MathUtils.degToRad(degrees);
    }
}

// ============================================================================
// CAMERA CONTROL
// ============================================================================

/**
 * Gets the current camera orientation.
 * @returns {{ yaw: number, pitch: number, fov: number }}
 */
export function getCameraState() {
    // yaw: horizontal rotation in radians (matching Three.js convention)
    const yawRad = THREE.MathUtils.degToRad(lon);
    // pitch: vertical rotation in radians
    const pitchRad = THREE.MathUtils.degToRad(lat);
    return { yaw: yawRad, pitch: pitchRad, fov };
}

/**
 * Sets the camera to look at a specific heading.
 * @param {number} heading - Heading in degrees (0-360, 0 = North)
 */
export function setHeading(heading) {
    lon = heading;
}

/**
 * Gets the canvas element.
 * @returns {HTMLCanvasElement}
 */
export function getCanvas() {
    return canvasEl;
}

/**
 * Gets the current canvas dimensions.
 * @returns {{ width: number, height: number }}
 */
export function getCanvasSize() {
    return {
        width: canvasEl?.width || 0,
        height: canvasEl?.height || 0,
    };
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
    pointerDownTime = performance.now();
    canvasEl.setPointerCapture(e.pointerId);
}

function onPointerMove(e) {
    if (!isDragging) return;

    const dx = e.clientX - dragStartX;
    const dy = e.clientY - dragStartY;

    // Scale rotation by FOV for consistent feel at different zoom levels
    const baseSensitivity = 0.1;
    const fovFactor = fov / 75;
    const sensitivity = baseSensitivity * fovFactor;
    lon = dragStartLon - dx * sensitivity;
    lat = dragStartLat + dy * sensitivity;

    // Clamp vertical look
    lat = Math.max(-85, Math.min(85, lat));
}

function onPointerUp(e) {
    const wasDragging = isDragging;
    isDragging = false;

    if (!wasDragging) return;

    // Detect click vs drag
    const dx = Math.abs(e.clientX - dragStartX);
    const dy = Math.abs(e.clientY - dragStartY);
    const elapsed = performance.now() - pointerDownTime;

    if (dx < 5 && dy < 5 && elapsed < 300) {
        // This was a click
        if (onClickCallback) {
            const rect = canvasEl.getBoundingClientRect();
            onClickCallback({
                clientX: e.clientX - rect.left,
                clientY: e.clientY - rect.top,
            });
        }
    }
}

function onWheel(e) {
    e.preventDefault();
    fov += e.deltaY * 0.05;
    fov = Math.max(10, Math.min(75, fov));
    if (camera) {
        camera.fov = fov;
        camera.updateProjectionMatrix();
    }
}

function onResize() {
    if (!containerEl || !camera || !renderer) return;
    const width = containerEl.clientWidth;
    const height = containerEl.clientHeight;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height);
}

// ============================================================================
// RENDER LOOP
// ============================================================================

function animate() {
    animationFrameId = requestAnimationFrame(animate);

    if (!camera || !scene || !renderer) return;

    // Update camera from lon/lat (matching EBGeo's explicit spherical math)
    const phi = THREE.MathUtils.degToRad(90 - lat);
    const theta = THREE.MathUtils.degToRad(lon);

    _lookAtTarget.set(
        500 * Math.sin(phi) * Math.cos(theta),
        500 * Math.cos(phi),
        500 * Math.sin(phi) * Math.sin(theta)
    );
    camera.lookAt(_lookAtTarget);

    renderer.render(scene, camera);

    // Notify render callback with camera state
    if (onRenderCallback) {
        const yawRad = THREE.MathUtils.degToRad(lon);
        const pitchRad = THREE.MathUtils.degToRad(lat);
        onRenderCallback({ yaw: yawRad, pitch: pitchRad, fov });
    }
}

// ============================================================================
// PERSPECTIVE GRID
// ============================================================================

const GRID_RADIUS = 499;
const GRID_PARALLELS = [
    -80, -70, -60, -50, -40, -30, -20, -10,
    0,
    10, 20, 30, 40, 50, 60, 70, 80,
];
const GRID_MERIDIANS = [
    0, 15, 30, 45, 60, 75, 90, 105,
    120, 135, 150, 165, 180, 195, 210, 225,
    240, 255, 270, 285, 300, 315, 330, 345,
];

/**
 * Creates the perspective grid geometry (parallels + meridians on the sphere).
 * Added directly to the scene so lines stay fixed when mesh rotations change.
 * This makes the grid a stable reference — the image moves, the lines don't.
 */
function createGridGeometry() {
    gridGroup = new THREE.Group();

    const normalMat = new THREE.LineBasicMaterial({
        color: 0x00c8ff, transparent: true, opacity: 0.35, depthTest: false,
    });
    const equatorMat = new THREE.LineBasicMaterial({
        color: 0x00ff88, transparent: true, opacity: 0.7, depthTest: false,
    });

    for (const lat of GRID_PARALLELS) {
        const mat = lat === 0 ? equatorMat : normalMat;
        gridGroup.add(createParallelLine(lat, GRID_RADIUS, mat));
    }

    for (const lon of GRID_MERIDIANS) {
        gridGroup.add(createMeridianLine(lon, GRID_RADIUS, normalMat));
    }

    scene.add(gridGroup);
}

/**
 * Creates a latitude circle (parallel) on the sphere.
 * @param {number} latDeg - Latitude in degrees
 * @param {number} radius - Sphere radius
 * @param {THREE.LineBasicMaterial} mat - Line material
 * @returns {THREE.Line}
 */
function createParallelLine(latDeg, radius, mat) {
    const latRad = THREE.MathUtils.degToRad(latDeg);
    const cosLat = Math.cos(latRad);
    const sinLat = Math.sin(latRad);
    const points = [];
    const segments = 72;
    for (let i = 0; i <= segments; i++) {
        const lonRad = (i / segments) * Math.PI * 2;
        points.push(new THREE.Vector3(
            radius * cosLat * Math.sin(lonRad),
            radius * sinLat,
            radius * cosLat * Math.cos(lonRad),
        ));
    }
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    return new THREE.Line(geometry, mat);
}

/**
 * Creates a longitude half-circle (meridian) on the sphere.
 * @param {number} lonDeg - Longitude in degrees
 * @param {number} radius - Sphere radius
 * @param {THREE.LineBasicMaterial} mat - Line material
 * @returns {THREE.Line}
 */
function createMeridianLine(lonDeg, radius, mat) {
    const lonRad = THREE.MathUtils.degToRad(lonDeg);
    const sinLon = Math.sin(lonRad);
    const cosLon = Math.cos(lonRad);
    const points = [];
    const segments = 36;
    for (let i = 0; i <= segments; i++) {
        const latRad = THREE.MathUtils.degToRad(-80 + (i / segments) * 160);
        points.push(new THREE.Vector3(
            radius * Math.cos(latRad) * sinLon,
            radius * Math.sin(latRad),
            radius * Math.cos(latRad) * cosLon,
        ));
    }
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    return new THREE.Line(geometry, mat);
}

/**
 * Shows or hides the perspective grid overlay.
 * @param {boolean} visible - Whether to show the grid
 */
export function setGridVisible(visible) {
    gridVisible = visible;
    if (visible && !gridGroup && scene) {
        createGridGeometry();
    }
    if (gridGroup) {
        gridGroup.visible = visible;
    }
}

/**
 * Returns whether the perspective grid is currently visible.
 * @returns {boolean}
 */
export function isGridVisible() {
    return gridVisible;
}

// ============================================================================
// CLEANUP
// ============================================================================

/**
 * Disposes of the viewer and releases GPU resources.
 */
export function dispose() {
    if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
    }

    if (canvasEl) {
        canvasEl.removeEventListener('pointerdown', onPointerDown);
        canvasEl.removeEventListener('pointermove', onPointerMove);
        canvasEl.removeEventListener('pointerup', onPointerUp);
        canvasEl.removeEventListener('wheel', onWheel);
    }

    window.removeEventListener('resize', onResize);

    if (gridGroup) {
        gridGroup.traverse((child) => {
            if (child.geometry) child.geometry.dispose();
            if (child.material) child.material.dispose();
        });
        gridGroup = null;
    }

    if (material?.map) {
        material.map.dispose();
    }
    material?.dispose();
    sphere?.geometry.dispose();
    renderer?.dispose();

    scene = null;
    camera = null;
    renderer = null;
    sphere = null;
    material = null;
}

/**
 * Force a resize recalculation (useful after layout changes).
 */
export function forceResize() {
    onResize();
}
