/**
 * @fileoverview Canvas 2D renderer for Street View 360 calibration navigation elements.
 *
 * All rendering code (renderNavigationMarker, renderGroundCursor, renderCursorArrow)
 * is taken verbatim from EBGeo's StreetViewRenderer.  The only addition is the
 * orange calibration-selection highlight used when a target is selected for editing.
 */

import { NAV_CONSTANTS } from './constants.js';

/**
 * Draws a navigation target as an armillary sphere: rings rather than a solid
 * ball, so it reads as a sphere and as a panorama at once, and being open it
 * sits over the photograph instead of punching a hole in it.
 *
 * Exported and state-driven because three places draw this exact marker: the
 * viewer overlay, the calibration overlay and the calibration rear view. A
 * fourth hand-rolled copy is how they drifted apart in the first place.
 *
 * The ring geometry is real, not decorative: a parallel at height h on a unit
 * sphere has radius sqrt(1 - h^2). Every ring is drawn at every size, so the
 * marker never changes identity as the operator walks towards it.
 *
 * @param {CanvasRenderingContext2D} ctx - Context, already translated to the centre
 * @param {number} radius - Sphere radius in pixels
 * @param {Object} [state] - Visual state
 * @param {boolean} [state.highlighted] - The target a click would take
 * @param {boolean} [state.selected] - Selected for editing (calibration only)
 * @param {boolean} [state.hidden] - Hidden from navigation (calibration only)
 * @param {number} [state.opacity] - Fades markers further down the queue
 */
export function drawArmillarySphere(ctx, radius, state = {}) {
    const { highlighted = false, selected = false, hidden = false, opacity = 1 } = state;
    const r = Math.max(1, radius);
    const TILT = 0.30;

    let ring, fill;
    if (hidden) {
        // Unmistakably off: red, dashed, and struck through. Dimming alone was
        // read as "far away" rather than "disabled".
        ring = 'rgba(255, 138, 138, 0.95)';
        fill = 'rgba(70, 12, 12, 0.42)';
    } else if (selected) {
        ring = 'rgba(255, 240, 214, 0.98)';
        fill = 'rgba(217, 119, 6, 0.42)';
    } else if (highlighted) {
        ring = 'rgba(255, 255, 255, 1)';
        fill = 'rgba(37, 99, 235, 0.62)';
    } else {
        ring = 'rgba(255, 255, 255, 0.95)';
        fill = 'rgba(17, 24, 36, 0.26)';
    }

    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, opacity));

    // Halo, only when highlighted: the cue that says "this is the one a click
    // takes you to" has to survive a busy photograph.
    if (highlighted && !hidden) {
        ctx.beginPath();
        ctx.arc(0, 0, r * 1.45, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(59, 130, 246, 0.28)';
        ctx.fill();

        ctx.beginPath();
        ctx.arc(0, 0, r * 1.28, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(147, 197, 253, 0.85)';
        ctx.lineWidth = Math.max(1, r * 0.09);
        ctx.stroke();
    }

    ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
    ctx.shadowBlur = Math.max(1.5, r * 0.3);

    // Body: translucent, just enough to separate from the scene
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();

    ctx.strokeStyle = ring;
    ctx.lineCap = 'round';
    if (hidden) {
        ctx.setLineDash([Math.max(2, r * 0.28), Math.max(2, r * 0.2)]);
    }

    // Outer ring
    ctx.lineWidth = Math.max(1, r * (highlighted ? 0.12 : 0.09));
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.stroke();

    // Equator
    ctx.lineWidth = Math.max(0.8, r * (highlighted ? 0.09 : 0.07));
    ctx.beginPath();
    ctx.ellipse(0, 0, r, r * TILT, 0, 0, Math.PI * 2);
    ctx.stroke();

    // Two parallels, each at the true radius for its height
    for (const h of [-0.55, 0.55]) {
        const rx = r * Math.sqrt(1 - h * h);
        ctx.beginPath();
        ctx.ellipse(0, r * h * (1 - TILT * 0.5), rx, rx * TILT, 0, 0, Math.PI * 2);
        ctx.stroke();
    }

    // Meridian through the poles
    ctx.beginPath();
    ctx.ellipse(0, 0, r * 0.34, r, 0, 0, Math.PI * 2);
    ctx.stroke();

    // The tilted band, what makes it read as armillary rather than wireframe
    ctx.beginPath();
    ctx.ellipse(0, 0, r * 0.97, r * 0.24, -0.42, 0, Math.PI * 2);
    ctx.stroke();

    ctx.setLineDash([]);

    // Strike-through for a disabled target
    if (hidden) {
        const d = r * 0.78;
        ctx.beginPath();
        ctx.moveTo(-d, d);
        ctx.lineTo(d, -d);
        ctx.strokeStyle = 'rgba(255, 90, 90, 0.95)';
        ctx.lineWidth = Math.max(1.5, r * 0.16);
        ctx.stroke();
    }

    ctx.restore();
}

/**
 * Opacity for a marker at a given rank in its direction.
 * The one a click would take is never faded: it has to stay the most solid
 * thing on screen no matter how far down the queue it sits.
 *
 * @param {number} rank - Position in the queue, 0 = first
 * @param {boolean} isHighlighted - Whether this is the click target
 * @returns {number} Alpha in [0, 1]
 */
export function rankOpacity(rank, isHighlighted = false) {
    if (isHighlighted) return 1;
    return Math.max(
        NAV_CONSTANTS.HORIZON_RANK_FADE_MIN,
        Math.pow(NAV_CONSTANTS.HORIZON_RANK_FADE, Math.max(0, rank))
    );
}


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


        // Nearby markers state
        this.nearbyMarkers = [];



        // Animation state
        this.hoverAnimation = new Map();

        // Buffers reutilizaveis para ordenacao por frame (evita alocar arrays
        // novos a cada render).
        this._sortedMarkers = [];
        this._sortedNearby = [];
    }

    /**
     * Sets the markers to render
     * @param {Array} markers - Array of marker objects with screen positions
     */
    setMarkers(markers) {
        this.markers = markers;
        this.pruneHoverAnimation();
    }

    /**
     * Remove entradas de animacao de hover de markers que nao existem mais
     * (ex.: ao trocar de foto). Evita crescimento monotonico do Map ao longo
     * da sessao quando um marker estava em meio a animacao na troca.
     */
    pruneHoverAnimation() {
        if (this.hoverAnimation.size === 0) return;
        const present = new Set();
        for (const m of this.markers) present.add(m.id);
        for (const id of this.hoverAnimation.keys()) {
            if (!present.has(id)) {
                this.hoverAnimation.delete(id);
            }
        }
    }

    /**
     * Indica se ha alguma animacao de hover em andamento (escala fora do repouso
     * ou alvo diferente de 1). Usado pelo dirty-check do navigator para continuar
     * renderizando enquanto a animacao nao terminou.
     * @returns {boolean}
     */
    isAnimating() {
        for (const anim of this.hoverAnimation.values()) {
            if (anim.target !== 1 || Math.abs(anim.scale - 1) >= 0.01) {
                return true;
            }
        }
        return false;
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
     * Sets the nearby photo markers to render (grey, smaller).
     * @param {Array} markers - Array of nearby marker objects
     */
    setNearbyMarkers(markers) {
        this.nearbyMarkers = markers || [];
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


        // Render nearby photo markers (behind regular markers)
        if (this.nearbyMarkers.length > 0) {
            // Reaproveita o buffer de ordenacao (copia + sort in-place).
            const sortedNearby = this._sortedNearby;
            sortedNearby.length = 0;
            for (const m of this.nearbyMarkers) sortedNearby.push(m);
            sortedNearby.sort((a, b) => b.distance - a.distance);
            for (const marker of sortedNearby) {
                this.renderNearbyMarker(marker);
            }
        }

        // Sort markers by distance (far to near for proper overlap).
        // Reaproveita o buffer de ordenacao.
        const sortedMarkers = this._sortedMarkers;
        sortedMarkers.length = 0;
        for (const m of this.markers) sortedMarkers.push(m);
        sortedMarkers.sort((a, b) => b.distance - a.distance);

        // Render markers
        for (const marker of sortedMarkers) {
            this.renderMarker(marker);
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
        const { id, screenX, screenY, radius } = marker;

        const isHovered = this.hoveredMarkerId === id;
        const isCursorNearest = this.cursorNearestMarkerId === id;
        const isCalibrationSelected = marker.isCalibrationSelected === true;
        const isHidden = marker.isHidden === true;

        const targetScale = isHovered ? NAV_CONSTANTS.HOVER_SCALE : 1;
        const currentScale = this.getAnimatedScale(id, targetScale);

        const ctx = this.ctx;
        ctx.save();
        ctx.translate(screenX, screenY);

        const finalRadius = radius * currentScale;

        if (marker.offscreen) {
            this.renderEdgeArrow(ctx, finalRadius, marker.offscreenSide, isHovered || isCursorNearest);
        } else {
            drawArmillarySphere(ctx, finalRadius, {
                highlighted: isHovered || isCursorNearest,
                selected: isCalibrationSelected,
                hidden: isHidden,
                opacity: rankOpacity(marker.rank ?? 0, isHovered || isCursorNearest || isCalibrationSelected),
            });
        }

        ctx.restore();
    }

    /**
     * Renders a chevron at the canvas edge for a target that sits outside the
     * horizontal field of view, so the operator knows a way out exists there.
     *
     * @param {CanvasRenderingContext2D} ctx - Canvas context, already translated
     * @param {number} radius - Marker radius in pixels
     * @param {'left'|'right'} side - Which edge the target lies beyond
     * @param {boolean} isHighlighted - Whether to draw it in the highlight colour
     */
    renderEdgeArrow(ctx, radius, side, isHighlighted) {
        const direction = side === 'right' ? 1 : -1;
        const w = radius * 0.8;
        const h = radius * 1.1;

        ctx.save();
        ctx.beginPath();
        ctx.moveTo(-direction * w * 0.4, -h);
        ctx.lineTo(direction * w * 0.6, 0);
        ctx.lineTo(-direction * w * 0.4, h);
        ctx.closePath();

        ctx.fillStyle = isHighlighted
            ? 'rgba(59, 130, 246, 0.9)'
            : 'rgba(255, 255, 255, 0.75)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.45)';
        ctx.lineWidth = 2;
        ctx.stroke();
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
        const { screenX, screenY, radius } = marker;

        const ctx = this.ctx;
        ctx.save();
        ctx.translate(screenX, screenY);

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
