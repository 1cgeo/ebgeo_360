/**
 * @fileoverview Coordinate projection utilities for Street View 360 navigation.
 * Handles conversions between geographic, 3D world, and screen coordinates.
 * Port of EBGeo StreetViewProjector with haversine replacing Turf.js.
 */

import { NAV_CONSTANTS } from './constants.js';

/**
 * Projects geographic and 3D coordinates to screen space for the 360 viewer.
 */
export class StreetViewProjector {
    /**
     * @param {number} canvasWidth - Canvas width in pixels
     * @param {number} canvasHeight - Canvas height in pixels
     */
    constructor(canvasWidth, canvasHeight) {
        this.canvasWidth = canvasWidth;
        this.canvasHeight = canvasHeight;
        this.cameraConfig = null;

        // Invariantes pre-computadas por frame (validas apenas apos beginFrame()).
        // Evitam recalcular tan(fov/2)/aspect/sin/cos por marcador a cada chamada.
        this._frame = null;
        // Resultado reutilizavel de metersToScreen (evita alocacao por chamada).
        this._screenResult = { screenX: 0, screenY: 0, distance: 0, visible: false };
    }

    /**
     * Pre-computa as invariantes trigonometricas do frame atual (yaw/pitch/fov).
     * Deve ser chamado uma vez por frame antes das chamadas a metersToScreen().
     * As chamadas continuam recebendo yaw/pitch/fov e usam o cache apenas quando
     * os valores coincidem, preservando 100% do comportamento numerico.
     * @param {number} yaw - Camera yaw rotation in radians
     * @param {number} pitch - Camera pitch rotation in radians
     * @param {number} fov - Camera field of view in degrees
     */
    beginFrame(yaw, pitch, fov) {
        const fovRad = (fov * Math.PI) / 180;
        this._frame = {
            yaw,
            pitch,
            fov,
            cosYaw: Math.cos(yaw),
            sinYaw: Math.sin(yaw),
            cosPitch: Math.cos(-pitch),
            sinPitch: Math.sin(-pitch),
            aspectRatio: this.canvasWidth / this.canvasHeight,
            tanHalfFov: Math.tan(fovRad / 2),
        };
    }

    /**
     * Updates the projector dimensions
     * @param {number} width - New canvas width
     * @param {number} height - New canvas height
     */
    resize(width, height) {
        this.canvasWidth = width;
        this.canvasHeight = height;
    }

    /**
     * Sets the camera configuration for projections
     * @param {Object} cameraConfig - Camera metadata from JSON
     */
    setCameraConfig(cameraConfig) {
        this.cameraConfig = cameraConfig;
    }

    /**
     * Converts geographic coordinates to meters relative to camera position.
     * Uses haversine-based flat-earth approximation (replaces Turf.js).
     * @param {number} lon - Target longitude
     * @param {number} lat - Target latitude
     * @param {number} cameraLon - Camera longitude
     * @param {number} cameraLat - Camera latitude
     * @returns {{x: number, z: number}} Position in meters (x = east, z = south)
     */
    lonLatToMeters(lon, lat, cameraLon, cameraLat) {
        const R = 6371000;
        const dLon = (lon - cameraLon) * Math.PI / 180;
        const midLat = cameraLat * Math.PI / 180;
        const dLat = (lat - cameraLat) * Math.PI / 180;
        const x = dLon * R * Math.cos(midLat);
        const z = -dLat * R;
        return { x, z };
    }

    /**
     * Projects a 3D point to screen coordinates
     * @param {number} x - X position in meters
     * @param {number} y - Y position in meters (vertical)
     * @param {number} z - Z position in meters
     * @param {number} yaw - Camera yaw rotation in radians
     * @param {number} pitch - Camera pitch rotation in radians
     * @param {number} fov - Camera field of view in degrees
     * @returns {{screenX: number, screenY: number, distance: number, visible: boolean}}
     */
    metersToScreen(x, y, z, yaw, pitch, fov) {
        // Reutiliza invariantes pre-computadas em beginFrame() quando o frame
        // coincide (yaw/pitch/fov identicos); caso contrario calcula localmente.
        // O resultado numerico e identico em ambos os caminhos.
        const f = this._frame;
        const useFrame = f !== null && f.yaw === yaw && f.pitch === pitch && f.fov === fov;

        const cosYaw = useFrame ? f.cosYaw : Math.cos(yaw);
        const sinYaw = useFrame ? f.sinYaw : Math.sin(yaw);
        const cosPitch = useFrame ? f.cosPitch : Math.cos(-pitch);
        const sinPitch = useFrame ? f.sinPitch : Math.sin(-pitch);
        const aspectRatio = useFrame ? f.aspectRatio : this.canvasWidth / this.canvasHeight;
        const tanHalfFov = useFrame ? f.tanHalfFov : Math.tan(((fov * Math.PI) / 180) / 2);

        const out = this._screenResult;

        // Apply camera rotation (yaw) - rotate world into camera space
        const rotatedX = x * cosYaw - z * sinYaw;
        const rotatedZ = x * sinYaw + z * cosYaw;

        // Check if point is behind camera (in camera space, forward is -Z)
        if (rotatedZ >= 0) {
            out.screenX = 0; out.screenY = 0; out.distance = 0; out.visible = false;
            return out;
        }

        // Calculate distance from camera
        const distance = Math.sqrt(x * x + y * y + z * z);

        // Apply pitch rotation - rotate around X axis
        const rotatedY = y * cosPitch - rotatedZ * sinPitch;
        const finalZ = y * sinPitch + rotatedZ * cosPitch;

        // Project to normalized device coordinates
        const ndcX = rotatedX / (-finalZ * tanHalfFov * aspectRatio);
        const ndcY = rotatedY / (-finalZ * tanHalfFov);

        // Check if point is within FOV
        const margin = NAV_CONSTANTS.FOV_MARGIN / fov;
        if (Math.abs(ndcX) > 1 + margin || Math.abs(ndcY) > 1 + margin) {
            out.screenX = 0; out.screenY = 0; out.distance = distance; out.visible = false;
            return out;
        }

        // Convert to screen coordinates
        out.screenX = (ndcX + 1) * 0.5 * this.canvasWidth;
        out.screenY = (1 - ndcY) * 0.5 * this.canvasHeight;
        out.distance = distance;
        out.visible = true;
        return out;
    }

        /**
     * How much a target shrinks for being the Nth in its direction.
     * A constant fraction per rank, so the decay is relative: the second icon is
     * always the same fraction of the first, whether the corridor is 3 m or 300.
     *
     * @param {number} rank - 0 for the first target in a direction
     * @returns {number} Multiplier in (0, 1]
     */
    rankRatio(rank) {
        return Math.pow(NAV_CONSTANTS.HORIZON_RANK_DECAY, Math.max(0, rank));
    }

    /**
     * The rank actually used for size and height: the position in the queue of a
     * direction, nudged by where the target sits in the distance ORDER of the
     * whole photo.
     *
     * Fractional on purpose. The queue position alone would draw a lone target
     * 80 m away exactly like a lone target 3 m away, and the operator would lose
     * every cue of depth. The nudge is bounded by HORIZON_DISTANCE_RANK_WEIGHT,
     * so the farthest target of the photo is at most that fraction of one rank
     * smaller and higher than its queue position asks for.
     *
     * @param {number} queueRank - Position along the direction, 0 = first
     * @param {number} distanceRatio - Place in the photo's distance order, 0 = nearest, 1 = farthest
     * @returns {number} Effective rank, possibly fractional
     */
    effectiveRank(queueRank, distanceRatio) {
        return queueRank
            + NAV_CONSTANTS.HORIZON_DISTANCE_RANK_WEIGHT * Math.min(1, Math.max(0, distanceRatio));
    }

    /**
     * Projects the point on the CAMERA HORIZON that lies at a given bearing.
     *
     * This is the only geometry the marker needs from the world: a direction.
     * Distance never reaches the screen; it only decides the order along the
     * direction, and the layout above the horizon is computed from the icons'
     * own sizes. Camera height, terrain, distance_scale and the old per-target
     * overrides are not merely unused, they are gone.
     *
     * The horizon here is the CORRECTED one: the sphere is levelled by
     * mesh_rotation_x/z before anything is drawn, so the camera's horizontal
     * plane is the image's true horizon.
     *
     * @param {number} bearingDeg - World bearing of the target (0 = North, 90 = East)
     * @param {number} yaw - Camera yaw in radians
     * @param {number} pitch - Camera pitch in radians
     * @param {number} fov - Camera vertical FOV in degrees
     * @returns {{screenX: number, screenY: number, visible: boolean, azimuthRelDeg: number}}
     */
    projectOnHorizon(bearingDeg, yaw, pitch, fov, elevationDeg = 0) {
        // A point at an arbitrary radius: only the angles matter, the
        // perspective divide cancels the radius out.
        const R = 10;
        const bearingRad = (bearingDeg * Math.PI) / 180;
        // metersToScreen returns a REUSED object here, so read it immediately.
        const projected = this.metersToScreen(
            Math.sin(bearingRad) * R,
            R * Math.tan((elevationDeg * Math.PI) / 180),
            -Math.cos(bearingRad) * R,
            yaw, pitch, fov
        );

        const yawDeg = -(yaw * 180) / Math.PI;
        const azimuthRelDeg = ((bearingDeg - yawDeg + 540) % 360) - 180;

        return {
            screenX: projected.screenX,
            screenY: projected.screenY,
            visible: projected.visible,
            azimuthRelDeg
        };
    }

    /**
     * Marker radius in pixels: a fixed angular size for the first target in a
     * direction, shrinking by a constant fraction for each one behind it.
     *
     * Kept angular rather than in pixels so zooming into the photograph grows
     * the icons along with the scene.
     *
     * @param {number} rank - Position in the queue along this direction, 0 = first
     * @param {number} fov - Camera vertical FOV in degrees
     * @returns {number} Radius in pixels
     */
    angularMarkerRadius(rank, fov) {
        const radius = this.focalLength(fov)
            * Math.tan((this.angularRadiusDeg(rank) * Math.PI) / 180);

        const max = this.canvasHeight * NAV_CONSTANTS.HORIZON_MAX_SIZE_REL;
        return Math.min(max, radius);
    }

    /**
     * Angular radius of the icon at a given rank, in degrees.
     *
     * NOT floored: flooring it would break the guarantee that every centre falls
     * outside the disc in front, because the gap keeps shrinking while a floored
     * radius would not. A queue ends by not being drawn (see angularRadiusDeg
     * against HORIZON_MIN_ANGULAR_DRAW), never by being clamped.
     *
     * @param {number} rank - 0 for the first target in a direction
     * @returns {number} Angular radius in degrees
     */
    angularRadiusDeg(rank) {
        return NAV_CONSTANTS.HORIZON_ANGULAR_NEAR * this.rankRatio(rank);
    }

    /**
     * Height of the icon at a given rank, in degrees above the corrected horizon.
     * Negative means below it, which is where the first icon of a queue sits.
     *
     * Approaches HORIZON_CEILING_ELEVATION_DEG asymptotically, so no queue, of
     * any length, ever climbs past the ceiling.
     *
     * @param {number} rank - 0 for the first target in a direction
     * @returns {number} Elevation in degrees (positive = above the horizon)
     */
    elevationDeg(rank) {
        const base = NAV_CONSTANTS.HORIZON_BASE_DEPRESSION_DEG;
        const ceiling = NAV_CONSTANTS.HORIZON_CEILING_ELEVATION_DEG;
        const band = base + ceiling;

        // O teto e limite, nao aproximacao: sem este clamp o arredondamento de
        // ponto flutuante deixa a fila profunda alguns milionesimos de grau
        // acima dele.
        return Math.min(ceiling, -base + band * (1 - this.rankRatio(rank)));
    }

    /**
     * Calculates the focal length for the current canvas and FOV.
     * @param {number} fov - Field of view in degrees
     * @returns {number} Focal length in pixels
     */
    focalLength(fov) {
        const fovRad = (fov * Math.PI) / 180;
        return (this.canvasHeight / 2) / Math.tan(fovRad / 2);
    }

}
