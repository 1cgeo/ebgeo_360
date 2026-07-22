/**
 * @fileoverview Hit testing for Street View 360 navigation markers.
 * Detects mouse hover and click interactions with markers.
 * Exact port of EBGeo StreetViewHitTester.
 */

import { NAV_CONSTANTS } from './constants.js';

/**
 * Tests for interactions with navigation markers.
 */
export class StreetViewHitTester {
    constructor() {
        /** @type {Array} */
        this.markers = [];
    }

    /**
     * Sets the markers available for hit testing
     * @param {Array} markers - Array of marker objects with screen positions
     */
    setMarkers(markers) {
        // Sort by distance (near to far) for proper hit priority.
        // Reaproveita o buffer interno (copia + sort in-place) para evitar
        // alocar um array novo a cada frame.
        const buf = this.markers;
        buf.length = 0;
        for (const m of markers) buf.push(m);
        buf.sort((a, b) => a.distance - b.distance);
    }

    /**
     * Tests if a point hits any marker, and returns the BEST match rather than
     * the first one found.
     *
     * "First that contains the point, nearest first" looks reasonable and is
     * wrong: the click areas are deliberately larger than the drawings, so a
     * near icon's area swallows the centre of the one behind it and that target
     * becomes unreachable. Measured on the museum's first photo, the second icon
     * of the queue sat 46 px from the first, whose click radius is 49.5 px.
     *
     * Comparing distance normalised by each marker's own radius makes every icon
     * own its neighbourhood: on its own centre it always wins.
     *
     * @param {number} screenX - Screen X coordinate
     * @param {number} screenY - Screen Y coordinate
     * @returns {Object|null} The hit marker or null
     */
    testPoint(screenX, screenY) {
        let best = null;
        let bestScore = Infinity;

        for (const marker of this.markers) {
            if (!this.isPointInMarker(screenX, screenY, marker)) continue;

            const hitRadius = marker.hitRadius
                ?? (marker.radius * NAV_CONSTANTS.HIT_RADIUS_MULTIPLIER);
            const dx = screenX - marker.screenX;
            const dy = screenY - marker.screenY;
            const score = Math.hypot(dx, dy) / Math.max(1e-6, hitRadius);

            if (score < bestScore) {
                bestScore = score;
                best = marker;
            }
        }

        return best;
    }

        /**
     * Checks if a point is inside a marker.
     *
     * A plain circle: the flattened ellipse belonged to the ground model, where
     * markers pretended to be discs lying on the floor.
     *
     * @param {number} screenX - Screen X coordinate
     * @param {number} screenY - Screen Y coordinate
     * @param {Object} marker - Marker object
     * @returns {boolean} True if point is inside
     */
    isPointInMarker(screenX, screenY, marker) {
        const { screenX: mx, screenY: my, radius } = marker;

        // O navigator calcula hitRadius quando conhece o tamanho do canvas, que
        // e o que permite o piso relativo; sem ele, cai no multiplicador puro.
        const hitRadius = marker.hitRadius ?? (radius * NAV_CONSTANTS.HIT_RADIUS_MULTIPLIER);
        const dx = screenX - mx;
        const dy = screenY - my;

        return (dx * dx + dy * dy) <= hitRadius * hitRadius;
    }

            }
