/**
 * @fileoverview Modo mapa da calibracao: o projeto inteiro numa planta MapLibre.
 *
 * Existe para revisar em largura, e nao em profundidade — enxergar de uma vez
 * quais fotos ja passaram pela revisao, onde estao os buracos do tracado, e
 * pular direto para a foto que interessa em vez de caminhar pelo grafo.
 *
 * Um projeto por vez, sempre. O payload vem de GET /api/v1/projects/:slug/map,
 * e o tracado e a MESMA linha do fotos_linha.pmtiles — guardada por projeto na
 * tabela `project_tracks` (ver scripts/import-tracks.js). O PMTiles em si nao
 * serve aqui: e um arquivo unico com os 28 projetos misturados, e os 21 antigos
 * estao todos gravados como `origem = 'legado'`, sem como separa-los.
 *
 * MapLibre GL vem por CDN e esta em window.maplibregl.
 */

import { fetchProjectMap, getPhotoImageUrl } from './api.js';

// ============================================================================
// ESTADO DO MODULO
// ============================================================================

let map = null;
// Resolve quando o estilo do MapLibre terminou de carregar E montarCamadas
// rodou. Antes disso `map.getSource(...)` devolve undefined: o fetch do projeto
// e rapido o bastante para chegar primeiro, e sem essa espera o modo mapa
// quebrava com "Cannot read properties of undefined (reading 'setData')".
let mapPronto = null;
let containerEl = null;
let cardEl = null;
let aberto = false;
let slugCarregado = null;

let fotos = [];                 // payload cru, na ordem de sequencia
let porId = new Map();          // id -> foto
let selecionadaId = null;
let fotoAtualId = null;         // a foto aberta no viewer 360

let onOpenPhotoCallback = null;
let onCloseCallback = null;

// Andar em exibicao, ou null para "projeto sem andares / todos".
//
// Num levantamento indoor o mapa SEM este filtro e ilegivel: no Beira-Rio os 6
// andares ocupam a mesma pegada, e 91 das 350 fotos tem foto de outro andar a
// menos de 5 m em planta. Os pontos empilham e o operador nao sabe qual clicou.
let andarAtual = null;
// [{ level, label, count }], de cima para baixo, derivado das proprias fotos.
let andares = [];

// Cores: verde = revisada, ambar = pendente, azul = onde o operador esta.
const COR_REVISADA = '#a6e3a1';
const COR_PENDENTE = '#f9e2af';
const COR_ATUAL = '#89b4fa';
// Malva: fora da paleta do OSM (que e verde/rosa/cinza) e distinta das tres
// cores de ponto. Um azul claro translucido, que era o valor anterior, ficava
// indistinguivel do contorno das vias do mapa base.
const COR_TRACADO = '#cba6f7';
const COR_TRACADO_CONTORNO = 'rgba(17, 17, 27, 0.55)';

// ============================================================================
// INICIALIZACAO
// ============================================================================

/**
 * Prepara o modo mapa. Nao cria o mapa ainda — o MapLibre so e instanciado na
 * primeira abertura, para nao pagar um contexto WebGL a mais em toda sessao de
 * calibracao que nunca abrir o mapa.
 *
 * @param {HTMLElement} container - Elemento onde o mapa e o card sao montados
 * @param {Object} [options]
 * @param {Function} [options.onOpenPhoto] - Recebe o id da foto a abrir no 360
 * @param {Function} [options.onClose] - Chamado ao fechar o modo mapa
 */
export function initProjectMap(container, options = {}) {
    containerEl = container;
    onOpenPhotoCallback = options.onOpenPhoto || null;
    onCloseCallback = options.onClose || null;
}

function criarMapa() {
    const mapEl = document.createElement('div');
    mapEl.className = 'pmap__canvas';
    containerEl.appendChild(mapEl);

    map = new maplibregl.Map({
        container: mapEl,
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
            layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
        },
        center: [-54, -29],
        zoom: 14,
    });

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-left');
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');

    mapPronto = new Promise((resolve) => {
        map.on('load', () => {
            montarCamadas();
            resolve();
        });
    });

    cardEl = document.createElement('div');
    cardEl.className = 'pmap__card';
    cardEl.hidden = true;
    containerEl.appendChild(cardEl);
}

function montarCamadas() {
    map.addSource('pmap-track', { type: 'geojson', data: vazio() });

    // Duas camadas para o mesmo tracado: um contorno escuro por baixo e a linha
    // por cima. So a cor nao basta — o mapa base alterna areas verdes claras e
    // rosas, e uma linha unica some sobre uma das duas. O contorno garante o
    // contraste em qualquer fundo.
    // A largura fica quase constante em pixels ate o zoom 15 e so cresce de
    // perto. Se ela encolhesse junto com o mapa, ao afastar os pontos se
    // encostariam ate formar uma corrente continua que tapa a linha por baixo —
    // era o que acontecia, e dava a impressao de que o trajeto nao existia.
    const larguraTracado = ['interpolate', ['linear'], ['zoom'], 11, 3, 15, 3, 16, 3.5, 20, 6];
    map.addLayer({
        id: 'pmap-track-contorno',
        type: 'line',
        source: 'pmap-track',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
            'line-color': COR_TRACADO_CONTORNO,
            'line-width': ['interpolate', ['linear'], ['zoom'], 11, 5, 15, 5, 16, 6.5, 20, 10],
            // O contorno some ao afastar. Na escala do projeto inteiro o trajeto
            // dobra sobre si mesmo dezenas de vezes, os contornos de segmentos
            // vizinhos se sobrepoem e a mancha escura engole a linha malva.
            // De perto, que e quando o fundo alterna verde e rosa, ele volta.
            'line-opacity': ['interpolate', ['linear'], ['zoom'], 16.5, 0, 17.5, 1],
        },
    });
    // De perto o trajeto passa POR BAIXO dos pontos: eles sao o alvo de clique
    // e precisam ficar nitidos.
    map.addLayer({
        id: 'pmap-track',
        type: 'line',
        source: 'pmap-track',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
            'line-color': COR_TRACADO,
            'line-width': larguraTracado,
            'line-opacity': ['interpolate', ['linear'], ['zoom'], 16.5, 0, 17.5, 1],
        },
    });

    map.addSource('pmap-photos', { type: 'geojson', data: vazio(), promoteId: 'id' });
    map.addLayer({
        id: 'pmap-photos',
        type: 'circle',
        source: 'pmap-photos',
        paint: {
            // Encolhe mais rapido que a linha ao afastar: de longe o que importa
            // e a forma do levantamento, e de perto o ponto volta a ser o alvo
            // de clique.
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 1.2, 14, 2.2, 16, 5, 20, 9],
            'circle-color': [
                'case',
                ['boolean', ['feature-state', 'atual'], false], COR_ATUAL,
                ['get', 'reviewed'], COR_REVISADA,
                COR_PENDENTE,
            ],
            'circle-stroke-color': [
                'case',
                ['boolean', ['feature-state', 'selecionada'], false], '#ffffff',
                'rgba(17, 17, 27, 0.85)',
            ],
            // O anel escuro separa pontos vizinhos de perto, mas na escala do
            // projeto inteiro milhares deles se encostam e viram uma mancha
            // preta que esconde o trajeto. Some ao afastar; a foto selecionada
            // mantem o anel branco em qualquer zoom, senao o operador perde de
            // vista o que acabou de clicar.
            //
            // O `interpolate` de zoom precisa ser a expressao mais externa — e
            // uma restricao do MapLibre. Com o `case` por fora a propriedade
            // fica invalida e a camada inteira para de renderizar, entao o
            // `case` vai dentro de cada parada.
            'circle-stroke-width': [
                'interpolate', ['linear'], ['zoom'],
                13, ['case', ['boolean', ['feature-state', 'selecionada'], false], 3, 0],
                15, ['case', ['boolean', ['feature-state', 'selecionada'], false], 3, 1],
            ],
        },
    });

    // ...e de longe passa POR CIMA. Sem isso os pontos se encostam ate formar
    // uma corrente continua que cobre a linha, e o trajeto some exatamente na
    // escala em que ele e a informacao mais util — a forma do levantamento.
    // Duas camadas com opacidade cruzada, em vez de reordenar em tempo de
    // execucao, que exigiria remover e re-adicionar camada a cada zoom.
    //
    // A troca fica em 16,5-17,5 porque e onde os pontos param de se tocar: com
    // fotos a ~15 m, a 2,2 m/px do zoom 16 elas ficam a 6,8 px uma da outra e o
    // raio ja e 5 px; so no 17 (13,6 px de distancia) abre folga entre elas.
    map.addLayer({
        id: 'pmap-track-topo',
        type: 'line',
        source: 'pmap-track',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
            'line-color': COR_TRACADO,
            'line-width': larguraTracado,
            'line-opacity': ['interpolate', ['linear'], ['zoom'], 16.5, 1, 17.5, 0],
        },
    });

    map.on('click', 'pmap-photos', (e) => {
        const f = e.features?.[0];
        if (f) selecionar(f.properties.id);
    });
    map.on('mouseenter', 'pmap-photos', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'pmap-photos', () => { map.getCanvas().style.cursor = ''; });
    // Clicar no vazio fecha o card, que e o gesto que todo mapa ensina.
    map.on('click', (e) => {
        const hits = map.queryRenderedFeatures(e.point, { layers: ['pmap-photos'] });
        if (!hits.length) selecionar(null);
    });
}

const vazio = () => ({ type: 'FeatureCollection', features: [] });

/**
 * Monta a colecao de pontos. O id da feature vem de `properties.id` via
 * `promoteId` da fonte — e o que permite `setFeatureState` com UUID, ja que id
 * de topo em GeoJSON so aceita numero de forma confiavel.
 */
const colecaoDeFotos = () => ({
    type: 'FeatureCollection',
    features: fotosVisiveis().map(f => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [f.lon, f.lat] },
        properties: { id: f.id, reviewed: f.reviewed },
    })),
});

/**
 * As fotos que o mapa desenha agora: todas, ou so as do andar escolhido.
 *
 * O filtro roda AQUI, ao montar a colecao, e nao num `filter` de camada do
 * MapLibre, porque o mesmo recorte precisa valer para o zoom automatico e para
 * o contador da legenda. Duas verdades sobre "o que esta na tela" divergiriam
 * na primeira troca de andar.
 */
function fotosVisiveis() {
    if (andarAtual === null) return fotos;
    return fotos.filter(f => f.floor === andarAtual);
}

// ============================================================================
// ABRIR / FECHAR
// ============================================================================

/**
 * Abre o modo mapa para um projeto.
 * @param {string} slug - Slug do projeto
 * @param {string|null} [photoIdAtual] - Foto aberta no 360, destacada na planta
 * @returns {Promise<void>}
 */
export async function openProjectMap(slug, photoIdAtual = null) {
    if (!containerEl) return;
    if (!map) criarMapa();

    aberto = true;
    fotoAtualId = photoIdAtual;
    containerEl.hidden = false;
    // O MapLibre calcula o tamanho do canvas no momento em que e criado; se o
    // container estava escondido, ele nasce com 0x0 e o mapa fica em branco.
    map.resize();

    if (slugCarregado !== slug) {
        containerEl.classList.add('pmap--carregando');
        try {
            // O estilo do mapa carrega em paralelo com o payload do projeto —
            // esperar os dois em Promise.all evita serializar as duas esperas.
            const [dados] = await Promise.all([fetchProjectMap(slug), mapPronto]);
            aplicarDados(dados);
            slugCarregado = slug;
        } catch (err) {
            containerEl.classList.remove('pmap--carregando');
            mostrarErro(err.message);
            return;
        }
        containerEl.classList.remove('pmap--carregando');
    } else {
        await mapPronto;
    }

    marcarAtual(photoIdAtual);
    if (photoIdAtual && porId.has(photoIdAtual)) {
        const f = porId.get(photoIdAtual);
        map.easeTo({ center: [f.lon, f.lat], zoom: Math.max(map.getZoom(), 17), duration: 400 });
        selecionar(photoIdAtual);
    }
}

/** Fecha o modo mapa, preservando os dados ja carregados. */
export function closeProjectMap() {
    if (!aberto) return;
    aberto = false;
    if (containerEl) containerEl.hidden = true;
    onCloseCallback?.();
}

/** @returns {boolean} Se o modo mapa esta visivel. */
export function isProjectMapOpen() {
    return aberto;
}

/** Libera o mapa e zera o cache — usado no teardown da sessao. */
export function disposeProjectMap() {
    if (map) {
        map.remove();
        map = null;
    }
    mapPronto = null;
    if (containerEl) {
        containerEl.innerHTML = '';
        containerEl.hidden = true;
    }
    cardEl = null;
    aberto = false;
    slugCarregado = null;
    fotos = [];
    porId = new Map();
    selecionadaId = null;
    fotoAtualId = null;
    andarAtual = null;
    andares = [];
}

// ============================================================================
// DADOS
// ============================================================================

function aplicarDados(dados) {
    fotos = dados.photos || [];
    porId = new Map(fotos.map(f => [f.id, f]));
    andares = derivarAndares(fotos);
    // Abre no andar da foto aberta no 360, quando ha andar. Comecar no terreo
    // tiraria o operador do contexto que ele acabou de deixar.
    andarAtual = andares.length > 0
        ? (porId.get(fotoAtualId)?.floor ?? andares[andares.length - 1].level)
        : null;

    map.getSource('pmap-photos').setData(colecaoDeFotos());

    map.getSource('pmap-track').setData({
        type: 'FeatureCollection',
        features: (dados.track || []).map(coords => ({
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: coords },
            properties: {},
        })),
    });

    const [oeste, sul, leste, norte] = dados.bounds;
    map.fitBounds([[oeste, sul], [leste, norte]], { padding: 60, duration: 0 });

    atualizarLegenda(dados.reviewStats);
}

/**
 * Os andares presentes nas fotos, de cima para baixo.
 *
 * Derivado das fotos e nao de uma chamada a /floors: o payload do mapa ja traz
 * o andar de cada foto, e uma segunda fonte poderia listar um andar que o mapa
 * nao desenha.
 *
 * @param {Array<Object>} lista - Fotos do payload do mapa
 * @returns {Array<{level: number, label: string, count: number}>}
 */
function derivarAndares(lista) {
    const porNivel = new Map();
    for (const f of lista) {
        if (f.floor == null) continue;
        porNivel.set(f.floor, (porNivel.get(f.floor) ?? 0) + 1);
    }
    // Um nivel so nao e um predio: nao vale desenhar seletor para ele.
    if (porNivel.size < 2) return [];
    return [...porNivel.entries()]
        .sort((a, b) => b[0] - a[0])
        .map(([level, count]) => ({ level, label: rotuloDeAndar(level), count }));
}

/** Rotulo curto do andar, para caber no botao do seletor. */
function rotuloDeAndar(level) {
    if (level === 0) return 'Ext';
    if (level < 0) return `S${-level}`;
    return String(level);
}

/**
 * Troca o andar em exibicao e redesenha.
 * @param {number} level - Nivel a mostrar
 */
function trocarAndar(level) {
    if (level === andarAtual) return;
    andarAtual = level;
    map.getSource('pmap-photos').setData(colecaoDeFotos());
    // O destaque da foto atual pode ter saido de cena junto com o andar.
    marcarAtual(fotoAtualId);
    if (selecionadaId && porId.get(selecionadaId)?.floor !== level) {
        selecionadaId = null;
    }
    renderCard();
    atualizarLegenda(null);
}

/**
 * Reflete no mapa a revisao de uma foto sem recarregar o projeto inteiro.
 * @param {string} photoId - Id da foto
 * @param {boolean} reviewed - Novo estado
 */
export function setPhotoReviewedOnMap(photoId, reviewed) {
    const f = porId.get(photoId);
    if (!f) return;
    f.reviewed = reviewed;
    if (!map?.getSource('pmap-photos')) return;
    // O MapLibre nao expoe edicao de uma feature isolada em fonte geojson, entao
    // reenviamos a colecao — mas montada do array ja em memoria, sem refazer o
    // fetch do projeto.
    map.getSource('pmap-photos').setData(colecaoDeFotos());
    // O contador da legenda tambem envelhece: sem isso o mapa mostraria a foto
    // verde mas "0/1235 revisadas" no canto.
    atualizarLegenda(null);
    if (selecionadaId === photoId) renderCard();
}

/**
 * Move o destaque de "foto atual" ao navegar no 360 com o mapa aberto.
 * @param {string|null} photoId - Id da foto agora aberta
 */
export function setCurrentPhotoOnMap(photoId) {
    fotoAtualId = photoId;
    marcarAtual(photoId);
}

let ultimoAtual = null;
function marcarAtual(photoId) {
    if (!map?.getSource('pmap-photos')) return;
    if (ultimoAtual && ultimoAtual !== photoId) {
        map.setFeatureState({ source: 'pmap-photos', id: ultimoAtual }, { atual: false });
    }
    if (photoId && porId.has(photoId)) {
        map.setFeatureState({ source: 'pmap-photos', id: photoId }, { atual: true });
    }
    ultimoAtual = photoId;
}

// ============================================================================
// SELECAO E CARD
// ============================================================================

function selecionar(photoId) {
    const fonteViva = Boolean(map?.getSource('pmap-photos'));
    if (selecionadaId && fonteViva) {
        map.setFeatureState({ source: 'pmap-photos', id: selecionadaId }, { selecionada: false });
    }
    selecionadaId = photoId && porId.has(photoId) ? photoId : null;
    if (selecionadaId && fonteViva) {
        map.setFeatureState({ source: 'pmap-photos', id: selecionadaId }, { selecionada: true });
    }
    renderCard();
}

const grau = (v) => (typeof v === 'number' ? `${v.toFixed(1)}°` : '—');

function renderCard() {
    if (!cardEl) return;
    if (!selecionadaId) {
        cardEl.hidden = true;
        cardEl.innerHTML = '';
        return;
    }
    const f = porId.get(selecionadaId);
    const ehAtual = f.id === fotoAtualId;

    cardEl.hidden = false;
    cardEl.innerHTML = `
        <button class="pmap__card-close" data-acao="fechar" title="Fechar">&times;</button>
        <img class="pmap__card-img" src="${getPhotoImageUrl(f.id, 'preview')}" alt="Pr&eacute;via de ${f.name}" />
        <div class="pmap__card-head">
            <span class="pmap__card-name">${f.name}</span>
            ${f.reviewed ? '<span class="pmap__badge pmap__badge--ok">REVISADA</span>' : '<span class="pmap__badge">PENDENTE</span>'}
        </div>
        <div class="pmap__card-sub">#${f.seq}${ehAtual ? ' &middot; aberta no visualizador' : ''}</div>
        <div class="pmap__angles">
            <div class="pmap__angle"><span>Y</span><strong>${grau(f.ry)}</strong></div>
            <div class="pmap__angle"><span>X</span><strong>${grau(f.rx)}</strong></div>
            <div class="pmap__angle"><span>Z</span><strong>${grau(f.rz)}</strong></div>
        </div>
        <button class="pmap__card-btn" data-acao="abrir" ${ehAtual ? 'disabled' : ''}>
            ${ehAtual ? 'J&aacute; est&aacute; nesta foto' : 'Entrar na foto'}
        </button>
    `;

    cardEl.querySelector('[data-acao="fechar"]').addEventListener('click', () => selecionar(null));
    const btn = cardEl.querySelector('[data-acao="abrir"]');
    if (btn && !ehAtual) {
        btn.addEventListener('click', () => onOpenPhotoCallback?.(f.id));
    }
}

function atualizarLegenda(stats) {
    let el = containerEl.querySelector('.pmap__legend');
    if (!el) {
        el = document.createElement('div');
        el.className = 'pmap__legend';
        containerEl.appendChild(el);
    }
    // Com andar em exibicao, o contador mede o ANDAR, nao o projeto. O mapa
    // mostra um andar so, e um total do projeto ao lado de 45 pontos na tela
    // seria uma segunda verdade sobre o que se esta vendo.
    const visiveis = fotosVisiveis();
    const filtrando = andarAtual !== null && andares.length > 0;
    const total = filtrando ? visiveis.length : (stats?.total ?? fotos.length);
    const revisadas = filtrando
        ? visiveis.filter(f => f.reviewed).length
        : (stats?.reviewed ?? fotos.filter(f => f.reviewed).length);
    const pct = total > 0 ? Math.round((revisadas / total) * 100) : 0;
    const escopo = filtrando
        ? ` no ${andares.find(a => a.level === andarAtual)?.label ?? andarAtual}`
        : '';

    el.innerHTML = `
        <button class="pmap__legend-close" title="Sair do mapa [M]">&larr; Voltar &agrave; foto</button>
        <div class="pmap__legend-stat">${revisadas}/${total} revisadas${escopo} (${pct}%)</div>
        <div class="pmap__legend-keys">
            <span><i style="background:${COR_REVISADA}"></i>revisada</span>
            <span><i style="background:${COR_PENDENTE}"></i>pendente</span>
            <span><i style="background:${COR_ATUAL}"></i>atual</span>
            <span><i class="pmap__legend-linha" style="background:${COR_TRACADO}"></i>trajeto</span>
        </div>
    `;
    el.querySelector('.pmap__legend-close').addEventListener('click', closeProjectMap);

    renderSeletorDeAndar();
}

/** Barra vertical de andares, do mais alto para o terreo. */
function renderSeletorDeAndar() {
    let el = containerEl.querySelector('.pmap__floors');

    if (andares.length === 0) {
        // Projeto sem andares nao ganha seletor. Se um projeto anterior o
        // criou, ele sai daqui, em vez de ficar na tela com os andares do
        // levantamento errado.
        if (el) el.remove();
        return;
    }

    if (!el) {
        el = document.createElement('div');
        el.className = 'pmap__floors';
        containerEl.appendChild(el);
        // Delegacao: os botoes sao reescritos a cada render, e um listener por
        // botao vazaria um a cada troca de andar.
        el.addEventListener('click', (ev) => {
            const alvo = ev.target.closest('.pmap__floor');
            if (alvo) trocarAndar(Number(alvo.dataset.level));
        });
    }

    el.innerHTML = andares.map(a => `
        <button class="pmap__floor${a.level === andarAtual ? ' pmap__floor--on' : ''}"
                data-level="${a.level}" title="${a.count} fotos">${a.label}</button>
    `).join('');
}

function mostrarErro(msg) {
    let el = containerEl.querySelector('.pmap__legend');
    if (!el) {
        el = document.createElement('div');
        el.className = 'pmap__legend';
        containerEl.appendChild(el);
    }
    // O botao de sair fica, senao o operador acaba preso num mapa vazio com o
    // viewer escondido atras dele.
    el.innerHTML = `
        <button class="pmap__legend-close" title="Sair do mapa [M]">&larr; Voltar &agrave; foto</button>
        <div class="pmap__legend-stat">Erro ao carregar o mapa: ${msg}</div>
    `;
    el.querySelector('.pmap__legend-close').addEventListener('click', closeProjectMap);
}
