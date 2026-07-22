/**
 * @fileoverview Navigation orchestrator for the Street View 360 calibration interface.
 * Projects targets to screen coordinates and handles click/hover.
 *
 * The marker logic is a behavioural mirror of EBGeo's StreetViewNavigator so the
 * calibration view matches production (parity checked by numeric cross-check).
 */

import { NAV_CONSTANTS } from './constants.js';
import { StreetViewProjector } from './projector.js';
import { StreetViewRenderer } from './renderer.js';
import { StreetViewHitTester } from './hit-tester.js';
import { state, isTargetHidden, onChange } from './state.js';
import { setHoveredTarget as setMinimapHoveredTarget } from './minimap.js';

// ============================================================================
// MODULE STATE
// ============================================================================

let projector = null;
let navRenderer = null;
let hitTester = null;
let overlayCanvas = null;
let navContainer = null;
let unsubscribeStateChange = null;

// Bounding rect cacheado do overlay (invalidado em resize/scroll)
let cachedRect = null;

// Camera and targets data
let cameraConfig = null;
let targets = [];
let nearbyPhotos = [];              // Nearby unconnected photos for visual representation
let nearbyPreviewEnabled = false;   // Whether nearby preview mode is active
let onNearbyClickCallback = null;   // Called when a nearby photo marker is clicked
let nearestTargetId = null;        // Nearest target by geographic distance (set once per photo — EBGeo pattern)
// Arranjo das filas por direcao, recalculado uma vez por frame antes de projetar
let directionLayout = null;


// Mouse state
let mouseX = 0;
let mouseY = 0;
let hoveredId = null;          // alvo sob o mouse DENTRO do 360
let externalHoveredId = null;  // alvo sob o mouse no MINIMAPA

// ── Dirty-checking (evita reprojetar/repintar o overlay com a cena estatica) ──
// O overlay so e recomputado quando a camera, o mouse, os dados ou o estado de
// selecao mudam, ou enquanto uma animacao de hover esta em andamento.
let navDirty = true;            // forca o primeiro frame e mudancas de dados
let lastYaw = NaN;
let lastPitch = NaN;
let lastFov = NaN;
let lastMouseX = NaN;
let lastMouseY = NaN;


/**
 * Marca o overlay de navegacao como sujo para forcar a reprojecao/repintura
 * no proximo frame. Chamado quando dados ou estado de selecao mudam.
 */
function markNavDirty() {
    navDirty = true;
}

// Callbacks
let onTargetSelectCallback = null;

// ============================================================================
// INITIALIZATION
// ============================================================================

/**
 * Initializes the navigation system.
 * @param {HTMLElement} container - The viewer container element
 * @param {Object} options - Options
 * @param {Function} [options.onTargetSelect] - Called when user clicks a target for selection
 */
export function initNavigator(container, options = {}) {
    onTargetSelectCallback = options.onTargetSelect || null;

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

    navContainer = container;

    // Track mouse on the container
    container.addEventListener('mousemove', onMouseMove);
    // Sair do 360 apaga o realce dos dois lados.
    container.addEventListener('mouseleave', onContainerMouseLeave);

    // Invalida o rect cacheado em resize/scroll (evita reflow por mousemove)
    window.addEventListener('resize', onWindowResize);
    window.addEventListener('scroll', invalidateRectCache, true);

    // Qualquer mudanca de estado (selecao, override, hidden, set-from-click)
    // marca o overlay como sujo para que ele seja reprojetado no proximo frame.
    unsubscribeStateChange = onChange(markNavDirty);
}

/**
 * Handler nomeado de resize (removivel em disposeNavigator).
 * Redimensiona overlay/projector/renderer e invalida caches.
 */
function onWindowResize() {
    if (!navContainer || !overlayCanvas || !projector || !navRenderer) return;
    const w = navContainer.clientWidth;
    const h = navContainer.clientHeight;
    overlayCanvas.width = w;
    overlayCanvas.height = h;
    projector.resize(w, h);
    navRenderer.resize(w, h);
    invalidateRectCache();
    markNavDirty();
}

/**
 * Limpa o realce quando o mouse deixa o visualizador 360.
 */
function onContainerMouseLeave() {
    if (hoveredId === null) return;
    hoveredId = null;
    refreshCursorStyle();
    setMinimapHoveredTarget(null);
    markNavDirty();
}

/**
 * Realca no 360 o alvo que o mouse tocou NO MINIMAPA.
 * O caminho inverso de setMinimapHoveredTarget: fecha o vinculo entre as telas.
 *
 * @param {string|null} id - Id do alvo, ou null para limpar
 */
export function setHoveredFromMinimap(id) {
    if (id === externalHoveredId) return;
    externalHoveredId = id;
    if (navRenderer) {
        navRenderer.setHoveredMarker(hoveredId ?? externalHoveredId);
    }
    markNavDirty();
}

/**
 * Invalida o bounding rect cacheado do overlay (usado por onMouseMove).
 */
function invalidateRectCache() {
    cachedRect = null;
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
    markNavDirty();
}

/**
 * Sets the navigation targets for the current photo.
 * @param {Array} newTargets - Array of target objects from the API
 */
export function setTargets(newTargets) {
    targets = newTargets || [];
    updateNearestTarget();
    markNavDirty();
}

/**
 * Sets the nearby unconnected photos for visual representation on the canvas.
 * @param {Array} photos - Array of nearby photo objects { id, lon, lat, displayName, distance }
 */
export function setNearbyPhotos(photos) {
    nearbyPhotos = photos || [];
    markNavDirty();
}

/**
 * Sets the nearby preview mode and click callback.
 * @param {boolean} enabled - Whether nearby preview mode is active
 * @param {Function|null} [onClick=null] - Called with nearby photo data when clicked
 */
export function setNearbyPreviewMode(enabled, onClick = null) {
    nearbyPreviewEnabled = enabled;
    onNearbyClickCallback = onClick;
    markNavDirty();
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

    // ── Dirty-check: pula a reprojecao/repintura quando nada mudou ──
    // Renderiza quando: dados/estado sujos (navDirty), camera mudou, mouse
    // mudou, ou ha animacao de hover em andamento. Caso contrario, mantem o
    // frame anterior intacto (mesma saida visual, sem trabalho redundante).
    const cameraChanged = yaw !== lastYaw || pitch !== lastPitch || fov !== lastFov;
    const mouseChanged = mouseX !== lastMouseX || mouseY !== lastMouseY;
    const animating = navRenderer.isAnimating();
    if (!navDirty && !cameraChanged && !mouseChanged && !animating) {
        return;
    }
    navDirty = false;
    lastYaw = yaw;
    lastPitch = pitch;
    lastFov = fov;
    lastMouseX = mouseX;
    lastMouseY = mouseY;

    // Pre-computa invariantes trig do frame (yaw/pitch/fov) uma unica vez.
    // Todas as chamadas a metersToScreen abaixo reaproveitam esse cache.
    projector.beginFrame(yaw, pitch, fov);

    // ── Arranjo das filas por direcao ──
    // Propriedade do conjunto: o tamanho e a altura de cada icone dependem dos
    // que estao na frente dele, entao o arranjo e calculado uma vez por frame,
    // antes de qualquer projecao.
    directionLayout = layoutDirections(targets, fov);

    const markers = [];
    for (const target of targets) {
        const projected = projectTargetOnHorizon(target, yaw, pitch, fov);
        if (projected) {
            projected.type = 'navigation';
            projected.data = target;
            markers.push(projected);
        }
    }

    // ── Fotos proximas, como marcadores cinza ──
    const nearbyMarkers = [];
    if (nearbyPhotos.length > 0 && cameraConfig) {
        for (const photo of nearbyPhotos) {
            const projected = projectNearbyPhoto(photo, yaw, pitch, fov);
            if (projected) nearbyMarkers.push(projected);
        }
    }

    // ── Area de clique: maior que o desenho, com piso relativo ao canvas ──
    assignHitRadii(markers);
    assignHitRadii(nearbyMarkers);

    const allHittable = nearbyPreviewEnabled ? [...markers, ...nearbyMarkers] : markers;
    hitTester.setMarkers(allHittable);

    // ── Hit test for hover ──
    const hitMarker = hitTester.testPoint(mouseX, mouseY);
    const newHoveredId = hitMarker ? hitMarker.id : null;
    if (newHoveredId !== hoveredId) {
        hoveredId = newHoveredId;
        refreshCursorStyle();
        // Acende o mesmo alvo no minimapa: o operador ve na planta onde fica o
        // marcador que esta mirando na foto.
        setMinimapHoveredTarget(newHoveredId);
    }

    // ── Update renderer ──
    // O realce vale para o mouse no 360 OU no minimapa. Sem juntar os dois aqui,
    // o realce vindo do minimapa morreria no frame seguinte, porque este teste
    // de acerto usa a posicao do mouse dentro do 360 e devolve "nada".
    navRenderer.setHoveredMarker(hoveredId ?? externalHoveredId);
    navRenderer.setMarkers(markers);
    navRenderer.setSelectedMarker(null); // calibration doesn't have POI selection
    navRenderer.setNearestMarker(nearestTargetId);
    navRenderer.setCursorNearestMarker(hoveredId ?? externalHoveredId);
    navRenderer.setNearbyMarkers(nearbyPreviewEnabled ? nearbyMarkers : []);

    // ── Render ──
    navRenderer.render();
}

// ============================================================================
// TARGET PROJECTION  (verbatim EBGeo projectTarget / projectFromSpherical)
// ============================================================================

/**
 * Resolves the world bearing and ground distance of a target.
 *
 * Lat/lon is the only source. The per-target overrides that used to be
 * consulted here are gone on purpose: they were calibration of the ICON, and
 * a wrong position is now corrected by moving the PHOTO, not by nudging the
 * marker that points at it. One of them, an override_distance of 17.3 m on a
 * target actually 10.2 m away, silently reordered the queue.
 *
 * @param {Object} target - Target object
 * @returns {{bearing: number, distance: number}} Bearing in degrees, distance in meters
 */
export function resolveTargetVector(target, proj = projector, camera = cameraConfig) {
    if (target.bearing != null && target.distance != null) {
        return { bearing: target.bearing, distance: target.distance };
    }

    // Fallback for older metadata that carries no precomputed vector
    const { x, z } = proj.lonLatToMeters(
        target.lon,
        target.lat,
        camera.lon,
        camera.lat
    );
    return {
        bearing: target.bearing ?? ((((Math.atan2(x, -z) * 180) / Math.PI) + 360) % 360),
        distance: target.distance ?? Math.sqrt(x * x + z * z)
    };
}

/**
 * Lays out every target as a queue along its direction.
 *
 * This is where "relative, not faithful" lives. Distance never reaches the
 * screen as a length: it is used twice, and only as an ORDER. Once to rank the
 * targets within a direction, and once, weighted, to place each target in the
 * distance order of the whole photo, so that a far target still reads as far
 * even when nothing shares its direction.
 *
 * A target only joins a queue when it would actually COVER the one in front:
 * two icons of angular radius r cover each other below 2r of bearing
 * separation, so that, and not a guessed bucket, is what defines "the same
 * direction". A target off to the side keeps its own place near the bottom
 * of the band instead of being pushed up for nothing.
 *
 * Height and size then decay by the same ratio (see constants.js), which
 * makes the queue fit the band for ANY number of icons, with every centre
 * clear of the disc in front. Nothing caps the count: a queue ends only when
 * the next icon would be too small to read.
 *
 * @param {Array} targets - Navigation targets for the current photo
 * @param {number} fov - Camera vertical FOV in degrees
 * @returns {Map<string, {rank: number, radius: number, elevationDeg: number}>} Layout per target id
 */
export function layoutDirections(targets, fov, proj = projector, camera = cameraConfig) {
    const vectors = targets
        .map(t => ({ id: t.id, ...resolveTargetVector(t, proj, camera) }))
        .sort((a, b) => a.distance - b.distance);

    // Place in the distance order of the whole photo, 0 = nearest of all.
    // A single target is the nearest of all, so it gets no nudge at all.
    const span = Math.max(1, vectors.length - 1);
    vectors.forEach((v, index) => { v.distanceRatio = index / span; });

    const directions = [];
    const layout = new Map();

    for (const v of vectors) {
        // A target belongs to a queue when the icon it WOULD get overlaps the
        // icon of the one already there, so the threshold shrinks as the
        // queue grows: what is side by side stays side by side.
        const group = directions.find(d => {
            const diff = Math.abs(((v.bearing - d.bearing + 540) % 360) - 180);
            const last = d.members[d.members.length - 1];
            const joinedRank = proj.effectiveRank(d.members.length, v.distanceRatio);
            const reach = (proj.angularRadiusDeg(last.rank)
                + proj.angularRadiusDeg(joinedRank))
                * (NAV_CONSTANTS.HORIZON_DIRECTION_OVERLAP_FACTOR / 2);
            return diff <= reach;
        });

        if (group) {
            v.rank = proj.effectiveRank(group.members.length, v.distanceRatio);
            group.members.push(v);
        } else {
            v.rank = proj.effectiveRank(0, v.distanceRatio);
            directions.push({ bearing: v.bearing, members: [v] });
        }
    }

    for (const direction of directions) {
        for (const member of direction.members) {
            // The queue ends where legibility does, not at a chosen number.
            if (proj.angularRadiusDeg(member.rank) < NAV_CONSTANTS.HORIZON_MIN_ANGULAR_DRAW) {
                continue;
            }

            layout.set(member.id, {
                rank: member.rank,
                radius: proj.angularMarkerRadius(member.rank, fov),
                elevationDeg: proj.elevationDeg(member.rank),
            });
        }
    }

    return layout;
}

/**
 * Metadados que so a calibracao usa: selecao para edicao e alvo oculto.
 * @param {Object} target - Alvo
 * @returns {Object} Campos extras do marcador
 */
function calibrationMeta(target) {
    return {
        isNext: target.next,
        isCalibrationSelected: target.id === state.selectedTargetId,
        isHidden: isTargetHidden(target.id),
        displayName: target.display_name || target.id.slice(0, 8),
    };
}

function projectTargetOnHorizon(target, yaw, pitch, fov) {
    const placement = directionLayout?.get(target.id);
    if (!placement) return null;   // too small to read: the queue ended here

    const { bearing } = resolveTargetVector(target);
    const projected = projector.projectOnHorizon(
        bearing, yaw, pitch, fov, placement.elevationDeg
    );

    // Outside the horizontal field of view: keep it as an edge arrow so the
    // operator still knows there is a way out in that direction.
    if (!projected.visible) {
        if (Math.abs(projected.azimuthRelDeg) > NAV_CONSTANTS.HORIZON_EDGE_MAX_AZIMUTH) {
            return null;
        }
        const margin = overlayCanvas.width * NAV_CONSTANTS.HORIZON_EDGE_MARGIN_REL;
        return {
            id: target.id,
            screenX: projected.azimuthRelDeg > 0 ? overlayCanvas.width - margin : margin,
            screenY: overlayCanvas.height / 2,
            distance: placement.rank,
            radius: Math.max(
                overlayCanvas.height * NAV_CONSTANTS.HORIZON_MIN_SIZE_REL,
                placement.radius * 0.7
            ),
            rank: placement.rank,
            offscreen: true,
            offscreenSide: projected.azimuthRelDeg > 0 ? 'right' : 'left'
        };
    }

    return {
        id: target.id,
        screenX: projected.screenX,
        // The first icon sits just below the horizon and the queue climbs
        // from there, by gaps derived from the icons themselves.
        screenY: projected.screenY,
        // Sorting key for draw order: nearer icons paint on top.
        distance: placement.rank,
        radius: placement.radius,
        rank: placement.rank,
        offscreen: false,
        sphere: true,
        ...calibrationMeta(target),
    };
}

/**
 * Gives every marker a clickable radius that is larger than its drawing and
 * never smaller than a fingertip.
 *
 * Doing it here, rather than in the hit tester, is what allows the floor to
 * be relative to the canvas: the navigator is the only one that knows how
 * big the canvas is.
 *
 * Exportada e com a altura por parametro para que o teste exercite ESTA funcao,
 * e nao uma copia dela: o teste antes reimplementava a formula, entao ficaria
 * verde mesmo se a producao mudasse.
 *
 * @param {Array} markers - Projected navigation markers, mutated in place
 * @param {number} [height] - Altura do canvas; usa o overlay quando omitida
 */
export function assignHitRadii(markers, height = overlayCanvas?.height ?? 0) {
    const floor = height * NAV_CONSTANTS.HIT_RADIUS_MIN_REL;
    for (const marker of markers) {
        marker.hitRadius = Math.max(
            marker.radius * NAV_CONSTANTS.HIT_RADIUS_MULTIPLIER,
            floor
        );
    }
}

/**
 * Projeta uma foto proxima (nao conectada) pelo mesmo modelo dos alvos.
 *
 * Sao candidatas a virar alvo, entao precisam ser desenhadas pelo mesmo criterio
 * do que vao se tornar: direcao do lat/long, e nada de distancia no desenho.
 *
 * @param {Object} photo - Foto proxima com lon/lat
 * @param {number} yaw - Yaw da camera em radianos
 * @param {number} pitch - Pitch da camera em radianos
 * @param {number} fov - Campo de visao em graus
 * @returns {Object|null} Marcador projetado, ou null se fora da vista
 */
function projectNearbyPhoto(photo, yaw, pitch, fov) {
    if (!cameraConfig) return null;

    const { x, z } = projector.lonLatToMeters(
        photo.lon, photo.lat,
        cameraConfig.lon, cameraConfig.lat
    );
    const bearing = ((((Math.atan2(x, -z) * 180) / Math.PI) + 360) % 360);

    // Desenhada na mesma faixa dos alvos, na altura de quem seria o primeiro da
    // fila: e uma candidata a virar alvo, nao um alvo atras de outro.
    const projected = projector.projectOnHorizon(
        bearing, yaw, pitch, fov, projector.elevationDeg(0)
    );
    if (!projected.visible) return null;

    return {
        id: photo.id,
        screenX: projected.screenX,
        screenY: projected.screenY,
        distance: Math.hypot(x, z),
        radius: projector.angularMarkerRadius(1, fov),
        rank: 1,
        offscreen: false,
        type: 'nearby',
        displayName: photo.displayName || photo.id.slice(0, 8),
        data: photo,
    };
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
    if (!overlayCanvas) return;
    // getBoundingClientRect forca reflow; cacheamos e so recalculamos apos
    // resize/scroll (o overlay e position:absolute, top/left:0).
    if (!cachedRect) {
        cachedRect = overlayCanvas.getBoundingClientRect();
    }
    mouseX = e.clientX - cachedRect.left;
    mouseY = e.clientY - cachedRect.top;
}

function refreshCursorStyle() {
    if (!overlayCanvas) return;
    const container = overlayCanvas.parentElement;
    if (!container) return;

    if (hoveredId) {
        container.style.cursor = 'pointer';
    } else {
        container.style.cursor = 'grab';
    }
}

// ============================================================================
// PUBLIC UTILITIES
// ============================================================================

/**
 * Disposes of the navigator.
 */
export function disposeNavigator() {
    if (navContainer) {
        navContainer.removeEventListener('mousemove', onMouseMove);
    } else if (overlayCanvas?.parentElement) {
        overlayCanvas.parentElement.removeEventListener('mousemove', onMouseMove);
    }
    window.removeEventListener('resize', onWindowResize);
    window.removeEventListener('scroll', invalidateRectCache, true);
    if (unsubscribeStateChange) {
        unsubscribeStateChange();
        unsubscribeStateChange = null;
    }
    if (overlayCanvas?.parentElement) {
        overlayCanvas.parentElement.removeChild(overlayCanvas);
    }
    projector = null;
    navRenderer?.dispose();
    navRenderer = null;
    hitTester = null;
    overlayCanvas = null;
    navContainer = null;
    cachedRect = null;
    targets = [];
    nearbyPhotos = [];
    nearbyPreviewEnabled = false;
    onNearbyClickCallback = null;
    nearestTargetId = null;
    externalHoveredId = null;
    // Reseta dirty-flags e caches
    navDirty = true;
    lastYaw = NaN; lastPitch = NaN; lastFov = NaN;
    lastMouseX = NaN; lastMouseY = NaN;
}
