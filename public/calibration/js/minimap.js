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

    // Center map on camera
    map.easeTo({
        center: [camera.lon, camera.lat],
        duration: 300,
    });
}

// ============================================================================
// TARGET MARKERS
// ============================================================================

function setupTargetLayer() {
    if (!map) return;

    // Add source for targets
    map.addSource('targets', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
    });

    // Target circles
    map.addLayer({
        id: 'targets-circle',
        type: 'circle',
        source: 'targets',
        paint: {
            'circle-radius': [
                'case',
                ['==', ['get', 'selected'], true], 8,
                ['==', ['get', 'hasOverride'], true], 6,
                5,
            ],
            'circle-color': [
                'case',
                ['==', ['get', 'selected'], true], '#fab387',
                ['==', ['get', 'hasOverride'], true], '#89b4fa',
                '#cdd6f4',
            ],
            'circle-stroke-width': 2,
            'circle-stroke-color': [
                'case',
                ['==', ['get', 'selected'], true], '#fab387',
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
    selectedTargetId = targetId;
    if (targetMarkersLayer) {
        updateTargetsGeoJSON();
    }
}

function updateTargetsGeoJSON() {
    if (!map || !map.getSource('targets')) return;

    const features = currentTargets.map(t => ({
        type: 'Feature',
        geometry: {
            type: 'Point',
            coordinates: [t.lon, t.lat],
        },
        properties: {
            id: t.id,
            selected: t.id === selectedTargetId,
            hasOverride: t.override_bearing != null,
            displayName: t.display_name || t.id.slice(0, 8),
        },
    }));

    map.getSource('targets').setData({
        type: 'FeatureCollection',
        features,
    });
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
}
