/**
 * @fileoverview Navigation constants for the Street View 360 calibration interface.
 * Port of the EBGeo navigation constants with values relevant to calibration.
 */

export const NAV_CONSTANTS = Object.freeze({

    // ===== HORIZON MARKER MODEL =====
    // Must stay numerically identical to ebgeo_web's navigation/constants.js:
    // what is calibrated here has to be exactly what the viewer displays.
    // ===== RELATIVE MARKER MODEL =====
    //
    // Lat/lon is the ONLY input, and only two things are taken from it: which
    // direction a target lies in, and in what order the targets sit along that
    // direction. Nothing else about the position is drawn faithfully.
    //
    // From there the layout is purely relative: the nearest target of each
    // direction gets a fixed size, and the ones behind it shrink and rise. The
    // rise is computed from the icons' own radii, so no icon can bury another
    // and every one stays clickable. This is what removed the six per-photo
    // calibrations the old ground model needed: the archive carries 519 hand
    // placed markers, 444 of them in a single 77 photo project.

    /**
     * The queue lives in a BAND around the corrected horizon, measured in
     * degrees rather than pixels so that zooming scales the icons and the band
     * together. In pixels the guarantee below would break exactly when the
     * operator zooms in.
     *
     * The first icon sits at the bottom of the band; the ones behind it climb
     * towards the ceiling, which they approach but never cross:
     *
     *   elevation(n) = -BASE + BAND * (1 - DECAY^n)      (BAND = BASE + CEILING)
     *   radius(n)    = ANGULAR_NEAR * DECAY^n
     *
     * Because size and height decay by the SAME ratio, the gap between two
     * consecutive icons is always the same multiple of the icon's own radius:
     *
     *   gap(n) / radius(n) = BAND * (1 - DECAY) / ANGULAR_NEAR
     *
     * So a single inequality replaces every other rule:
     *
     *   **ANGULAR_NEAR <= (1 - DECAY) * BAND**
     *
     * When it holds, the centre of every icon falls OUTSIDE the disc of the one
     * in front of it — for any number of icons, forever. There is no maximum
     * count to choose: a long corridor simply piles up towards the vanishing
     * point, which is what perspective does anyway. What ends a queue is
     * legibility (HORIZON_MIN_ANGULAR_DRAW), not an arbitrary cap.
     */
    /** Where the first icon sits BELOW the corrected horizon (degrees) */
    HORIZON_BASE_DEPRESSION_DEG: 2.2,
    /** Ceiling the queue approaches but never crosses, ABOVE the horizon (degrees) */
    HORIZON_CEILING_ELEVATION_DEG: 2.6,
    /** Angular radius of the first icon of a direction (degrees) */
    HORIZON_ANGULAR_NEAR: 2.8,
    /** Each rank is this fraction of the size AND of the remaining climb */
    HORIZON_RANK_DECAY: 0.40,
    /**
     * The queue position is not the whole story: a target that is far away should
     * read as far away even when it is ALONE in its direction, or the operator
     * loses the sense of depth that distance gives. So the rank used for size and
     * height is the queue position PLUS a fraction of where the target sits in the
     * distance ORDER of the whole photo (0 = nearest of all, 1 = farthest of all).
     *
     * Order, not metres, because the model is relative by doctrine: a corridor of
     * 3 m and one of 300 m must lay out the same way.
     *
     * This is safe for the guarantee below by construction. Within a direction the
     * members are sorted by distance, so this term never decreases along a queue;
     * consecutive effective ranks therefore still differ by AT LEAST 1, and a
     * larger step only widens the gap relative to the icon size.
     */
    HORIZON_DISTANCE_RANK_WEIGHT: 0.5,
    /**
     * Below this angular radius an icon is a smudge, so the queue stops there.
     * This is the only thing that ends a queue, and the count it produces is a
     * consequence of the geometry rather than a number someone picked.
     */
    HORIZON_MIN_ANGULAR_DRAW: 0.40,
    /**
     * Two targets count as the same direction when their bearings are closer
     * than this. Derived from the icon size rather than guessed: below twice the
     * angular radius the two icons would cover each other, which is the only
     * reason to stack them at all. The old fixed 25 degree bucket stacked
     * targets that were plainly side by side on screen.
     */
    HORIZON_DIRECTION_OVERLAP_FACTOR: 2,
    /**
     * Opacity also decays with rank, because the size floor stops the shrinking
     * after three or four ranks and everything behind would read the same.
     */
    HORIZON_RANK_FADE: 0.82,
    /** Never fade a marker below this, or it stops looking clickable */
    HORIZON_RANK_FADE_MIN: 0.45,
    /**
     * Size clamps as a FRACTION OF CANVAS HEIGHT, not pixels: an absolute cap
     * looks right on one screen and wrong on the next.
     */
    HORIZON_MIN_SIZE_REL: 0.010,
    HORIZON_MAX_SIZE_REL: 0.055,
    /** Margin from the canvas edge for off-screen arrows, as a fraction of width */
    HORIZON_EDGE_MARGIN_REL: 0.02,
    /** Absolute relative azimuth (deg) beyond which an off-screen target is dropped */
    HORIZON_EDGE_MAX_AZIMUTH: 100,

    // ===== MARKER APPEARANCE =====
    /**
     * Growth when the pointer is over a marker.
     */
    HOVER_SCALE: 1.10,

    MARKER_COLOR: 'rgba(255, 255, 255, 0.85)',
    MARKER_BORDER_COLOR: 'rgba(0, 0, 0, 0.4)',
    MARKER_BORDER_WIDTH: 3,
    // Area de clique maior que o desenho, com piso relativo a altura do canvas:
    // um alvo distante desenhava 9px e oferecia 9px de clique.
    HIT_RADIUS_MULTIPLIER: 1.5,
    HIT_RADIUS_MIN_REL: 0.024,
    FOV_MARGIN: 5,
    HOVER_ANIMATION_DURATION: 150,
});
