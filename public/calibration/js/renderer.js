/**
 * @fileoverview Canvas 2D renderer for Street View 360 calibration navigation elements.
 *
 * All rendering code (renderNavigationMarker, renderGroundCursor, renderCursorArrow)
 * is taken verbatim from EBGeo's StreetViewRenderer.  The only addition is the
 * orange calibration-selection highlight used when a target is selected for editing.
 */

import { NAV_CONSTANTS } from './constants.js';

/**
 * Renders navigation elements on a Canvas 2D overlay.
 */
export class StreetViewRenderer {
    /**
     * @param {HTMLCanvasElement} canvas - The canvas element to render on
     */
    constructor(canvas) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');

        // State
        this.markers = [];
        this.nearestMarkerId = null;
        this.cursorNearestMarkerId = null; // Dynamically calculated based on cursor position
        this.hoveredMarkerId = null;
        this.selectedMarkerId = null;
        this.visible = true;

        // Ground cursor state
        this.groundCursor = null; // { screenX, screenY, flattenY, arrowAngle }

        // Nearby markers state
        this.nearbyMarkers = [];

        // Ground grid state
        this.groundGrid = null; // { lines: Array<{points: Array<{x,y}>}>, color, opacity }

        // Ghost marker state (set-from-click preview)
        this.ghostMarker = null; // { screenX, screenY, radius, flattenY, bearing, distance }

        // Animation state
        this.hoverAnimation = new Map();
    }

    /**
     * Sets the markers to render
     * @param {Array} markers - Array of marker objects with screen positions
     */
    setMarkers(markers) {
        this.markers = markers;
    }

    /**
     * Sets the nearest navigation marker (will be highlighted)
     * @param {string|null} id - Marker ID or null
     */
    setNearestMarker(id) {
        this.nearestMarkerId = id;
    }

    /**
     * Sets the nearest marker based on cursor position (dynamically calculated)
     * @param {string|null} id - Marker ID or null
     */
    setCursorNearestMarker(id) {
        this.cursorNearestMarkerId = id;
    }

    /**
     * Sets the currently hovered marker
     * @param {string|null} id - Marker ID or null
     */
    setHoveredMarker(id) {
        this.hoveredMarkerId = id;
    }

    /**
     * Sets the currently selected marker
     * @param {string|null} id - Marker ID or null
     */
    setSelectedMarker(id) {
        this.selectedMarkerId = id;
    }

    /**
     * Sets the ground cursor position and direction
     * @param {Object|null} cursor - Cursor data { screenX, screenY, flattenY, arrowAngle } or null to hide
     */
    setGroundCursor(cursor) {
        this.groundCursor = cursor;
    }

    /**
     * Sets the ground grid lines to render.
     * @param {Object|null} grid - Grid data or null to hide
     * @param {Array<{points: Array<{x: number, y: number}>, highlight: boolean}>} grid.lines - Projected line segments
     */
    setGroundGrid(grid) {
        this.groundGrid = grid;
    }

    /**
     * Sets the nearby photo markers to render (grey, smaller).
     * @param {Array} markers - Array of nearby marker objects
     */
    setNearbyMarkers(markers) {
        this.nearbyMarkers = markers || [];
    }

    /**
     * Sets the ghost marker for set-from-click preview.
     * @param {Object|null} data - Ghost marker data or null to hide
     */
    setGhostMarker(data) {
        this.ghostMarker = data;
    }

    /**
     * Sets visibility of the overlay
     * @param {boolean} visible - Whether to show the overlay
     */
    setVisible(visible) {
        this.visible = visible;
        if (!visible) {
            this.clear();
        }
    }

    /**
     * Clears the canvas
     */
    clear() {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }

    /**
     * Resizes the canvas
     * @param {number} width - New width
     * @param {number} height - New height
     */
    resize(width, height) {
        this.canvas.width = width;
        this.canvas.height = height;
    }

    // ====================================================================
    // RENDER LOOP  (EBGeo pattern)
    // ====================================================================

    /**
     * Renders a single frame
     */
    render() {
        if (!this.visible) {
            return;
        }

        this.clear();

        // Render ground grid behind markers
        if (this.groundGrid) {
            this.renderGroundGrid();
        }

        // Render nearby photo markers (behind regular markers)
        if (this.nearbyMarkers.length > 0) {
            const sortedNearby = [...this.nearbyMarkers].sort((a, b) => b.distance - a.distance);
            for (const marker of sortedNearby) {
                this.renderNearbyMarker(marker);
            }
        }

        // Sort markers by distance (far to near for proper overlap)
        const sortedMarkers = [...this.markers].sort((a, b) => b.distance - a.distance);

        // Render markers
        for (const marker of sortedMarkers) {
            this.renderMarker(marker);
        }

        // Render ghost marker for set-from-click preview
        if (this.ghostMarker) {
            this.renderGhostMarker();
        }

        // Render ground cursor on top
        if (this.groundCursor) {
            this.renderGroundCursor();
        }
    }

    // ====================================================================
    // MARKER RENDERING  (EBGeo renderMarker + renderNavigationMarker)
    // ====================================================================

    /**
     * Renders a navigation marker.
     * Matches EBGeo renderMarker exactly, plus calibration-selection highlight.
     * @param {Object} marker - Marker data
     */
    renderMarker(marker) {
        const { id, screenX, screenY, radius, flattenY } = marker;

        // Draw original GPS position indicator for override markers
        if (marker.hasOverride && marker.originalScreenX != null) {
            this.renderOriginalPositionIndicator(marker);
        }

        const isHovered = this.hoveredMarkerId === id;
        const isNearest = this.nearestMarkerId === id;
        const isCursorNearest = this.cursorNearestMarkerId === id;
        const isCalibrationSelected = marker.isCalibrationSelected === true;
        const isHidden = marker.isHidden === true;

        // Calculate animation scale
        const targetScale = isHovered ? NAV_CONSTANTS.HOVER_SCALE : 1;
        const currentScale = this.getAnimatedScale(id, targetScale);

        const ctx = this.ctx;
        ctx.save();
        ctx.translate(screenX, screenY);

        // Apply scale
        const finalRadius = radius * currentScale;

        this.renderNavigationMarker(ctx, finalRadius, flattenY, isHovered, isNearest, isCursorNearest, isCalibrationSelected, isHidden);

        ctx.restore();
    }

    /**
     * Renders a navigation marker (Google Street View style - circle with inner dot).
     * Logic is verbatim EBGeo; the only addition is the orange calibration highlight.
     *
     * @param {CanvasRenderingContext2D} ctx - Canvas context
     * @param {number} radius - Marker radius
     * @param {number} flattenY - Y-axis flatten ratio (perspective-based)
     * @param {boolean} isHovered - Whether marker is hovered
     * @param {boolean} isNearest - Whether this is the nearest marker to camera
     * @param {boolean} isCursorNearest - Whether this is the nearest marker to cursor position
     * @param {boolean} isCalibrationSelected - Whether this marker is selected for calibration
     */
    renderNavigationMarker(ctx, radius, flattenY, isHovered, isNearest, isCursorNearest, isCalibrationSelected, isHidden) {
        // Apply perspective scaling (ellipse on ground plane)
        ctx.save();
        ctx.scale(1, flattenY);

        // Hidden markers: render at reduced opacity
        if (isHidden) {
            ctx.globalAlpha = 0.35;
        }

        // Determine style based on state
        // isCursorNearest takes priority - it's the one the user will navigate to on click
        const isHighlighted = isHovered || isCursorNearest;

        // Shadow below marker
        ctx.beginPath();
        ctx.arc(0, 4 / flattenY, radius * 1.1, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
        ctx.fill();

        // ── Calibration-only: orange glow for selected target ──
        if (isCalibrationSelected) {
            ctx.beginPath();
            ctx.arc(0, 0, radius * 1.4, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(250, 179, 135, 0.35)';
            ctx.fill();

            ctx.beginPath();
            ctx.arc(0, 0, radius * 1.2, 0, Math.PI * 2);
            ctx.strokeStyle = 'rgba(250, 179, 135, 0.8)';
            ctx.lineWidth = 3;
            ctx.stroke();
        }

        // Draw glow effect for cursor nearest marker (EBGeo)
        if (isCursorNearest && !isHovered && !isCalibrationSelected) {
            ctx.beginPath();
            ctx.arc(0, 0, radius * 1.3, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(59, 130, 246, 0.25)';
            ctx.fill();
        }

        // Outer circle - fill (white background)
        ctx.beginPath();
        ctx.arc(0, 0, radius, 0, Math.PI * 2);
        ctx.fillStyle = isHighlighted
            ? 'rgba(255, 255, 255, 0.95)'
            : 'rgba(255, 255, 255, 0.7)';
        ctx.fill();

        // Outer circle - border
        if (isCalibrationSelected) {
            ctx.strokeStyle = 'rgba(250, 179, 135, 0.95)';
            ctx.lineWidth = 3;
        } else if (isHighlighted) {
            ctx.strokeStyle = 'rgba(59, 130, 246, 0.9)'; // Blue border when highlighted
            ctx.lineWidth = 3;
        } else {
            ctx.strokeStyle = 'rgba(0, 0, 0, 0.4)';
            ctx.lineWidth = 2;
        }
        ctx.stroke();

        // Inner circle (dot) - key Google Street View style element
        const innerRadius = radius * 0.45;
        ctx.beginPath();
        ctx.arc(0, 0, innerRadius, 0, Math.PI * 2);
        if (isCalibrationSelected) {
            ctx.fillStyle = 'rgba(250, 179, 135, 0.95)';
        } else if (isHighlighted) {
            ctx.fillStyle = 'rgba(59, 130, 246, 0.95)'; // Blue when highlighted
        } else {
            ctx.fillStyle = 'rgba(100, 100, 100, 0.5)'; // Gray when not
        }
        ctx.fill();

        // Hidden markers: draw red X over the marker
        if (isHidden) {
            ctx.globalAlpha = 1.0;
            const xSize = radius * 0.5;
            ctx.beginPath();
            ctx.moveTo(-xSize, -xSize);
            ctx.lineTo(xSize, xSize);
            ctx.moveTo(xSize, -xSize);
            ctx.lineTo(-xSize, xSize);
            ctx.strokeStyle = 'rgba(239, 68, 68, 0.9)';
            ctx.lineWidth = Math.max(2, radius * 0.12);
            ctx.lineCap = 'round';
            ctx.stroke();
        }

        ctx.restore();
    }

    // ====================================================================
    // ORIGINAL POSITION INDICATOR  (override visual feedback)
    // ====================================================================

    /**
     * Renders the original GPS position as a ghost marker with a dashed
     * line connecting it to the override position.
     * @param {Object} marker - Marker data with originalScreenX/Y fields
     */
    renderOriginalPositionIndicator(marker) {
        const { screenX, screenY, originalScreenX, originalScreenY, originalRadius, originalFlattenY } = marker;
        const ctx = this.ctx;

        ctx.save();

        // Dashed line from original to override position
        ctx.beginPath();
        ctx.setLineDash([6, 4]);
        ctx.moveTo(originalScreenX, originalScreenY);
        ctx.lineTo(screenX, screenY);
        ctx.strokeStyle = 'rgba(255, 200, 80, 0.5)';
        ctx.lineWidth = 1.5;
        ctx.stroke();

        // Ghost marker at original position (outline only)
        ctx.translate(originalScreenX, originalScreenY);
        ctx.scale(1, originalFlattenY);
        ctx.globalAlpha = 0.35;

        ctx.beginPath();
        ctx.arc(0, 0, originalRadius, 0, Math.PI * 2);
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = 'rgba(255, 200, 80, 0.7)';
        ctx.lineWidth = 2;
        ctx.stroke();

        // Small dot at center
        ctx.beginPath();
        ctx.arc(0, 0, originalRadius * 0.25, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255, 200, 80, 0.5)';
        ctx.fill();

        ctx.restore();
    }

    // ====================================================================
    // NEARBY MARKER RENDERING
    // ====================================================================

    /**
     * Renders a nearby (unconnected) photo marker as a grey circle.
     * Smaller and more transparent than navigation markers to visually distinguish.
     * @param {Object} marker - Nearby marker data
     */
    renderNearbyMarker(marker) {
        const { screenX, screenY, radius, flattenY } = marker;

        const ctx = this.ctx;
        ctx.save();
        ctx.translate(screenX, screenY);
        ctx.scale(1, flattenY);

        // Shadow below marker
        ctx.beginPath();
        ctx.arc(0, 3 / flattenY, radius * 1.1, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(0, 0, 0, 0.15)';
        ctx.fill();

        // Outer circle - green fill (Catppuccin green #a6e3a1)
        ctx.beginPath();
        ctx.arc(0, 0, radius, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(166, 227, 161, 0.45)';
        ctx.fill();

        // Outer circle - border
        ctx.strokeStyle = 'rgba(166, 227, 161, 0.6)';
        ctx.lineWidth = 1.5;
        ctx.stroke();

        // Inner dot
        ctx.beginPath();
        ctx.arc(0, 0, radius * 0.35, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(166, 227, 161, 0.5)';
        ctx.fill();

        ctx.restore();
    }

    // ====================================================================
    // GROUND CURSOR  (verbatim EBGeo renderGroundCursor + renderCursorArrow)
    // ====================================================================

    /**
     * Renders the ground cursor that follows the mouse.
     * Large cursor with circle on ground and chevron arrow INSIDE the circle
     * pointing to nearest marker.  Styled like Google Street View navigation cursor.
     */
    renderGroundCursor() {
        const { screenX, screenY, flattenY, arrowAngle, distance, fov } = this.groundCursor;
        const ctx = this.ctx;

        ctx.save();
        ctx.translate(screenX, screenY);

        // Physically-based cursor sizing: worldRadius * focalLength / distance
        const d = Math.max(0.5, distance || 1);
        const fovRad = ((fov || 75) * Math.PI) / 180;
        const focalLength = (this.canvas.height / 2) / Math.tan(fovRad / 2);
        let cursorSize = NAV_CONSTANTS.CURSOR_WORLD_RADIUS * focalLength / d;
        cursorSize = Math.max(NAV_CONSTANTS.CURSOR_MIN_SIZE, Math.min(NAV_CONSTANTS.CURSOR_MAX_SIZE, cursorSize));

        // Draw cursor circle (ellipse with perspective) - Google Street View style
        ctx.save();
        ctx.scale(1, flattenY);

        // Outer shadow
        ctx.beginPath();
        ctx.arc(0, 5 / flattenY, cursorSize * 0.52, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(0, 0, 0, 0.25)';
        ctx.fill();

        // Outer ring with white fill (semi-transparent)
        ctx.beginPath();
        ctx.arc(0, 0, cursorSize * 0.5, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
        ctx.fill();

        // White border ring
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
        ctx.lineWidth = Math.max(3, cursorSize * 0.07);
        ctx.stroke();

        ctx.restore();

        // Draw chevron arrow INSIDE the circle, centered, pointing to nearest marker
        if (arrowAngle !== null && arrowAngle !== undefined) {
            this.renderCursorArrow(ctx, cursorSize, flattenY, arrowAngle);
        }

        ctx.restore();
    }

    /**
     * Renders the arrow on the ground cursor pointing to nearest marker.
     * Large chevron style CENTERED inside the cursor circle.
     * @param {CanvasRenderingContext2D} ctx - Canvas context
     * @param {number} cursorSize - Size of the cursor
     * @param {number} flattenY - Y-axis flatten ratio for perspective
     * @param {number} angle - Rotation angle in radians (0 = pointing up/forward)
     */
    renderCursorArrow(ctx, cursorSize, flattenY, angle) {
        ctx.save();

        // Apply perspective first (same as cursor circle)
        ctx.scale(1, flattenY);

        // Then rotate around center - arrow stays centered and rotates
        ctx.rotate(angle);

        // Chevron dimensions - sized to fit nicely inside the circle
        const chevronWidth = cursorSize * 0.55;
        const chevronHeight = cursorSize * 0.38;
        const strokeWidth = Math.max(4, cursorSize * 0.09);

        // Offset the chevron slightly in the direction it's pointing
        // This creates a visual indication of direction while staying centered
        const offsetAmount = cursorSize * 0.08;
        ctx.translate(0, -offsetAmount);

        // Draw shadow first (behind)
        ctx.beginPath();
        ctx.moveTo(-chevronWidth / 2, chevronHeight / 2);
        ctx.lineTo(0, -chevronHeight / 2);
        ctx.lineTo(chevronWidth / 2, chevronHeight / 2);

        ctx.strokeStyle = 'rgba(0, 0, 0, 0.5)';
        ctx.lineWidth = strokeWidth + 4;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.stroke();

        // Draw main white chevron
        ctx.beginPath();
        ctx.moveTo(-chevronWidth / 2, chevronHeight / 2);
        ctx.lineTo(0, -chevronHeight / 2);
        ctx.lineTo(chevronWidth / 2, chevronHeight / 2);

        ctx.strokeStyle = 'rgba(255, 255, 255, 1)';
        ctx.lineWidth = strokeWidth;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.stroke();

        ctx.restore();
    }

    // ====================================================================
    // GROUND GRID
    // ====================================================================

    /**
     * Renders the ground-plane grid lines projected onto the viewport.
     * Lines are pre-projected by the navigator using metersToScreen().
     * Uses warm yellow tones distinct from the cyan spherical grid.
     */
    renderGroundGrid() {
        const { lines } = this.groundGrid;
        const ctx = this.ctx;

        // Draw grid lines
        for (const line of lines) {
            if (line.points.length < 2) continue;

            ctx.save();
            ctx.beginPath();

            let started = false;
            for (const pt of line.points) {
                if (!started) {
                    ctx.moveTo(pt.x, pt.y);
                    started = true;
                } else {
                    ctx.lineTo(pt.x, pt.y);
                }
            }

            if (line.highlight) {
                ctx.strokeStyle = 'rgba(255, 200, 80, 0.6)';
                ctx.lineWidth = 2;
            } else {
                ctx.strokeStyle = 'rgba(255, 200, 80, 0.3)';
                ctx.lineWidth = 1.5;
            }

            ctx.stroke();
            ctx.restore();
        }
    }

    // ====================================================================
    // GHOST MARKER  (set-from-click preview)
    // ====================================================================

    /**
     * Renders a ghost marker at the mouse position during set-from-click mode.
     * Shows a semi-transparent marker with bearing/distance label.
     */
    renderGhostMarker() {
        const { screenX, screenY, radius, flattenY, bearing, distance } = this.ghostMarker;
        const ctx = this.ctx;

        ctx.save();
        ctx.translate(screenX, screenY);
        ctx.globalAlpha = 0.45;

        // Elliptical perspective
        ctx.save();
        ctx.scale(1, flattenY);

        // Dashed orange circle
        ctx.beginPath();
        ctx.arc(0, 0, radius, 0, Math.PI * 2);
        ctx.setLineDash([6, 4]);
        ctx.strokeStyle = 'rgba(250, 179, 135, 0.9)';
        ctx.lineWidth = 2.5;
        ctx.stroke();

        // Semi-transparent fill
        ctx.beginPath();
        ctx.arc(0, 0, radius, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(250, 179, 135, 0.2)';
        ctx.fill();

        ctx.restore(); // undo scale

        // Label above marker
        ctx.globalAlpha = 0.85;
        const label = `${bearing.toFixed(0)}\u00B0 / ${distance.toFixed(1)}m`;
        ctx.font = '12px monospace';
        const metrics = ctx.measureText(label);
        const labelX = -metrics.width / 2;
        const labelY = -(radius * flattenY) - 10;

        // Label background
        ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
        ctx.fillRect(labelX - 4, labelY - 12, metrics.width + 8, 16);

        // Label text
        ctx.fillStyle = '#fab387';
        ctx.fillText(label, labelX, labelY);

        ctx.restore();
    }

    // ====================================================================
    // ANIMATION  (verbatim EBGeo)
    // ====================================================================

    /**
     * Gets animated scale for hover effect
     * @param {string} id - Marker ID
     * @param {number} targetScale - Target scale
     * @returns {number} Current interpolated scale
     */
    getAnimatedScale(id, targetScale) {
        if (!this.hoverAnimation.has(id)) {
            this.hoverAnimation.set(id, { scale: 1, target: 1 });
        }

        const anim = this.hoverAnimation.get(id);
        anim.target = targetScale;

        // Simple lerp
        const speed = 0.2;
        anim.scale += (anim.target - anim.scale) * speed;

        // Cleanup if at rest
        if (Math.abs(anim.scale - 1) < 0.01 && anim.target === 1) {
            this.hoverAnimation.delete(id);
            return 1;
        }

        return anim.scale;
    }

    /**
     * Disposes of the renderer
     */
    dispose() {
        this.clear();
        this.markers = [];
        this.nearbyMarkers = [];
        this.hoverAnimation.clear();
    }
}
