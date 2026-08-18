/**
 * @fileoverview Three.js 360 panorama viewer for the calibration interface.
 * Renders an equirectangular photo on an inverted sphere with orbit-style controls.
 * Supports live mesh_rotation_y preview.
 *
 * A FONTE DA TEXTURA TEM DOIS CAMINHOS, e so isso. `loadProgressive` sonda o
 * `tiles.json` da foto e, se a piramide existir, compoe a panoramica por tiles
 * (ver tile-loader.js). So o ramo SEM piramide pede preview e full.
 *
 * A PIRAMIDE E A REGRA, E NAO A EXCECAO. Contadas nos 29 bancos
 * `{slug}_tiles.db` em 2026-08-18, TODAS as 99.035 fotos que a API serve tem
 * piramide. As 5 linhas de `photos` sem piramide estao em `deleted_photos`, e a
 * rota responde 404 nelas antes mesmo de chegar aqui (conferido nas cinco). O
 * 404 do `tiles.json` deixou de ser o caminho normal. Comentario que ainda
 * disser "28 dos 29 projetos nao tem tiles" esta vencido: era verdade no piloto,
 * e o acervo foi gerado depois.
 *
 * O QUE AINDA DIFERE ENTRE OS PROJETOS e a ESCADA, e nao a existencia da
 * piramide. So blumenau foi migrado para a escada que desce ate um tile, e o
 * nivel 0 dele e 1 objeto de 11 a 13 KB. Nos outros 28 a escada velha para em
 * 2048, e o nivel 0 sao 6 tiles (formato 5760) ou 8 tiles (formato 7680), de 40
 * a 291 KB. Os dois ramos abrem certo, porque o cliente le a grade do descritor
 * e nunca a deduz. O que muda e o PESO do primeiro quadro, e por isso a migracao
 * do acervo continua valendo a pena.
 *
 * O QUE NAO MUDA POR CAUSA DOS TILES: a esfera invertida, a ordem de rotacao
 * ZXY da malha, a camera YXZ e todo o overlay 2D. A UV tem de continuar
 * identica, e e por isso que o carregador entrega UMA textura de canvas, e nunca
 * uma grade de quadros. O codigo do marcador tem paridade numerica conferida
 * com o ebgeo_web, e trocar a fonte da textura nao pode encostar nele.
 */

import * as THREE from 'three';
import { createTileLoader } from './tile-loader.js';

// ============================================================================
// MODULE STATE
// ============================================================================

let camera, scene, renderer, sphere, material;
let containerEl, canvasEl;

// Camera orbit state (degrees)
let lon = 0;
let lat = 0;
let fov = 75;

// Drag state
let isDragging = false;
let dragStartX = 0;
let dragStartY = 0;
let dragStartLon = 0;
let dragStartLat = 0;
let pointerDownTime = 0;

// Perspective grid
let gridGroup = null;
let gridVisible = false;
// Materiais compartilhados das linhas do grid (descartados uma unica vez)
let gridNormalMat = null;
let gridEquatorMat = null;

// Animation
let animationFrameId = null;

// Dirty-checking do render Three.js: recomputa lookAt + render apenas quando
// algo muda (camera, textura, rotacao, fov, resize). O loop rAF continua, mas
// pula o trabalho redundante com a cena estatica. A saida visual e identica.
let needsRender = true;
let lastRenderLon = NaN;
let lastRenderLat = NaN;

// Reusable Vector3 for lookAt target (avoids allocation in render loop)
const _lookAtTarget = new THREE.Vector3();

// ---- Piramide de tiles -----------------------------------------------------

/**
 * O carregador de tiles da interface. E UM so, criado na primeira foto com
 * piramide e reaproveitado por todas as outras: ele guarda bitmaps, fila e
 * requisicoes em voo, e um por foto vazaria tudo isso a cada troca.
 */
let carregadorTiles = null;

/**
 * Textura de tiles esperando a primeira pintura para entrar na esfera.
 * Ver aplicarTexturaDeTiles: o canvas nasce em branco.
 */
let texturaTilesPendente = null;

// Reaproveitados a cada frame para converter a direcao da camera em coordenada
// da IMAGEM. Alocar no laco de render geraria lixo 60 vezes por segundo.
const _dirImagem = new THREE.Vector3();
const _rotacaoInversa = new THREE.Quaternion();

/**
 * Marca a cena como suja para forcar um novo render no proximo frame.
 */
function markNeedsRender() {
    needsRender = true;
}

// Callbacks
let onRenderCallback = null;
let onClickCallback = null;

// ============================================================================
// INITIALIZATION
// ============================================================================

/**
 * Initializes the Three.js panorama viewer.
 * @param {HTMLElement} container - DOM element to mount the viewer in
 * @param {Object} [options] - Options
 * @param {Function} [options.onRender] - Called each frame with { yaw, pitch, fov }
 * @param {Function} [options.onClick] - Called on click with { clientX, clientY }
 * @returns {{ canvas: HTMLCanvasElement }}
 */
export function initViewer(container, options = {}) {
    containerEl = container;
    onRenderCallback = options.onRender || null;
    onClickCallback = options.onClick || null;

    const width = container.clientWidth;
    const height = container.clientHeight;

    // Camera
    camera = new THREE.PerspectiveCamera(75, width / height, 0.1, 1000);
    camera.position.set(0, -0.1, 0);
    camera.rotation.order = 'YXZ';

    // Scene
    scene = new THREE.Scene();
    scene.add(camera);

    // Inverted sphere for 360 panorama
    const geometry = new THREE.SphereGeometry(500, 60, 40);
    geometry.scale(-1, 1, 1);

    material = new THREE.MeshBasicMaterial({ color: 0x111111 });

    sphere = new THREE.Mesh(geometry, material);
    sphere.rotation.order = 'ZXY';
    scene.add(sphere);

    // Renderer
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    // Limita o DPR a 2 (igual ao preview viewer), mesmo valor usado em onResize
    // para que o buffer nao mude de resolucao ao redimensionar.
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height);

    canvasEl = renderer.domElement;
    canvasEl.style.display = 'block';
    container.appendChild(canvasEl);

    // Events
    canvasEl.addEventListener('pointerdown', onPointerDown);
    canvasEl.addEventListener('pointermove', onPointerMove);
    canvasEl.addEventListener('pointerup', onPointerUp);
    canvasEl.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('resize', onResize);

    // A grade vive na cena, e dispose() destroi a cena a cada troca de foto.
    // gridVisible, porem, e estado de modulo e sobrevive de proposito, para a
    // preferencia do usuario nao se perder. Sem recriar a geometria aqui, a
    // caixa continuava marcada e a grade sumia, e so voltava apertando G duas
    // vezes.
    if (gridVisible) {
        createGridGeometry();
    }

    // Start render loop
    animate();

    return { canvas: canvasEl };
}

// ============================================================================
// TEXTURE LOADING
// ============================================================================

const textureLoader = new THREE.TextureLoader();

// Token de geracao para descartar carregamentos de textura obsoletos em
// navegacao rapida (foto A resolve depois de B nao deve sobrescrever B).
let loadGeneration = 0;

/**
 * Inicia uma nova geracao de carregamento e retorna seu id.
 * Chamado por loadProgressive para que preview+full compartilhem a geracao,
 * mas cargas de fotos diferentes invalidem as anteriores.
 * @returns {number}
 */
function nextLoadGeneration() {
    return ++loadGeneration;
}

/**
 * Loads a panorama image onto the sphere.
 * @param {string} url - Image URL
 * @param {boolean} [isPreview=false] - Whether this is a low-quality preview
 * @param {number} [generation] - Token de geracao; se informado e ja obsoleto
 *   quando a textura chega, a textura e descartada sem aplicar.
 * @returns {Promise<void>}
 */
export function loadPanorama(url, isPreview = false, generation = loadGeneration) {
    return new Promise((resolve, reject) => {
        textureLoader.load(
            url,
            (texture) => {
                texture.colorSpace = THREE.SRGBColorSpace;

                // Carga obsoleta (outra foto comecou a carregar): descarta.
                if (generation !== loadGeneration) {
                    texture.dispose();
                    resolve();
                    return;
                }

                // Don't replace full-quality texture with preview
                if (isPreview && material.map && material.map.userData?.isFull) {
                    texture.dispose();
                    resolve();
                    return;
                }

                // Dispoe a textura antiga antes de aplicar a nova
                descartarTexturaAtual();

                texture.userData = { isFull: !isPreview };
                material.map = texture;
                material.color.set(0xffffff);
                material.needsUpdate = true;
                markNeedsRender();
                resolve();
            },
            undefined,
            (err) => reject(err)
        );
    });
}

/**
 * Descarta a textura que esta na esfera, se ela for do viewer.
 *
 * A textura de TILES nao cai aqui. Enquanto o carregador a compoe o dono e ele,
 * que ja descarta a anterior sozinho a cada troca de nivel; descartar dos dois
 * lados mataria a mesma textura duas vezes. `soltarFoto` devolve a posse e
 * limpa a marca, e ai a orfa passa por este caminho como qualquer outra.
 */
function descartarTexturaAtual() {
    const antiga = material?.map;
    if (!antiga) return;
    if (antiga.userData?.deTiles) return;
    antiga.dispose();
}

/**
 * Cria, uma unica vez, o carregador de tiles desta interface.
 *
 * Tardio de proposito: ele le MAX_TEXTURE_SIZE do contexto WebGL, que so existe
 * depois de initViewer montar o renderer.
 *
 * @returns {Object|null} o carregador, ou null se o viewer ainda nao subiu
 */
function garantirCarregadorTiles() {
    if (carregadorTiles) return carregadorTiles;
    if (!renderer) return null;

    carregadorTiles = createTileLoader({
        gl: renderer.getContext(),
        onTextura: (textura) => {
            // A textura NAO entra na esfera aqui. O canvas acaba de nascer em
            // branco, e aplica-lo agora apagaria a foto anterior por um quadro
            // vazio. Fica pendente ate o nivel 0 pintar nele.
            //
            // ISTO PESA MAIS DESDE QUE O PREVIEW SAIU. Antes o preview cobria
            // essa janela, e aplicar cedo custava pouco. Agora e a foto anterior
            // que segura a tela sozinha, e trocar antes da hora seria a unica
            // coisa entre o operador e uma esfera vazia.
            //
            // `isFull` verdadeiro porque a esfera composta por tiles vale pelo
            // full: sem esta marca, um preview atrasado da foto anterior
            // rebaixaria a imagem ja detalhada.
            textura.userData = { isFull: true, deTiles: true };
            texturaTilesPendente = textura;
        },
        onEstatisticas: (estat) => {
            // Ha pintura no canvas: agora ele pode substituir a esfera. O
            // carregador publica estatistica depois de cada tile, e o primeiro a
            // chegar e o de nivel 0, entao este e o primeiro instante seguro.
            if (texturaTilesPendente && estat.msPrimeiraPintura !== null) {
                aplicarTexturaDeTiles();
            }
        },
    });

    // Cache HTTP normal, e nao o `no-store` com que o carregador nasce. Aquele
    // existe para o piloto medir rede; aqui o tile sai `immutable` por um ano e
    // reler do disco e exatamente o ganho que se quer.
    carregadorTiles.ignorarCache('default');
    return carregadorTiles;
}

/**
 * Poe a textura de tiles na esfera, no lugar da anterior.
 * Herda o que o caminho do full ja acertou: descarta a antiga, acende o
 * material com branco (ele nasce 0x111111) e suja a cena uma vez.
 */
function aplicarTexturaDeTiles() {
    const nova = texturaTilesPendente;
    texturaTilesPendente = null;
    if (!material || !nova) return;

    descartarTexturaAtual();
    material.map = nova;
    material.color.set(0xffffff);
    material.needsUpdate = true;
    markNeedsRender();
}

/**
 * Larga a foto do carregador de tiles e recolhe a textura que ele renuncia.
 * Chamado quando a piramide nao existe, ou falhou, e a esfera volta ao full.
 */
function largarTiles() {
    texturaTilesPendente = null;
    if (!carregadorTiles) return;

    const orfa = carregadorTiles.soltarFoto();
    if (!orfa) return;
    if (material && material.map === orfa) {
        // Ainda na esfera: a posse volta para o viewer, e quem a descarta e o
        // loadPanorama do full, ao tomar o lugar dela. Descartar agora deixaria
        // uma textura morta na tela durante a carga inteira do full.
        orfa.userData.deTiles = false;
        return;
    }
    orfa.dispose();
}

/**
 * Le o uuid da foto na URL da imagem.
 *
 * O viewer recebe URLs prontas, e nao o id. Ler o uuid daqui evita mudar a
 * assinatura de quem chama, e o `photoId` explicito continua tendo precedencia.
 *
 * @param {string} url - URL no formato /photos/{uuid}/image?quality=...
 * @returns {string|null} o uuid, ou null se a URL nao tiver esse formato
 */
function uuidDaUrlDeImagem(url) {
    const achado = /\/photos\/([^/?#]+)\/image/.exec(String(url));
    return achado ? achado[1] : null;
}

/**
 * Tenta compor a panoramica pela piramide de tiles.
 *
 * @param {string|null} photoId - uuid da foto
 * @param {number} generation - token da carga que pediu
 * @returns {Promise<boolean>} true quando o full NAO deve ser carregado, ou
 *   porque os tiles assumiram, ou porque uma carga mais nova mandou
 */
async function tentarTiles(photoId, generation) {
    const carregador = garantirCarregadorTiles();
    if (!carregador || !photoId) return false;

    try {
        // Devolve o descritor, ou null quando outra foto tomou o lugar desta no
        // meio do caminho. Os dois casos mandam a mesma coisa aqui: o full desta
        // carga nao entra, ou desenharia a foto velha por cima da nova.
        await carregador.carregarFoto(photoId);
        return true;
    } catch (err) {
        // Carga obsoleta: o carregador ja e de outra foto, e mexer nele agora
        // atrapalharia quem chegou depois. O abort da foto anterior tambem cai
        // aqui, e e este o ramo certo para ele.
        if (generation !== loadGeneration) return true;

        // O 404 DEIXOU DE SER O CAMINHO NORMAL, mas continua legitimo: foto
        // recem-importada nao tem piramide ate o gerador rodar. Legitimo nao
        // merece barulho no console, entao so o resto avisa.
        if (err?.status !== 404) {
            console.warn('Falha ao carregar tiles, caindo no full:', err);
        }
        largarTiles();
        return false;
    }
}

/**
 * Carrega uma foto: piramide de tiles, ou preview mais full quando nao houver.
 *
 * A SONDA VEM PRIMEIRO, E SOZINHA. O preview so pode ser pedido no ramo SEM
 * piramide, porque `preview_webp` vai ser apagado do banco e a interface nao
 * pode depender de um dado que deixa de existir. Com piramide, quem pinta o
 * primeiro quadro e o carregador de tiles, pelo nivel 0.
 *
 * A ORDEM SE INVERTEU, e o motivo e uma medida. Antes a sonda partia junto do
 * preview, para nao atrasar o full "de todo mundo" numa volta de rede. Aquele
 * "todo mundo" nao existe mais: toda foto que a API serve tem piramide, entao a
 * sonda responde 200, e nao 404. Pedir o preview em paralelo baixaria um objeto
 * que nunca chega a ser usado.
 *
 * O QUE ISSO CUSTA, medido e nao estimado. O primeiro quadro passa a depender
 * de DUAS voltas de rede em sequencia (o `tiles.json`, depois o tile de nivel
 * 0), contra UMA do preview. Medido em blumenau, 12 cargas por celula, cache
 * desligado, primeira subida de textura a GPU:
 *   latencia 0 (loopback): 101 ms antes, 119 ms depois  (+18)
 *   latencia 30 ms:        108 ms antes, 137 ms depois  (+29)
 *   latencia 80 ms:        108 ms antes, 210 ms depois  (+102)
 *   latencia 200 ms:       231 ms antes, 453 ms depois  (+222)
 * O custo E a volta de rede a mais, e nao bytes: ele acompanha a latencia quase
 * um por um. Em rede de quartel isso nao aparece; num enlace ruim aparece.
 *
 * A CONTA SO FECHA PORQUE O NIVEL 0 E PEQUENO. Em blumenau ele e 1 tile de 11 a
 * 13 KB, contra 16 KB do preview. Nos 28 projetos que ainda estao na escada
 * velha o nivel 0 sao 6 ou 8 tiles, de 40 a 291 KB, e ali a segunda volta de
 * rede ainda carrega dez vezes mais bytes. Migrar o acervo fecha essa ponta.
 *
 * @param {string} previewUrl - URL do preview. So o ramo sem piramide a usa
 * @param {string} fullUrl - URL da imagem inteira
 * @param {string} [photoId] - uuid da foto. Sem ele, sai da propria fullUrl
 */
export async function loadProgressive(previewUrl, fullUrl, photoId = null) {
    // Nova geracao: invalida qualquer carga anterior ainda em voo.
    const generation = nextLoadGeneration();

    if (await tentarTiles(photoId || uuidDaUrlDeImagem(fullUrl), generation)) return;

    // Daqui para baixo a foto NAO tem piramide. Hoje NENHUMA foto servida cai
    // aqui, e o ramo existe para a foto recem-importada, que passa por aqui
    // ate o gerador rodar.
    //
    // O preview segura a tela enquanto o full chega. Ele sobrevive so neste
    // ramo, e morre junto do `preview_webp` quando a importacao passar a gerar
    // a piramide antes de publicar a foto.
    try {
        await loadPanorama(previewUrl, true, generation);
    } catch {
        // Preview falhou: vai direto ao full.
    }

    try {
        await loadPanorama(fullUrl, false, generation);
    } catch (err) {
        console.error('Failed to load full panorama:', err);
    }
}

// ============================================================================
// MESH ROTATION
// ============================================================================

/**
 * Sets the mesh rotation Y (live preview for calibration slider).
 * @param {number} degrees - Rotation in degrees (0-360)
 */
export function setMeshRotationY(degrees) {
    if (sphere) {
        sphere.rotation.y = THREE.MathUtils.degToRad(degrees);
    }
    markNeedsRender();
}

/**
 * Sets the mesh rotation X (pitch tilt for calibration).
 * @param {number} degrees - Rotation in degrees (-30 to +30)
 */
export function setMeshRotationX(degrees) {
    if (sphere) {
        sphere.rotation.x = THREE.MathUtils.degToRad(degrees);
    }
    markNeedsRender();
}

/**
 * Sets the mesh rotation Z (roll tilt for calibration).
 * @param {number} degrees - Rotation in degrees (-30 to +30)
 */
export function setMeshRotationZ(degrees) {
    if (sphere) {
        sphere.rotation.z = THREE.MathUtils.degToRad(degrees);
    }
    markNeedsRender();
}

// ============================================================================
// CAMERA CONTROL
// ============================================================================

/**
 * Sets the camera to look at a specific heading.
 * @param {number} heading - Heading in degrees (0-360, 0 = North)
 */
export function setHeading(heading) {
    lon = heading;
}

/**
 * Gets the camera's current heading, relative to the image centre.
 *
 * Needed to carry the viewing direction across a photo change: the world
 * direction being looked at is imageHeading + this.
 *
 * @returns {number} Heading in degrees
 */
export function getHeading() {
    return lon;
}

/**
 * Gets the canvas element.
 * @returns {HTMLCanvasElement}
 */
export function getCanvas() {
    return canvasEl;
}

// ============================================================================
// INPUT HANDLERS
// ============================================================================

function onPointerDown(e) {
    isDragging = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    dragStartLon = lon;
    dragStartLat = lat;
    pointerDownTime = performance.now();
    canvasEl.setPointerCapture(e.pointerId);
}

function onPointerMove(e) {
    if (!isDragging) return;

    const dx = e.clientX - dragStartX;
    const dy = e.clientY - dragStartY;

    // Scale rotation by FOV for consistent feel at different zoom levels
    const baseSensitivity = 0.1;
    const fovFactor = fov / 75;
    const sensitivity = baseSensitivity * fovFactor;
    lon = dragStartLon - dx * sensitivity;
    lat = dragStartLat + dy * sensitivity;

    // Clamp vertical look
    lat = Math.max(-85, Math.min(85, lat));
}

function onPointerUp(e) {
    const wasDragging = isDragging;
    isDragging = false;

    if (!wasDragging) return;

    // Detect click vs drag
    const dx = Math.abs(e.clientX - dragStartX);
    const dy = Math.abs(e.clientY - dragStartY);
    const elapsed = performance.now() - pointerDownTime;

    if (dx < 5 && dy < 5 && elapsed < 300) {
        // This was a click
        if (onClickCallback) {
            const rect = canvasEl.getBoundingClientRect();
            onClickCallback({
                clientX: e.clientX - rect.left,
                clientY: e.clientY - rect.top,
            });
        }
    }
}

function onWheel(e) {
    e.preventDefault();
    fov += e.deltaY * 0.05;
    fov = Math.max(10, Math.min(75, fov));
    if (camera) {
        camera.fov = fov;
        camera.updateProjectionMatrix();
    }
    markNeedsRender();
}

function onResize() {
    if (!containerEl || !camera || !renderer) return;
    const width = containerEl.clientWidth;
    const height = containerEl.clientHeight;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    // Reaplica o devicePixelRatio (pode mudar ao trocar de monitor/zoom),
    // limitado a 2 como no preview viewer. setPixelRatio antes de setSize.
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height);
    markNeedsRender();
}

// ============================================================================
// RENDER LOOP
// ============================================================================

/**
 * Diz ao carregador de tiles para onde a camera olha, em coordenada da IMAGEM.
 *
 * A CONVERSAO E OBRIGATORIA, e nao um refinamento. A esfera carrega as rotacoes
 * da calibracao (mesh_rotation_y vale 180 por padrao), entao o lon da camera e
 * a longitude da equirretangular diferem por essa rotacao: entregar o lon cru
 * pediria a coluna oposta de tiles, e a tela ficaria borrada no preview
 * enquanto o detalhe chegava nas costas do operador. Desfazer a rotacao da
 * malha resolve os tres eixos de uma vez, e nao so o Y.
 *
 * A geometria ja nasce espelhada em X, e com a esfera sem rotacao a UV da
 * SphereGeometry casa u = lon/360 exatamente, que e o que o demo usa.
 *
 * Chamado a cada frame: a comparacao la dentro e barata e o recalculo pesado
 * fica no debounce do carregador.
 */
function informarCameraAoTiles() {
    if (!carregadorTiles || !sphere || !renderer) return;

    const phi = THREE.MathUtils.degToRad(90 - lat);
    const theta = THREE.MathUtils.degToRad(lon);
    _dirImagem.set(
        Math.sin(phi) * Math.cos(theta),
        Math.cos(phi),
        Math.sin(phi) * Math.sin(theta),
    );
    _rotacaoInversa.copy(sphere.quaternion).invert();
    _dirImagem.applyQuaternion(_rotacaoInversa);

    // O acos pede o argumento preso em [-1, 1]: erro de ponto flutuante devolve
    // 1.0000000000000002 no zenite e NaN sai daqui contaminando a escolha.
    const y = Math.min(1, Math.max(-1, _dirImagem.y));
    const latImagem = 90 - THREE.MathUtils.radToDeg(Math.acos(y));
    const lonImagem = THREE.MathUtils.radToDeg(Math.atan2(_dirImagem.z, _dirImagem.x));

    // A largura do BUFFER, que ja inclui o devicePixelRatio, e nao a do
    // container: e o numero que a conta de largura necessaria pede.
    //
    // E AQUI QUE O ZOOM MANDA NO NIVEL. A fov cai de 75 para 10, a largura
    // necessaria cresce quase sete vezes, e o carregador sobe de nivel assim
    // que a histerese dele solta. Sem esta linha o zoom da calibracao ficaria
    // borrado justo onde o full de hoje mostra detalhe.
    carregadorTiles.atualizarCamera({
        lon: lonImagem,
        lat: latImagem,
        fov,
        largura: renderer.domElement.width,
        altura: renderer.domElement.height,
    });
}

function animate() {
    animationFrameId = requestAnimationFrame(animate);

    if (!camera || !scene || !renderer) return;

    informarCameraAoTiles();

    // Uma unica subida de textura por frame: por tile, cada needsUpdate
    // reenviaria o canvas inteiro para a GPU. Ela suja a cena porque o render
    // so acontece quando a camera mexe, e tile que chega com a camera parada
    // ficaria invisivel ate o operador encostar no mouse.
    if (carregadorTiles?.aplicarAtualizacoes()) {
        needsRender = true;
    }

    // Render Three.js apenas quando a camera mudou ou a cena ficou suja.
    // O onRenderCallback continua sendo chamado todo frame: o overlay do
    // navigator tem seu proprio dirty-check e precisa reagir ao mouse, que o
    // viewer nao rastreia. Pular o render aqui mantem o ultimo frame valido.
    const cameraMoved = lon !== lastRenderLon || lat !== lastRenderLat;
    if (needsRender || cameraMoved) {
        // Update camera from lon/lat (matching EBGeo's explicit spherical math)
        const phi = THREE.MathUtils.degToRad(90 - lat);
        const theta = THREE.MathUtils.degToRad(lon);

        _lookAtTarget.set(
            500 * Math.sin(phi) * Math.cos(theta),
            500 * Math.cos(phi),
            500 * Math.sin(phi) * Math.sin(theta)
        );
        camera.lookAt(_lookAtTarget);

        renderer.render(scene, camera);

        needsRender = false;
        lastRenderLon = lon;
        lastRenderLat = lat;
    }

    // Notify render callback with camera state
    if (onRenderCallback) {
        const yawRad = THREE.MathUtils.degToRad(lon);
        const pitchRad = THREE.MathUtils.degToRad(lat);
        onRenderCallback({ yaw: yawRad, pitch: pitchRad, fov });
    }
}

// ============================================================================
// PERSPECTIVE GRID
// ============================================================================

const GRID_RADIUS = 499;
const GRID_PARALLELS = [
    -80, -70, -60, -50, -40, -30, -20, -10,
    0,
    10, 20, 30, 40, 50, 60, 70, 80,
];
const GRID_MERIDIANS = [
    0, 15, 30, 45, 60, 75, 90, 105,
    120, 135, 150, 165, 180, 195, 210, 225,
    240, 255, 270, 285, 300, 315, 330, 345,
];

/**
 * Creates the perspective grid geometry (parallels + meridians on the sphere).
 * Added directly to the scene so lines stay fixed when mesh rotations change.
 * This makes the grid a stable reference: the image moves, the lines don't.
 */
function createGridGeometry() {
    gridGroup = new THREE.Group();

    gridNormalMat = new THREE.LineBasicMaterial({
        color: 0x00c8ff, transparent: true, opacity: 0.35, depthTest: false,
    });
    gridEquatorMat = new THREE.LineBasicMaterial({
        color: 0x00ff88, transparent: true, opacity: 0.7, depthTest: false,
    });

    for (const lat of GRID_PARALLELS) {
        const mat = lat === 0 ? gridEquatorMat : gridNormalMat;
        gridGroup.add(createParallelLine(lat, GRID_RADIUS, mat));
    }

    for (const lon of GRID_MERIDIANS) {
        gridGroup.add(createMeridianLine(lon, GRID_RADIUS, gridNormalMat));
    }

    scene.add(gridGroup);
}

/**
 * Creates a latitude circle (parallel) on the sphere.
 * @param {number} latDeg - Latitude in degrees
 * @param {number} radius - Sphere radius
 * @param {THREE.LineBasicMaterial} mat - Line material
 * @returns {THREE.Line}
 */
function createParallelLine(latDeg, radius, mat) {
    const latRad = THREE.MathUtils.degToRad(latDeg);
    const cosLat = Math.cos(latRad);
    const sinLat = Math.sin(latRad);
    const points = [];
    const segments = 72;
    for (let i = 0; i <= segments; i++) {
        const lonRad = (i / segments) * Math.PI * 2;
        points.push(new THREE.Vector3(
            radius * cosLat * Math.sin(lonRad),
            radius * sinLat,
            radius * cosLat * Math.cos(lonRad),
        ));
    }
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    return new THREE.Line(geometry, mat);
}

/**
 * Creates a longitude half-circle (meridian) on the sphere.
 * @param {number} lonDeg - Longitude in degrees
 * @param {number} radius - Sphere radius
 * @param {THREE.LineBasicMaterial} mat - Line material
 * @returns {THREE.Line}
 */
function createMeridianLine(lonDeg, radius, mat) {
    const lonRad = THREE.MathUtils.degToRad(lonDeg);
    const sinLon = Math.sin(lonRad);
    const cosLon = Math.cos(lonRad);
    const points = [];
    const segments = 36;
    for (let i = 0; i <= segments; i++) {
        const latRad = THREE.MathUtils.degToRad(-80 + (i / segments) * 160);
        points.push(new THREE.Vector3(
            radius * Math.cos(latRad) * sinLon,
            radius * Math.sin(latRad),
            radius * Math.cos(latRad) * cosLon,
        ));
    }
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    return new THREE.Line(geometry, mat);
}

/**
 * Shows or hides the perspective grid overlay.
 * @param {boolean} visible - Whether to show the grid
 */
export function setGridVisible(visible) {
    gridVisible = visible;
    if (visible && !gridGroup && scene) {
        createGridGeometry();
    }
    if (gridGroup) {
        gridGroup.visible = visible;
    }
    markNeedsRender();
}

/**
 * Returns whether the perspective grid is currently visible.
 * @returns {boolean}
 */
export function isGridVisible() {
    return gridVisible;
}

// ============================================================================
// CLEANUP
// ============================================================================

/**
 * Disposes of the viewer and releases GPU resources.
 */
export function dispose() {
    if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
    }

    if (canvasEl) {
        canvasEl.removeEventListener('pointerdown', onPointerDown);
        canvasEl.removeEventListener('pointermove', onPointerMove);
        canvasEl.removeEventListener('pointerup', onPointerUp);
        canvasEl.removeEventListener('wheel', onWheel);
    }

    window.removeEventListener('resize', onResize);

    if (gridGroup) {
        // Dispoe apenas as geometrias por linha; os 2 materiais sao
        // compartilhados e descartados uma unica vez abaixo.
        gridGroup.traverse((child) => {
            if (child.geometry) child.geometry.dispose();
        });
        gridGroup = null;
    }
    gridNormalMat?.dispose();
    gridEquatorMat?.dispose();
    gridNormalMat = null;
    gridEquatorMat = null;

    // O carregador de tiles sai ANTES da textura: `dispose()` dele descarta a
    // textura que ainda for dele, e `descartarTexturaAtual` respeita essa posse.
    // Invertida, a ordem mataria a mesma textura duas vezes.
    if (carregadorTiles) {
        carregadorTiles.dispose();
        carregadorTiles = null;
    }
    texturaTilesPendente = null;

    descartarTexturaAtual();
    material?.dispose();
    sphere?.geometry.dispose();
    renderer?.dispose();

    scene = null;
    camera = null;
    renderer = null;
    sphere = null;
    material = null;
}

/**
 * Force a resize recalculation (useful after layout changes).
 */
export function forceResize() {
    onResize();
}
