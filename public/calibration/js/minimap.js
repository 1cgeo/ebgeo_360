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
    onTargetClickCallback = options.onTargetClick || null;
    onTargetHoverCallback = options.onTargetHover || null;

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

    // Sair do minimapa inteiro limpa o realce. O mouseleave da CAMADA nao basta:
    // saindo rapido pela borda do mapa ele nem sempre dispara, e a esfera ficava
    // acesa no 360 sem nada apontando para ela.
    map.getCanvas().addEventListener('mouseleave', () => {
        if (hoveredTargetId === null) return;
        setHoveredTarget(null);
        onTargetHoverCallback?.(null);
    });

    // Camera marker (custom HTML element)
    cameraMarkerEl = createCameraMarkerEl();
}

// ============================================================================
// CAMERA MARKER
// ============================================================================

let cameraMapMarker = null;

// Alvo sob o mouse, seja no minimapa ou no visualizador 360.
let hoveredTargetId = null;
let onTargetHoverCallback = null;

/**
 * Realca no minimapa o alvo que esta sob o mouse.
 *
 * Chamado dos dois lados: pelo proprio minimapa quando o mouse passa sobre um
 * ponto, e pelo visualizador 360 quando o mouse passa sobre um marcador. E o
 * que amarra as duas telas: o operador ve na planta onde fica o alvo que esta
 * mirando na foto, e vice-versa.
 *
 * @param {string|null} id - Id do alvo, ou null para limpar
 */
export function setHoveredTarget(id) {
    if (!map || !map.getSource('targets')) {
        hoveredTargetId = id;
        return;
    }

    if (hoveredTargetId !== null && hoveredTargetId !== id) {
        map.setFeatureState({ source: 'targets', id: hoveredTargetId }, { hovered: false });
    }
    if (id !== null) {
        map.setFeatureState({ source: 'targets', id }, { hovered: true });
    }
    hoveredTargetId = id;
}

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
 * Correcao de sentido do cone de visada, em graus.
 *
 * Zero porque a geometria agora e inequivoca: o vertice do cone fica no ponto e
 * ele abre na direcao do olhar, entao `rotate(rumo)` aponta o feixe para o rumo.
 * O 180 que existiu aqui compensava um cone desenhado ao contrario.
 *
 * Confere com o acervo: a sequencia do museu sobe para o norte (a foto 1 e a
 * mais ao sul e os alvos tem rumo ~340), logo o feixe tem que apontar para cima
 * no minimapa quando se olha para os marcadores.
 */
const CONE_HEADING_OFFSET = 0;

/**
 * Aponta o cone do minimapa para onde o operador esta olhando AGORA.
 *
 * Separado de updateCamera de proposito: updateCamera reposiciona e recentra o
 * mapa, e roda uma vez por foto. Isto roda a cada frame e so gira o cone, que
 * antes ficava congelado no rumo gravado da foto.
 *
 * @param {number} headingOffsetDeg - Rotacao do visualizador em graus (lon)
 * @param {number} [fovDeg] - Campo de visao atual, para abrir ou fechar o cone
 */
export function setViewDirection(headingOffsetDeg, fovDeg) {
    if (!cameraMarkerEl) return;
    const cone = cameraMarkerEl.querySelector('.minimap-camera-marker__cone');
    if (!cone) return;

    const total = (currentCamera?.heading ?? 0) + headingOffsetDeg + CONE_HEADING_OFFSET;
    // O translate faz parte do posicionamento: escrever so o rotate apaga a
    // centralizacao e o cone salta para o lado.
    cone.style.transform = `translate(-50%, -100%) rotate(${total}deg)`;

    // A largura do cone acompanha o zoom: fechar o campo de visao estreita o
    // cone, o que mostra de relance o quanto esta sendo enquadrado.
    if (typeof fovDeg === 'number' && Number.isFinite(fovDeg)) {
        const half = Math.max(6, 30 * Math.tan(((fovDeg * Math.PI) / 180) / 2));
        cone.style.borderLeftWidth = `${half}px`;
        cone.style.borderRightWidth = `${half}px`;
    }
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
    // Mesma convencao de setViewDirection (ver CONE_HEADING_OFFSET).
    const totalHeading = (camera.heading ?? 0) + headingOffset + CONE_HEADING_OFFSET;
    const cone = cameraMarkerEl.querySelector('.minimap-camera-marker__cone');
    if (cone) {
        cone.style.transform = `translate(-50%, -100%) rotate(${totalHeading}deg)`;
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
                ['==', ['feature-state', 'hovered'], true], 10,
                ['==', ['feature-state', 'selected'], true], 8,
                ['==', ['get', 'hasOverride'], true], 6,
                5,
            ],
            'circle-color': [
                'case',
                ['==', ['feature-state', 'hovered'], true], '#a6e3a1',
                ['==', ['feature-state', 'selected'], true], '#fab387',
                ['==', ['get', 'hasOverride'], true], '#89b4fa',
                '#cdd6f4',
            ],
            'circle-stroke-width': [
                'case',
                ['==', ['feature-state', 'hovered'], true], 3,
                2,
            ],
            'circle-stroke-color': [
                'case',
                ['==', ['feature-state', 'hovered'], true], '#ffffff',
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

    // Hover: muda o cursor E avisa o visualizador 360, para que o mesmo alvo
    // acenda nos dois lugares. O vinculo vale nos dois sentidos.
    map.on('mousemove', 'targets-circle', (e) => {
        if (map) map.getCanvas().style.cursor = 'pointer';
        const id = e.features?.[0]?.properties?.id ?? null;
        if (id !== hoveredTargetId) {
            setHoveredTarget(id);
            onTargetHoverCallback?.(id);
        }
    });
    map.on('mouseleave', 'targets-circle', () => {
        if (map) map.getCanvas().style.cursor = '';
        if (hoveredTargetId !== null) {
            setHoveredTarget(null);
            onTargetHoverCallback?.(null);
        }
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
        promoteId: 'id',
        data: { type: 'FeatureCollection', features: [] },
    });

    map.addLayer({
        id: 'nearby-photos-circle',
        type: 'circle',
        source: 'nearby-photos',
        paint: {
            // Sem realce de mouse: estas sao as fotos NAO conectadas, que nao
            // sao destino de navegacao. Dar a elas o mesmo efeito dos alvos
            // sugeria que dava para ir ate la, o que nao e verdade.
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
    targetMarkersLayer = false;
    nearbyLayerReady = false;
    // Reseta estado de selecao/posicao para um re-init limpo.
    selectedTargetId = null;
    lastCameraLngLat = null;
    currentCamera = null;
    currentTargets = [];
    currentNearbyPhotos = [];
}
