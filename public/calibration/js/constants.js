/**
 * @fileoverview Navigation constants for the Street View 360 calibration interface.
 * Port of the EBGeo navigation constants with values relevant to calibration.
 */

export const NAV_CONSTANTS = Object.freeze({
    DEFAULT_CAMERA_HEIGHT: 2.5,
    MARKER_WORLD_RADIUS: 1.8,
    MARKER_MIN_SIZE: 8,
    MARKER_MAX_SIZE: 120,
    HOVER_SCALE: 1,
    MARKER_COLOR: 'rgba(255, 255, 255, 0.85)',
    MARKER_BORDER_COLOR: 'rgba(0, 0, 0, 0.4)',
    MARKER_BORDER_WIDTH: 3,
    CURSOR_COLOR: 'rgba(255, 255, 255, 0.8)',
    CURSOR_WORLD_RADIUS: 2.5,
    CURSOR_MIN_SIZE: 12,
    CURSOR_MAX_SIZE: 180,
    HIT_RADIUS_MULTIPLIER: 1.0,
    FOV_MARGIN: 5,
    HIDE_ARROWS_FOV: 35,
    SCALE_ARROWS_FOV: 45,
    HOVER_ANIMATION_DURATION: 150,
});
