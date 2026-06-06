/**
 * @fileoverview MapLibre GL JS minimap for the Street View 360 calibration interface.
 * Shows camera position with heading indicator and target markers.
 * Clicking a target on the minimap selects it for calibration.
 */

// MapLibre GL is loaded via CDN <script> tag and available as window.maplibregl

// ============================================================================
// MODULE STATE
// ============================================================================

let map = null;
let containerEl = null;
let cameraMarkerEl = null;
let targetMarkersLayer = false;

// Callbacks
let onTargetClickCallback = null;

// Current data
let currentCamera = null;
let currentTargets = [];
let currentNearbyPhotos = [];
let selectedTargetId = null;
let nearbyLayerReady = false;
// Posicao da camera atualmente exibida no minimapa (para detectar mudanca real)
let lastCameraLngLat = null;

// ============================================================================
// INITIALIZATION
// ============================================================================

/**
 * Initializes the minimap.
 * @param {HTMLElement} container - DOM element for the map
 * @param {Object} [options] - Options
 * @param {Function} [options.onTargetClick] - Called when a target marker is clicked
 */
export function initMinimap(container, options = {}) {
    containerEl = container;
    onTargetClickCallback = options.onTargetClick || null;

    // eslint-disable-next-line no-undef
    map = new maplibregl.Map({
        container,
        style: {
            version: 8,
            sources: {
                osm: {
                    type: 'raster',
                    tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
                    tileSize: 256,
                    attribution: '&copy; OpenStreetMap contributors',
                },
            },
            layers: [
                {
                    id: 'osm',
                    type: 'raster',
                    source: 'osm',
                },
            ],
        },
        center: [-54.0, -29.0],
        zoom: 16,
        attributionControl: false,
    });

    map.on('load', () => {
        setupTargetLayer();
        setupNearbyLayer();
    });

    // Camera marker (custom HTML element)
    cameraMarkerEl = createCameraMarkerEl();
}

// ============================================================================
// CAMERA MARKER
// ============================================================================

let cameraMapMarker = null;

function createCameraMarkerEl() {
    const el = document.createElement('div');
    el.className = 'minimap-camera-marker';
    el.innerHTML = `
        <div class="minimap-camera-marker__body"></div>
        <div class="minimap-camera-marker__cone"></div>
    `;
    return el;
}

/**
 * Updates the camera position and heading on the minimap.
 * @param {Object} camera - Camera data { lon, lat, heading }
 * @param {number} [headingOffset=0] - Additional heading from viewer rotation
 */
export function updateCamera(camera, headingOffset = 0) {
    if (!map || !camera) return;

    currentCamera = camera;

    // Update or create camera marker
    if (!cameraMapMarker) {
        // eslint-disable-next-line no-undef
        cameraMapMarker = new maplibregl.Marker({
            element: cameraMarkerEl,
            anchor: 'center',
        })
            .setLngLat([camera.lon, camera.lat])
            .addTo(map);
    } else {
        cameraMapMarker.setLngLat([camera.lon, camera.lat]);
    }

    // Rotate the marker to show heading direction
    const totalHeading = (camera.heading ?? 0) + headingOffset;
    const cone = cameraMarkerEl.querySelector('.minimap-camera-marker__cone');
    if (cone) {
        cone.style.transform = `rotate(${totalHeading}deg)`;
    }

    // Recentrar o mapa apenas quando a posicao realmente muda.
    // Na primeira carga usa jumpTo (sem animacao); depois anima so se houve deslocamento.
    const moved =
        !lastCameraLngLat ||
        lastCameraLngLat[0] !== camera.lon ||
        lastCameraLngLat[1] !== camera.lat;
    if (moved) {
        if (!lastCameraLngLat) {
            map.jumpTo({ center: [camera.lon, camera.lat] });
        } else {
            map.easeTo({
                center: [camera.lon, camera.lat],
                duration: 300,
            });
        }
        lastCameraLngLat = [camera.lon, camera.lat];
    }
}

// ============================================================================
// TARGET MARKERS
// ============================================================================

function setupTargetLayer() {
    if (!map) return;

    // Add source for targets.
    // promoteId expoe o id do target como feature id, permitindo usar
    // setFeatureState para a selecao sem reconstruir a GeoJSON inteira.
    map.addSource('targets', {
        type: 'geojson',
        promoteId: 'id',
        data: { type: 'FeatureCollection', features: [] },
    });

    // Target circles. O estado "selected" vem de feature-state (alternado via
    // setFeatureState), nao de uma propriedade reconstruida a cada selecao.
    map.addLayer({
        id: 'targets-circle',
        type: 'circle',
        source: 'targets',
        paint: {
            'circle-radius': [
                'case',
                ['==', ['feature-state', 'selected'], true], 8,
                ['==', ['get', 'hasOverride'], true], 6,
                5,
            ],
            'circle-color': [
                'case',
                ['==', ['feature-state', 'selected'], true], '#fab387',
                ['==', ['get', 'hasOverride'], true], '#89b4fa',
                '#cdd6f4',
            ],
            'circle-stroke-width': 2,
            'circle-stroke-color': [
                'case',
                ['==', ['feature-state', 'selected'], true], '#fab387',
                '#45475a',
            ],
        },
    });

    // Click handler for targets
    map.on('click', 'targets-circle', (e) => {
        if (e.features?.length && onTargetClickCallback) {
            onTargetClickCallback(e.features[0].properties.id);
        }
    });

    // Hover cursor for targets
    map.on('mouseenter', 'targets-circle', () => {
        if (map) map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', 'targets-circle', () => {
        if (map) map.getCanvas().style.cursor = '';
    });

    targetMarkersLayer = true;

    // Render any pending targets
    if (currentTargets.length) {
        updateTargetsGeoJSON();
    }
}

/**
 * Updates the target markers on the minimap.
 * @param {Array} targets - Array of target objects with lon, lat, id
 */
export function updateTargets(targets) {
    currentTargets = targets || [];
    if (targetMarkersLayer) {
        updateTargetsGeoJSON();
    }
}

/**
 * Highlights a selected target on the minimap.
 * @param {string|null} targetId - Target ID to highlight, or null to clear
 */
export function setSelectedTarget(targetId) {
    // Curto-circuito: nada a fazer se a selecao nao mudou.
    if (targetId === selectedTargetId) return;

    const previousId = selectedTargetId;
    selectedTargetId = targetId;

    // Alterna apenas o feature-state das features afetadas, sem reconstruir
    // toda a GeoJSON (evita re-tesselar/repintar a source inteira).
    if (targetMarkersLayer) {
        setTargetSelectedState(previousId, false);
        setTargetSelectedState(targetId, true);
    }
}

/**
 * Aplica o feature-state "selected" a um target especifico.
 * @param {string|null} targetId - ID do target
 * @param {boolean} selected - Novo estado de selecao
 */
function setTargetSelectedState(targetId, selected) {
    if (!map || targetId == null || !map.getSource('targets')) return;
    map.setFeatureState({ source: 'targets', id: targetId }, { selected });
}

function updateTargetsGeoJSON() {
    if (!map || !map.getSource('targets')) return;

    const features = currentTargets.map(t => ({
        type: 'Feature',
        id: t.id,
        geometry: {
            type: 'Point',
            coordinates: [t.lon, t.lat],
        },
        properties: {
            id: t.id,
            hasOverride: t.override_bearing != null,
            displayName: t.display_name || t.id.slice(0, 8),
        },
    }));

    map.getSource('targets').setData({
        type: 'FeatureCollection',
        features,
    });

    // setData limpa o feature-state; reaplica a selecao corrente.
    if (selectedTargetId != null) {
        setTargetSelectedState(selectedTargetId, true);
    }
}

// ============================================================================
// NEARBY PHOTOS LAYER
// ============================================================================

function setupNearbyLayer() {
    if (!map) return;

    map.addSource('nearby-photos', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
    });

    map.addLayer({
        id: 'nearby-photos-circle',
        type: 'circle',
        source: 'nearby-photos',
        paint: {
            'circle-radius': 4,
            'circle-color': '#6c7086',
            'circle-stroke-width': 1,
            'circle-stroke-color': '#45475a',
            'circle-opacity': 0.7,
        },
    });

    nearbyLayerReady = true;

    if (currentNearbyPhotos.length) {
        updateNearbyGeoJSON();
    }
}

/**
 * Updates the nearby (unconnected) photo markers on the minimap.
 * @param {Array} photos - Array of nearby photo objects with lon, lat, id
 */
export function updateNearbyPhotos(photos) {
    currentNearbyPhotos = photos || [];
    if (nearbyLayerReady) {
        updateNearbyGeoJSON();
    }
}

function updateNearbyGeoJSON() {
    if (!map || !map.getSource('nearby-photos')) return;

    const features = currentNearbyPhotos.map(p => ({
        type: 'Feature',
        geometry: {
            type: 'Point',
            coordinates: [p.lon, p.lat],
        },
        properties: {
            id: p.id,
            displayName: p.displayName || p.id.slice(0, 8),
        },
    }));

    map.getSource('nearby-photos').setData({
        type: 'FeatureCollection',
        features,
    });
}

// ============================================================================
// CLEANUP
// ============================================================================

/**
 * Disposes of the minimap.
 */
export function disposeMinimap() {
    if (cameraMapMarker) {
        cameraMapMarker.remove();
        cameraMapMarker = null;
    }
    if (map) {
        map.remove();
        map = null;
    }
    containerEl = null;
    targetMarkersLayer = false;
    nearbyLayerReady = false;
    // Reseta estado de selecao/posicao para um re-init limpo.
    selectedTargetId = null;
    lastCameraLngLat = null;
    currentCamera = null;
    currentTargets = [];
    currentNearbyPhotos = [];
}
