/**
 * @fileoverview Navigation orchestrator for the Street View 360 calibration interface.
 * Projects targets to screen coordinates, manages ground cursor, handles click/hover.
 *
 * All projection, sizing, flattening and cursor logic is taken verbatim from
 * EBGeo's StreetViewNavigator so that the calibration view matches production.
 */

import { NAV_CONSTANTS } from './constants.js';
import { StreetViewProjector } from './projector.js';
import { StreetViewRenderer } from './renderer.js';
import { StreetViewHitTester } from './hit-tester.js';
import { getEffectiveOverride, state, isTargetHidden } from './state.js';

// ============================================================================
// MODULE STATE
// ============================================================================

let projector = null;
let navRenderer = null;
let hitTester = null;
let overlayCanvas = null;

// Camera and targets data
let cameraConfig = null;
let targets = [];
let nearbyPhotos = [];              // Nearby unconnected photos for visual representation
let nearbyPreviewEnabled = false;   // Whether nearby preview mode is active
let onNearbyClickCallback = null;   // Called when a nearby photo marker is clicked
let nearestTargetId = null;        // Nearest target by geographic distance (set once per photo — EBGeo pattern)
let cursorNearestTargetId = null;  // Nearest target to cursor on ground (dynamic per frame)

// Ground grid
let groundGridVisible = false;

// Mouse state
let mouseX = 0;
let mouseY = 0;
let hoveredId = null;

// Current camera state (stored from last render for click handling)
let currentYaw = 0;
let currentPitch = 0;
let currentFov = 75;

// Callbacks
let onNavigateCallback = null;
let onTargetSelectCallback = null;
let onSetFromClickCallback = null;

// ============================================================================
// INITIALIZATION
// ============================================================================

/**
 * Initializes the navigation system.
 * @param {HTMLElement} container - The viewer container element
 * @param {Object} options - Options
 * @param {Function} [options.onNavigate] - Called when user clicks a target to navigate
 * @param {Function} [options.onTargetSelect] - Called when user clicks a target for selection
 * @param {Function} [options.onSetFromClick] - Called when user clicks in "set from click" mode
 */
export function initNavigator(container, options = {}) {
    onNavigateCallback = options.onNavigate || null;
    onTargetSelectCallback = options.onTargetSelect || null;
    onSetFromClickCallback = options.onSetFromClick || null;

    const width = container.clientWidth;
    const height = container.clientHeight;

    // Create overlay canvas
    overlayCanvas = document.createElement('canvas');
    overlayCanvas.width = width;
    overlayCanvas.height = height;
    overlayCanvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;';
    container.appendChild(overlayCanvas);

    projector = new StreetViewProjector(width, height);
    navRenderer = new StreetViewRenderer(overlayCanvas);
    hitTester = new StreetViewHitTester();

    // Track mouse on the container
    container.addEventListener('mousemove', onMouseMove);

    // Handle resize
    window.addEventListener('resize', () => {
        const w = container.clientWidth;
        const h = container.clientHeight;
        overlayCanvas.width = w;
        overlayCanvas.height = h;
        projector.resize(w, h);
        navRenderer.resize(w, h);
    });
}

// ============================================================================
// DATA
// ============================================================================

/**
 * Sets the camera configuration for the current photo.
 * @param {Object} config - Camera metadata { heading, height, lon, lat, ele, mesh_rotation_y }
 */
export function setCameraConfig(config) {
    cameraConfig = config;
    if (projector) {
        projector.setCameraConfig(config);
    }
}

/**
 * Sets the navigation targets for the current photo.
 * @param {Array} newTargets - Array of target objects from the API
 */
export function setTargets(newTargets) {
    targets = newTargets || [];
    updateNearestTarget();
}

/**
 * Sets the nearby unconnected photos for visual representation on the canvas.
 * @param {Array} photos - Array of nearby photo objects { id, lon, lat, displayName, distance }
 */
export function setNearbyPhotos(photos) {
    nearbyPhotos = photos || [];
}

/**
 * Sets the nearby preview mode and click callback.
 * @param {boolean} enabled - Whether nearby preview mode is active
 * @param {Function|null} [onClick=null] - Called with nearby photo data when clicked
 */
export function setNearbyPreviewMode(enabled, onClick = null) {
    nearbyPreviewEnabled = enabled;
    onNearbyClickCallback = onClick;
}

/**
 * Updates which target is the nearest by geographic distance from camera.
 * Matching EBGeo: this is computed once per photo, not per frame.
 */
function updateNearestTarget() {
    if (!targets.length || !cameraConfig || !projector) {
        nearestTargetId = null;
        return;
    }

    let bestId = null;
    let bestDist = Infinity;

    for (const target of targets) {
        if (isTargetHidden(target.id)) continue;
        const { x, z } = projector.lonLatToMeters(
            target.lon, target.lat,
            cameraConfig.lon, cameraConfig.lat
        );
        const dist = Math.sqrt(x * x + z * z);
        if (dist < bestDist) {
            bestDist = dist;
            bestId = target.id;
        }
    }

    nearestTargetId = bestId;
}

// ============================================================================
// PROJECTION (called each frame by app.js)
// ============================================================================

/**
 * Updates projections and renders navigation overlay for the current frame.
 * Must be called each frame from the viewer's render callback.
 *
 * The conversion from viewer lon/lat (radians) to yaw/pitch matches EBGeo's
 * StreetViewNavigator.render() exactly.
 *
 * @param {{ yaw: number, pitch: number, fov: number }} cameraState - Current camera state
 */
export function update(cameraState) {
    if (!projector || !navRenderer || !cameraConfig) return;

    const { yaw: lonRad, pitch: latRad, fov } = cameraState;

    // ── Convert viewer lon (radians) to world heading (EBGeo pattern) ──
    // lon=0 means looking at imageHeading direction.
    // worldHeading = imageHeading + lon
    // yaw = -worldHeading  (targets at north = -Z in world space)
    const lonDeg = (lonRad * 180) / Math.PI;
    const imageHeading = cameraConfig.heading ?? 0;
    const worldHeadingDeg = imageHeading + lonDeg;
    const yaw = -(worldHeadingDeg * Math.PI) / 180;
    // EBGeo: const pitch = (latDeg * Math.PI) / 180;
    // latRad is already in radians, so use directly.
    const pitch = latRad;

    // Store for click handling
    currentYaw = yaw;
    currentPitch = pitch;
    currentFov = fov;

    // ── FOV visibility (EBGeo pattern) ──
    const shouldShowMarkers = fov > NAV_CONSTANTS.HIDE_ARROWS_FOV;
    const scaleFactor = fov <= NAV_CONSTANTS.SCALE_ARROWS_FOV
        ? (fov - NAV_CONSTANTS.HIDE_ARROWS_FOV) / (NAV_CONSTANTS.SCALE_ARROWS_FOV - NAV_CONSTANTS.HIDE_ARROWS_FOV)
        : 1;

    // ── Project navigation targets (EBGeo pattern) ──
    const markers = [];

    if (shouldShowMarkers) {
        for (const target of targets) {
            const projected = projectTarget(target, yaw, pitch, fov);
            if (projected) {
                projected.radius *= scaleFactor;
                projected.type = 'navigation';
                projected.data = target;
                markers.push(projected);
            }
        }
    }

    // ── Project nearby photos as grey markers ──
    const nearbyMarkers = [];
    if (shouldShowMarkers && nearbyPhotos.length > 0 && cameraConfig) {
        for (const photo of nearbyPhotos) {
            const projected = projectNearbyPhoto(photo, yaw, pitch, fov);
            if (projected) {
                projected.radius *= scaleFactor;
                nearbyMarkers.push(projected);
            }
        }
    }

    // ── Update hit tester (includes nearby markers when preview enabled) ──
    const allHittable = nearbyPreviewEnabled ? [...markers, ...nearbyMarkers] : markers;
    hitTester.setMarkers(allHittable);

    // ── Hit test for hover ──
    const hitMarker = hitTester.testPoint(mouseX, mouseY);
    const newHoveredId = hitMarker ? hitMarker.id : null;
    if (newHoveredId !== hoveredId) {
        hoveredId = newHoveredId;
        refreshCursorStyle();
    }

    // ── Update renderer (EBGeo pattern) ──
    navRenderer.setMarkers(markers);
    navRenderer.setSelectedMarker(null); // calibration doesn't have POI selection
    navRenderer.setNearestMarker(nearestTargetId);

    // ── Ground cursor (EBGeo updateGroundCursor pattern) ──
    updateGroundCursor(markers, yaw, pitch, fov);

    // Set cursor nearest after updateGroundCursor computes it
    navRenderer.setCursorNearestMarker(cursorNearestTargetId);

    // ── Ground grid ──
    if (groundGridVisible && cameraConfig) {
        navRenderer.setGroundGrid(projectGroundGrid(yaw, pitch, fov));
    } else {
        navRenderer.setGroundGrid(null);
    }

    // ── Set nearby markers for rendering (only when preview mode is active) ──
    navRenderer.setNearbyMarkers(nearbyPreviewEnabled ? nearbyMarkers : []);

    // ── Render ──
    navRenderer.render();
}

// ============================================================================
// GROUND CURSOR  (verbatim EBGeo updateGroundCursor)
// ============================================================================

/**
 * Updates the ground cursor that follows the mouse.
 * Don't show cursor if hovering a marker (EBGeo pattern).
 */
function updateGroundCursor(markers, yaw, pitch, fov) {
    // EBGeo: if (this.markerToolActive || this.renderer.hoveredMarkerId) …
    if (hoveredId) {
        navRenderer.setGroundCursor(null);
        cursorNearestTargetId = null;
        navRenderer.setCursorNearestMarker(null);
        return;
    }

    // Project mouse position to ground
    const ground = projector.screenToGround(mouseX, mouseY, yaw, pitch, fov);

    if (!ground) {
        navRenderer.setGroundCursor(null);
        cursorNearestTargetId = null;
        navRenderer.setCursorNearestMarker(null);
        return;
    }

    // Calculate flatten ratio for the cursor position
    const cursorDistance = Math.sqrt(ground.x * ground.x + ground.z * ground.z);
    const flattenY = projector.calculateFlattenRatio(cursorDistance, pitch);

    // Find the nearest target to the cursor position (dynamically)
    const nearestTarget = findNearestTargetToCursor(ground);
    cursorNearestTargetId = nearestTarget?.id || null;

    // Calculate arrow angle pointing to nearest marker using screen coordinates
    let arrowAngle = null;
    if (nearestTarget) {
        // Find the projected marker to get its screen position
        const projectedMarker = markers.find(m => m.id === nearestTarget.id);
        if (projectedMarker) {
            // EBGeo: calculateArrowAngleToScreen
            const dx = projectedMarker.screenX - mouseX;
            const dy = projectedMarker.screenY - mouseY;
            arrowAngle = Math.atan2(dx, -dy);
        }
    }

    // Set ground cursor data (fov needed for physically-based sizing)
    navRenderer.setGroundCursor({
        screenX: mouseX,
        screenY: mouseY,
        flattenY,
        arrowAngle,
        distance: cursorDistance,
        fov,
    });
}

// ============================================================================
// TARGET PROJECTION  (verbatim EBGeo projectTarget / projectFromSpherical)
// ============================================================================

/**
 * Projects a navigation target to screen coordinates.
 * Mirrors EBGeo StreetViewNavigator.projectTarget exactly.
 */
function projectTarget(target, yaw, pitch, fov) {
    if (!cameraConfig) return null;

    // Check for effective override (edited > original)
    const override = getEffectiveOverride(target.id);

    // If target has a ground-plane override, project from bearing + distance.
    if (override && override.bearing !== null) {
        return projectFromOverride(
            override.bearing,
            override.distance ?? 5,
            target, yaw, pitch, fov,
            override.height ?? 0
        );
    }

    // Convert lon/lat to meters, then apply distance_scale
    let { x, z } = projector.lonLatToMeters(
        target.lon, target.lat,
        cameraConfig.lon, cameraConfig.lat
    );
    const distanceScale = cameraConfig.distance_scale ?? 1.0;
    x *= distanceScale;
    z *= distanceScale;

    const cameraHeight = cameraConfig.height ?? NAV_CONSTANTS.DEFAULT_CAMERA_HEIGHT;
    const y = -cameraHeight;

    // Horizontal distance (for flatten ratio — ground-plane perspective)
    const horizontalDistance = Math.sqrt(x * x + z * z);

    // Project to screen
    const projected = projector.metersToScreen(x, y, z, yaw, pitch, fov);

    if (!projected.visible) return null;

    const radius = projector.calculateMarkerSize(
        NAV_CONSTANTS.MARKER_WORLD_RADIUS, horizontalDistance, fov
    );
    const flattenY = projector.calculateFlattenRatio(horizontalDistance, pitch);

    return {
        id: target.id,
        screenX: projected.screenX,
        screenY: projected.screenY,
        distance: projected.distance,
        radius,
        flattenY,
        // Calibration-specific metadata
        isNext: target.next,
        hasOverride: override !== null,
        isCalibrationSelected: target.id === state.selectedTargetId,
        isHidden: isTargetHidden(target.id),
        displayName: target.display_name || target.id.slice(0, 8),
    };
}

/**
 * Projects from override coordinates (bearing + ground distance + height offset).
 * Uses the same ground-plane projection as geographic markers and the mouse cursor,
 * so override markers look identical to where the user clicked.
 * The height offset raises/lowers the marker from the ground plane.
 *
 * @param {number} bearingDeg - Bearing from camera in degrees (0=North, CW)
 * @param {number} groundDistance - Distance from camera on the ground plane in meters
 * @param {Object} target - Target data
 * @param {number} yaw - Camera yaw
 * @param {number} pitch - Camera pitch
 * @param {number} fov - Camera FOV
 * @param {number} [overrideHeight=0] - Manual height offset in meters (positive = above ground)
 */
function projectFromOverride(bearingDeg, groundDistance, target, yaw, pitch, fov, overrideHeight = 0) {
    if (!cameraConfig) return null;

    const headingRad = (bearingDeg * Math.PI) / 180;

    // Convert bearing + distance to ground-plane (x, z) in meters
    const x = Math.sin(headingRad) * groundDistance;
    const z = -Math.cos(headingRad) * groundDistance;

    // Place on the ground plane with manual height offset
    const cameraHeight = cameraConfig.height ?? NAV_CONSTANTS.DEFAULT_CAMERA_HEIGHT;
    const y = -cameraHeight + overrideHeight;

    const horizontalDistance = groundDistance;

    const projected = projector.metersToScreen(x, y, z, yaw, pitch, fov);

    if (!projected.visible) return null;

    const radius = projector.calculateMarkerSize(
        NAV_CONSTANTS.MARKER_WORLD_RADIUS, horizontalDistance, fov, overrideHeight
    );
    const flattenY = projector.calculateFlattenRatio(horizontalDistance, pitch, overrideHeight);

    return {
        id: target.id,
        screenX: projected.screenX,
        screenY: projected.screenY,
        distance: projected.distance,
        radius,
        flattenY,
        // Calibration-specific metadata
        isNext: target.next,
        hasOverride: true,
        isCalibrationSelected: target.id === state.selectedTargetId,
        isHidden: isTargetHidden(target.id),
        displayName: target.display_name || target.id.slice(0, 8),
    };
}

// ============================================================================
// NEARBY PHOTO PROJECTION
// ============================================================================

/**
 * Projects a nearby (unconnected) photo to screen coordinates.
 * Rendered as smaller grey markers to distinguish from navigation targets.
 */
function projectNearbyPhoto(photo, yaw, pitch, fov) {
    if (!cameraConfig) return null;

    let { x, z } = projector.lonLatToMeters(
        photo.lon, photo.lat,
        cameraConfig.lon, cameraConfig.lat
    );
    const distanceScale = cameraConfig.distance_scale ?? 1.0;
    x *= distanceScale;
    z *= distanceScale;

    const cameraHeight = cameraConfig.height ?? NAV_CONSTANTS.DEFAULT_CAMERA_HEIGHT;
    const y = -cameraHeight;

    const horizontalDistance = Math.sqrt(x * x + z * z);

    const projected = projector.metersToScreen(x, y, z, yaw, pitch, fov);
    if (!projected.visible) return null;

    const radius = projector.calculateMarkerSize(
        NAV_CONSTANTS.MARKER_WORLD_RADIUS, horizontalDistance, fov
    );
    const flattenY = projector.calculateFlattenRatio(horizontalDistance, pitch);

    return {
        id: photo.id,
        screenX: projected.screenX,
        screenY: projected.screenY,
        distance: projected.distance,
        radius,
        flattenY,
        type: 'nearby',
        displayName: photo.displayName || photo.id.slice(0, 8),
        data: photo,
    };
}

// ============================================================================
// GROUND GRID PROJECTION
// ============================================================================

/** Ground grid radial distances in meters */
const GROUND_GRID_RINGS = [2, 5, 8, 10, 15, 20, 25, 30, 40, 50, 60, 75, 100, 130, 170, 200, 250, 300];
/** Ground grid radial bearing lines every 10 degrees */
const GROUND_GRID_BEARINGS = Array.from({ length: 36 }, (_, i) => i * 10);

/**
 * Projects a ground-plane grid onto screen coordinates.
 * Ring lines at fixed distances + radial bearing lines.
 * Respects camera_height and distance_scale via projector.metersToScreen().
 *
 * @param {number} yaw - Camera yaw in radians
 * @param {number} pitch - Camera pitch in radians
 * @param {number} fov - Camera FOV in degrees
 * @returns {{ lines: Array<{points: Array<{x:number,y:number}>, highlight: boolean}> }}
 */
function projectGroundGrid(yaw, pitch, fov) {
    const cameraHeight = cameraConfig.height ?? NAV_CONSTANTS.DEFAULT_CAMERA_HEIGHT;
    const distanceScale = cameraConfig.distance_scale ?? 1.0;
    const groundY = -cameraHeight;
    const lines = [];

    // Ring lines (circles at fixed distances on ground plane)
    for (const rawDist of GROUND_GRID_RINGS) {
        const dist = rawDist * distanceScale;
        const points = [];
        const segments = 72;
        for (let i = 0; i <= segments; i++) {
            const angle = (i / segments) * Math.PI * 2;
            const x = Math.sin(angle) * dist;
            const z = -Math.cos(angle) * dist;
            const projected = projector.metersToScreen(x, groundY, z, yaw, pitch, fov);
            if (projected.visible) {
                points.push({ x: projected.screenX, y: projected.screenY });
            } else if (points.length > 0) {
                if (points.length >= 2) {
                    lines.push({ points: [...points], highlight: false });
                }
                points.length = 0;
            }
        }
        if (points.length >= 2) {
            lines.push({ points, highlight: false });
        }
    }

    // Radial bearing lines (straight lines from camera outward)
    const maxDist = GROUND_GRID_RINGS[GROUND_GRID_RINGS.length - 1] * distanceScale;
    for (const bearingDeg of GROUND_GRID_BEARINGS) {
        const bearingRad = (bearingDeg * Math.PI) / 180;
        const sinB = Math.sin(bearingRad);
        const cosB = -Math.cos(bearingRad);
        const points = [];
        const segments = 40;
        for (let i = 1; i <= segments; i++) {
            const d = (i / segments) * maxDist;
            const x = sinB * d;
            const z = cosB * d;
            const projected = projector.metersToScreen(x, groundY, z, yaw, pitch, fov);
            if (projected.visible) {
                points.push({ x: projected.screenX, y: projected.screenY });
            } else if (points.length > 0) {
                if (points.length >= 2) {
                    lines.push({ points: [...points], highlight: bearingDeg % 90 === 0 });
                }
                points.length = 0;
            }
        }
        if (points.length >= 2) {
            lines.push({ points, highlight: bearingDeg % 90 === 0 });
        }
    }

    return { lines };
}

// ============================================================================
// NEAREST-TO-CURSOR  (verbatim EBGeo findNearestTargetToCursor)
// ============================================================================

/**
 * Finds the nearest navigation target to the cursor position on the ground.
 */
function findNearestTargetToCursor(cursorGround) {
    if (!targets.length || !cameraConfig) return null;

    let nearestTarget = null;
    let nearestDist = Infinity;

    for (const target of targets) {
        if (isTargetHidden(target.id)) continue;
        const { x: targetX, z: targetZ } = projector.lonLatToMeters(
            target.lon, target.lat,
            cameraConfig.lon, cameraConfig.lat
        );

        const dx = targetX - cursorGround.x;
        const dz = targetZ - cursorGround.z;
        const dist = Math.sqrt(dx * dx + dz * dz);

        if (dist < nearestDist) {
            nearestDist = dist;
            nearestTarget = target;
        }
    }

    return nearestTarget;
}

// ============================================================================
// CLICK HANDLING
// ============================================================================

/**
 * Handles click on the viewer. Called by the viewer's click callback.
 * Note: viewer.js onPointerUp already converts to canvas-relative coords,
 * so event.clientX/clientY are already relative to the canvas.
 * @param {{ clientX: number, clientY: number }} event - Canvas-relative click coordinates
 */
export function handleClick(event) {
    if (!overlayCanvas) return;

    // event.clientX/clientY are already canvas-relative (viewer.js subtracts rect)
    const canvasX = event.clientX;
    const canvasY = event.clientY;

    // "Set from click" mode: capture ground-plane coordinates
    if (state.setFromClickMode && state.selectedTargetId) {
        if (onSetFromClickCallback && projector) {
            const ground = projector.screenToGround(
                canvasX, canvasY,
                currentYaw, currentPitch, currentFov
            );
            if (ground) {
                // Convert ground (x, z) to bearing and distance from camera
                const bearing = Math.atan2(ground.x, -ground.z);
                let bearingDeg = (bearing * 180) / Math.PI;
                if (bearingDeg < 0) bearingDeg += 360;
                const distance = Math.sqrt(ground.x * ground.x + ground.z * ground.z);
                onSetFromClickCallback({ bearing: bearingDeg, distance });
            }
        }
        return;
    }

    // Normal mode: check if a marker was clicked
    const hitMarker = hitTester.testPoint(canvasX, canvasY);
    if (hitMarker) {
        // Check if it's a nearby photo marker
        if (hitMarker.type === 'nearby' && nearbyPreviewEnabled && onNearbyClickCallback) {
            onNearbyClickCallback(hitMarker.data);
            return;
        }
        // Regular navigation target
        if (hitMarker.type === 'navigation' && onTargetSelectCallback) {
            onTargetSelectCallback(hitMarker.id);
        }
    }
}

// ============================================================================
// MOUSE TRACKING
// ============================================================================

function onMouseMove(e) {
    const rect = overlayCanvas?.getBoundingClientRect();
    if (!rect) return;
    mouseX = e.clientX - rect.left;
    mouseY = e.clientY - rect.top;
}

function refreshCursorStyle() {
    if (!overlayCanvas) return;
    const container = overlayCanvas.parentElement;
    if (!container) return;

    if (state.setFromClickMode) {
        container.style.cursor = 'crosshair';
    } else if (hoveredId) {
        container.style.cursor = 'pointer';
    } else {
        container.style.cursor = 'grab';
    }
}

// ============================================================================
// PUBLIC UTILITIES
// ============================================================================

/**
 * Stores the latest camera state for use in click handling.
 * Converts raw viewer yaw (lon in radians) to world-heading-based yaw
 * so that screenToSpherical returns headings relative to north.
 * @param {{ yaw: number, pitch: number, fov: number }} cameraState
 */
export function updateCameraState(cameraState) {
    const lonDeg = (cameraState.yaw * 180) / Math.PI;
    const imageHeading = cameraConfig?.heading ?? 0;
    const worldHeadingDeg = imageHeading + lonDeg;
    const correctedYaw = -(worldHeadingDeg * Math.PI) / 180;
    currentYaw = correctedYaw;
    currentPitch = cameraState.pitch;
    currentFov = cameraState.fov;
}

/**
 * Gets the projected markers for external use (e.g., minimap).
 * @returns {Array}
 */
export function getProjectedMarkers() {
    return navRenderer?.markers ?? [];
}

/**
 * Gets the overlay canvas.
 * @returns {HTMLCanvasElement}
 */
export function getOverlayCanvas() {
    return overlayCanvas;
}

/**
 * Shows or hides the ground-plane grid overlay.
 * @param {boolean} visible - Whether to show the ground grid
 */
export function setGroundGridVisible(visible) {
    groundGridVisible = visible;
    if (!visible && navRenderer) {
        navRenderer.setGroundGrid(null);
    }
}

/**
 * Updates the cursor style based on current mode.
 */
export function refreshCursor() {
    refreshCursorStyle();
}

/**
 * Disposes of the navigator.
 */
export function disposeNavigator() {
    if (overlayCanvas?.parentElement) {
        overlayCanvas.parentElement.removeEventListener('mousemove', onMouseMove);
    }
    projector = null;
    navRenderer?.dispose();
    navRenderer = null;
    hitTester = null;
    overlayCanvas = null;
    targets = [];
    nearbyPhotos = [];
    nearbyPreviewEnabled = false;
    onNearbyClickCallback = null;
    nearestTargetId = null;
    cursorNearestTargetId = null;
}
