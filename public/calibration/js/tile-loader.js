/**
 * @fileoverview Carregador da piramide de tiles 360 (piloto).
 * Le o descritor `tiles.json` de uma foto, compoe os tiles num canvas 2D e
 * entrega uma unica THREE.CanvasTexture para a esfera do visualizador.
 *
 * Uma textura so, e nao um plano por tile, porque a UV da SphereGeometry ja
 * mapeia a equirretangular inteira. Trocar a geometria por uma grade de quadros
 * obrigaria a recalcular UV, costura e polos, e o piloto so quer medir bytes e
 * tempo, nao reescrever a projecao.
 *
 * A MATEMATICA NAO MORA AQUI. Escada de niveis, largura necessaria, escolha de
 * nivel e conjunto de tiles visiveis vem de `pyramid-math.js`. Este arquivo ja
 * teve copia local das quatro contas, e a copia do conjunto visivel divergia
 * 2,2x da usada pelo benchmark: o numero que decidia o piloto saia de um
 * instrumento, e a producao pedia outro. Quem mudar a conta muda la.
 *
 * Contrato seguido ao pe da letra: `level` 0 e o mais grosso, origem top-left,
 * borda recortada, `wrapX` do lado do cliente, e template relativo ao proprio
 * documento `tiles.json`.
 *
 * DOIS CONSUMIDORES, e nao mais so o demo: `tile-demo.html`, que compara tiles
 * contra o full, e `viewer.js`, a interface de calibracao. O que os dois
 * precisam saber e a POSSE DA TEXTURA, porque descartar em dobro mata a esfera
 * em silencio:
 *   - `onTextura` entrega a textura nova. A anterior DESTE carregador ja foi
 *     descartada aqui dentro, em `reconstruirCanvas`. Quem recebe nao a descarta.
 *   - `soltarFoto()` devolve a posse: ele para tudo, esquece o descritor e
 *     entrega a ultima textura viva. Dali em diante quem descarta e o chamador.
 *   - `dispose()` descarta a textura que ainda for dele.
 *
 * O FUNDO E ESTRATEGIA, e nao regra fixa. A primeira versao baixava o preview E
 * o nivel 0 inteiro para a mesma funcao: 13,0 KB mais 139,3 KB, ou 10,7x o
 * preview, o que sozinho levava a foto de 553 KB para 686 KB. Google, Photo
 * Sphere Viewer e Marzipano usam UMA imagem base borrada e depois os tiles. Aqui
 * os tres desenhos convivem sob `ESTRATEGIAS_FUNDO`, porque o piloto existe para
 * MEDIR qual deles ganha, e nao para decretar.
 */

import * as THREE from 'three';
import {
    escolherNivel,
    larguraNecessaria,
    tilesVisiveis,
} from './pyramid-math.js';

/** Margem, em tiles, ao redor do que a camera enxerga no nivel ALVO. */
const MARGEM_TILES = 1;

/**
 * Margem, em tiles, ao redor do que a camera enxerga no nivel de FUNDO.
 *
 * ZERO, e nao MARGEM_TILES. Margem se conta em tiles, e o mesmo tile vale
 * angulos diferentes em cada nivel: no alvo de 7680 um tile de 512 e 6,7% da
 * volta, no nivel 0 de 1920 ele e 26,7%. Medido em 7680x3840, tile 512, nas duas
 * telas do piloto (1350x673 e 1904x985) e nas fovs 75, 40 e 20: com margem 1 o
 * conjunto visivel do nivel 0 da 8 de 8 tiles em TODOS os casos, ou seja
 * 'nivel0vis' viraria 'nivel0' sem economizar um byte. Com margem 0 ele pede 4
 * de 8.
 *
 * Zero nao abre buraco preto. O preview ja esta pintado embaixo, entao arrastar
 * para fora do fundo grosso cai no preview, que e exatamente o desenho da
 * estrategia 'preview'. A degradacao e de nitidez, nunca de imagem faltando.
 */
const MARGEM_FUNDO = 0;

/**
 * Os tres desenhos de fundo que o piloto compara.
 *
 * - `preview`: so a imagem base de 13,0 KB, esticada. E o que Google, Photo
 *   Sphere Viewer e Marzipano fazem.
 * - `nivel0vis`: o preview mais SO os tiles do nivel 0 que a camera enxerga.
 * - `nivel0`: o preview mais o nivel 0 inteiro. E o desenho da primeira versao,
 *   mantido para a comparacao ter a linha de base medida no mesmo relogio.
 * @constant {string[]}
 */
export const ESTRATEGIAS_FUNDO = ['preview', 'nivel0vis', 'nivel0'];

/**
 * Estrategia de fundo padrao.
 *
 * E 'preview', decidido pela medida de parede. Ela venceu 'nivel0vis' e
 * 'nivel0' em BYTES e em TEMPO, e o comentario anterior, que defendia o nivel 0
 * visivel, era argumento sem numero.
 *
 * O QUE A MEDIDA COBRIU: a CARGA da foto, ate a primeira pintura e ate o nivel
 * alvo fechar. Ela NAO mediu arrasto. A objecao antiga continua de pe no papel
 * (o preview de 512x256 estica 15 vezes sobre um alvo de 7680, e arrastar rapido
 * mostra borrao ate o debounce pedir os finos), e quem quiser reabrir a
 * comparacao troca a estrategia, que segue selecionavel. O que nao vale mais e
 * pagar o fundo grosso em toda carga por causa de um custo que ninguem mediu.
 * @constant {string}
 */
export const ESTRATEGIA_FUNDO_PADRAO = 'preview';

/** Espera de camera parada antes de recalcular nivel e tiles visiveis (ms). */
const DEBOUNCE_MS = 120;

/** Banda morta da troca de nivel, conforme o contrato. */
const HISTERESE = 1.3;

/**
 * Requisicoes de tile simultaneas.
 *
 * VINTE E QUATRO, e nao doze, porque 24 e o numero que o piloto esta medindo. A
 * medida que justifica a piramide foi feita em producao, atras do nginx com
 * HTTP/2: 24 objetos de 11 a 21 KB em paralelo chegam em 43 ms, contra 375 ms
 * de um full de 2,51 MB. Com 12 em voo a mesma rajada vira DUAS ondas, o tempo
 * de parede soma duas latencias em vez de uma, e o demo mediria um desenho que
 * ninguem propos. O servidor nao enfileira tile de proposito (ver phototiles.js).
 */
const MAX_PARALELO = 24;

/**
 * Janela minima entre duas subidas de textura, em milissegundos.
 *
 * O `needsUpdate` do three re-especifica a textura INTEIRA, entao subir por
 * tile que chega custa o canvas inteiro por tile. Com 120 ms uma rajada de
 * tiles vira poucos uploads, e o olho nao distingue a diferenca: 120 ms sao
 * cerca de sete frames, e a foto leva bem mais que isso para completar.
 *
 * Nao suba este numero achando que economiza mais: acima de uns 200 ms a
 * chegada dos tiles comeca a parecer travada, que e o defeito oposto.
 * @constant {number}
 */
const MS_ENTRE_UPLOADS = 120;

/** Teto de bitmaps guardados em memoria (512x512 RGBA = 1 MB cada). */
const MAX_TILES_EM_CACHE = 256;

/**
 * Teto de lado de canvas do navegador. O Chrome recusa acima de 16384 e devolve
 * um canvas em branco, sem lancar excecao. Entra junto do MAX_TEXTURE_SIZE.
 */
const LIMITE_CANVAS = 16384;

/**
 * Bytes que a REDE entregou nesta resposta.
 *
 * O `Content-Length` vem primeiro porque e o tamanho no fio, que e o numero que
 * o piloto compara com o full. O `byteLength` do buffer ja e o corpo DEPOIS de
 * desfeito o transfer-encoding, entao ele infla qualquer coisa que o servidor
 * tenha comprimido. Sem o cabecalho (chunked, ou CORS que nao o expoe) o buffer
 * e a melhor medida que existe, e continua sendo medida, nunca estimativa.
 *
 * Fica EXPORTADO porque o comparativo com o full conta os bytes dele do lado do
 * demo. Duas contagens escritas em dois arquivos foi exatamente o defeito que
 * `pyramid-math.js` fechou, e ele nao volta pela porta dos bytes.
 *
 * @param {Response} resposta
 * @param {ArrayBuffer} buffer
 * @returns {number}
 */
export function bytesDaResposta(resposta, buffer) {
    const cabecalho = Number(resposta.headers.get('content-length'));
    return Number.isFinite(cabecalho) && cabecalho > 0 ? cabecalho : buffer.byteLength;
}

/**
 * Raiz da API deduzida do endereco desta pagina.
 *
 * `/api/v1` fixo so funciona na raiz do dominio. Em producao o servico vive
 * atras de `location /ebgeo_360/`, entao a interface abre em
 * `/ebgeo_360/calibration/...` e a API responde em `/ebgeo_360/api/v1/...`. O
 * descritor ja resolve `base` e `template` de forma relativa pela mesma razao.
 * O corte e o segmento `/calibration/`, que e o prefixo com que o servidor
 * publica esta pasta.
 *
 * @param {string} [caminho=location.pathname] - Caminho da pagina atual.
 * @returns {string} Raiz da API, sem barra no fim.
 */
export function raizDaApi(caminho = location.pathname) {
    const corte = caminho.lastIndexOf('/calibration/');
    const prefixo = corte > 0 ? caminho.slice(0, corte) : '';
    return `${prefixo}/api/v1`;
}

/**
 * Cria um carregador de tiles. E uma fabrica, e nao estado de modulo como o
 * resto da interface, porque o demo compara dois carregamentos na mesma pagina.
 *
 * @param {Object} opcoes
 * @param {WebGLRenderingContext|WebGL2RenderingContext} opcoes.gl - contexto do
 *   renderer, usado so para ler MAX_TEXTURE_SIZE
 * @param {string} [opcoes.base] - raiz da API. Sem ela, sai de `raizDaApi()`
 * @param {(textura: THREE.CanvasTexture) => void} [opcoes.onTextura] - chamado
 *   quando o canvas e recriado e a textura anterior deixa de valer
 * @param {(estat: Object) => void} [opcoes.onEstatisticas] - instrumentacao viva
 * @param {(msg: string) => void} [opcoes.onLog] - log opcional do demo
 * @param {string} [opcoes.estrategiaFundo] - um de ESTRATEGIAS_FUNDO. Vale para
 *   toda foto desta instancia, e cada `carregarFoto` pode sobrescrever
 * @returns {Object} API do carregador
 */
export function createTileLoader({
    gl,
    base,
    onTextura,
    onEstatisticas,
    onLog,
    estrategiaFundo = ESTRATEGIA_FUNDO_PADRAO,
} = {}) {
    // MAX_TEXTURE_SIZE e a promessa do driver. Acima dela o upload da textura
    // falha em silencio (a esfera fica preta e so um erro de WebGL aparece no
    // console), entao o canvas nunca pode passar desse valor: quando o nivel
    // escolhido for maior, o tile e desenhado reduzido pela mesma escala e a
    // panoramica continua inteira, so com menos detalhe.
    const maxTextura = Math.min(
        gl ? gl.getParameter(gl.MAX_TEXTURE_SIZE) : LIMITE_CANVAS,
        LIMITE_CANVAS,
    );

    /** Raiz da API desta instancia, fixada na criacao. */
    const raizApi = base || raizDaApi();

    let descritor = null;
    let niveis = [];
    let escada = [];
    let urlDescritor = null;
    let uuidAtual = null;

    let canvas = null;
    let ctx = null;
    let textura = null;
    let texturaSuja = false;
    // Relogio do agrupamento de uploads. Zero significa que ainda nao houve
    // upload nesta foto, e o primeiro sempre passa direto: e ele que tira a
    // tela do preview borrado.
    let ultimoUpload = 0;

    let nivelAtual = null;
    let nivelFixo = null;

    /** Bitmaps ja decodificados, por `nivel/x/y`. */
    const cache = new Map();
    /** Chaves ja desenhadas no canvas atual. Zera a cada canvas novo. */
    let desenhados = new Set();
    /** Preview esticado, guardado para repintar o fundo sem baixar de novo. */
    let bitmapPreview = null;

    let geracao = 0;
    let controlador = null;

    let camera = { lon: 0, lat: 0, fov: 75, largura: 1920, altura: 1080 };
    let temporizador = null;

    const fila = [];
    /**
     * Chaves `geracao/nivel/x/y` que ja sairam da fila e ainda nao voltaram.
     *
     * Sem este conjunto a deduplicacao tem um buraco: o item que `bombear()`
     * tirou da fila nao esta em `desenhados`, nem no `cache`, nem na `fila`, e o
     * proximo `pedirTiles` o baixa de novo. Arrastar, parar, arrastar e parar
     * dobrava os requests, justamente o numero que o piloto quer medir. A
     * geracao entra na chave porque trocar de foto nao muda `nivel/x/y`, e uma
     * chave orfa da foto anterior bloquearia o tile da foto nova.
     */
    const chavesEmVoo = new Set();
    let emVoo = 0;
    let alvoPendente = 0;

    /**
     * Modo de cache HTTP de toda busca. Comeca em `no-store` porque o piloto
     * mede rede: ver `ignorarCache`.
     */
    let modoCache = 'no-store';

    /** Estrategia de fundo em vigor. Uma foto pode pedir outra. */
    let fundoAtual = estrategiaDeFundoValida(estrategiaFundo);

    let estat = zerarEstatisticas();

    /**
     * Devolve a estrategia pedida, ou a padrao quando o nome nao existe.
     * Nome errado nao pode virar fundo silenciosamente diferente: o piloto
     * compararia duas execucoes rotuladas igual.
     * @param {string} nome
     * @returns {string}
     */
    function estrategiaDeFundoValida(nome) {
        if (ESTRATEGIAS_FUNDO.includes(nome)) return nome;
        log(`estrategia de fundo "${nome}" desconhecida, usando ${ESTRATEGIA_FUNDO_PADRAO}`);
        return ESTRATEGIA_FUNDO_PADRAO;
    }

    function zerarEstatisticas() {
        return {
            inicio: 0,
            nivel: null,
            larguraNecessaria: 0,
            // O rotulo da execucao anda JUNTO dos numeros dela. Guardar a
            // estrategia so no painel deixaria a medida orfa no console.
            estrategiaFundo: fundoAtual,
            // `requests` conta o que foi mesmo a rede (descritor, preview e
            // tiles), e `tilesPedidos` conta o que entrou na fila. Os dois
            // diferem quando um lote e abortado, e o comparativo do piloto quer
            // o primeiro.
            requests: 0,
            tilesPedidos: 0,
            tilesDesenhados: 0,
            bytes: 0,
            // As tres parcelas de `bytes`, abertas porque o defeito do fundo so
            // apareceu quando o preview e o nivel 0 pararam de somar num numero
            // so. O descritor entra tambem: e um objeto de rede como qualquer
            // outro, e deixa-lo de fora subestimaria o caminho por tiles
            // justamente contra o full, que gasta UMA requisicao.
            bytesDescritor: 0,
            bytesPreview: 0,
            bytesFundo: 0,
            msPrimeiraPintura: null,
            msNivelCompleto: null,
            pendentes: 0,
        };
    }


    function publicar() {
        estat.pendentes = fila.length + emVoo;
        if (onEstatisticas) onEstatisticas({ ...estat });
    }

    function log(msg) {
        if (onLog) onLog(msg);
    }

    // ========================================================================
    // DESCRITOR
    // ========================================================================

    /**
     * Resolve uma URL do descritor contra o proprio endereco do `tiles.json`.
     * O contrato proibe URL absoluta no documento, e e essa resolucao que faz o
     * prefixo publico /ebgeo_360/ continuar valendo.
     * @param {string} relativa
     * @returns {string}
     */
    function resolver(relativa) {
        return new URL(relativa, urlDescritor).href;
    }

    /**
     * Monta a URL de um tile a partir do template do descritor.
     * @param {number} nivel
     * @param {number} x
     * @param {number} y
     * @returns {string}
     */
    function urlTile(nivel, x, y) {
        const alvo = descritor.template
            .replace('{level}', String(nivel))
            .replace('{x}', String(x))
            .replace('{y}', String(y));
        return resolver(alvo);
    }

    // ========================================================================
    // ESCOLHA DE NIVEL
    // ========================================================================

    /**
     * Escolhe o nivel para a camera de agora. A conta e a de `pyramid-math`; o
     * que sobra aqui e a politica do cliente: o nivel travado a mao e a
     * histerese, que impede a roda do mouse de disparar uma recarga por evento,
     * porque cada troca de nivel joga fora o canvas inteiro.
     * @returns {number}
     */
    function nivelDesejado() {
        const necessaria = larguraNecessaria(camera.largura, camera.altura, camera.fov);
        estat.larguraNecessaria = Math.round(necessaria);

        if (nivelFixo !== null) return nivelFixo;

        // Tela sem area (aba oculta, container recolhido) devolve 0. Nesse caso
        // segure o nivel em uso: descer de nivel jogaria fora o canvas de quem
        // nao esta vendo nada, e a volta ainda pagaria a reconstrucao.
        if (necessaria <= 0) return nivelAtual === null ? 0 : nivelAtual;

        if (nivelAtual !== null) {
            const larguraAtual = niveis[nivelAtual].width;
            if (necessaria >= larguraAtual / HISTERESE && necessaria <= larguraAtual * HISTERESE) {
                return nivelAtual;
            }
        }

        return escolherNivel(escada, necessaria);
    }

    /**
     * Os tiles que a camera enxerga naquele nivel, do centro da tela para fora.
     * A margem e parametro, e nao constante escondida: o benchmark precisa medir
     * o conjunto ideal e o que a producao realmente pede.
     * @param {number} nivel
     * @returns {Array<{x: number, y: number, d: number}>}
     */
    function visiveis(nivel) {
        return tilesVisiveis(niveis[nivel], descritor.tileSize, camera, MARGEM_TILES);
    }

    /**
     * Os tiles de nivel 0 que a estrategia de fundo em vigor manda baixar.
     *
     * `preview` devolve lista vazia de proposito: o preview ja foi pintado, e a
     * estrategia dele e justamente NAO ter segunda camada de fundo.
     *
     * @returns {Array<{x: number, y: number}>}
     */
    function tilesDeFundo() {
        if (fundoAtual === 'preview') return [];
        if (fundoAtual === 'nivel0vis') {
            return tilesVisiveis(niveis[0], descritor.tileSize, camera, MARGEM_FUNDO);
        }
        // 'nivel0': a grade inteira, que e a linha de base a bater.
        const base = niveis[0];
        const todos = [];
        for (let x = 0; x < base.cols; x++) {
            for (let y = 0; y < base.rows; y++) todos.push({ x, y });
        }
        return todos;
    }

    // ========================================================================
    // CANVAS E TEXTURA
    // ========================================================================

    /**
     * O tamanho do canvas de textura, que NAO e o tamanho do nivel.
     *
     * ESTA E A CONTA QUE CONSERTOU O TRAVAMENTO. O canvas nascia com a largura
     * do nivel, entao um nivel nativo de 7680 dava textura de 7680x3840, ou
     * 118 MB. Cada `needsUpdate` do three re-especifica a textura INTEIRA, e a
     * conta medida foi 1.013,5 MB enviados a GPU para abrir uma foto, contra
     * 127,1 MB do caminho antigo. O sintoma na mao do operador era engasgo na
     * primeira vez que ele girava, que e quando os tiles finos chegam.
     *
     * A textura nao precisa carregar mais pixel do que a TELA resolve. Numa
     * janela de 1584 px a panoramica util tem 5346 px, entao os 7680 do nivel
     * viram 2.334 colunas que nenhum monitor mostra. Cortar por
     * `larguraNecessaria` nao perde nada visivel: perderia, sim, se a camera
     * desse zoom, e ai a propria demanda cresce e o canvas se refaz maior.
     *
     * QUANTIZADO em passos de 1024 e para cima. Sem isso, cada pixel de
     * redimensionamento da janela pediria canvas novo, e reconstruir custa
     * alocar, repintar o cache e subir tudo de novo. Com o passo, a janela anda
     * bastante antes de trocar de degrau.
     *
     * @param {{width:number,height:number}} info - O nivel escolhido.
     * @returns {number} Largura do canvas, em pixels.
     */
    function larguraDoCanvas(info) {
        const teto = Math.min(info.width, maxTextura);
        const pedida = larguraNecessaria(camera.largura, camera.altura, camera.fov);
        if (!(pedida > 0)) return teto;
        const passo = 1024;
        const quantizada = Math.ceil(pedida / passo) * passo;
        return Math.max(passo, Math.min(teto, quantizada));
    }

    /**
     * Recria o canvas no tamanho do nivel, entrega uma textura nova e repinta o
     * que ja esta em cache (preview, nivel 0 e tiles do proprio nivel).
     * @param {number} nivel
     */
    function reconstruirCanvas(nivel) {
        const info = niveis[nivel];
        const largura = larguraDoCanvas(info);
        const altura = Math.round((largura * info.height) / info.width);

        canvas = document.createElement('canvas');
        canvas.width = largura;
        canvas.height = altura;
        ctx = canvas.getContext('2d', { alpha: false });
        desenhados = new Set();
        nivelAtual = nivel;
        estat.nivel = nivel;

        if (textura) textura.dispose();
        // Canvas novo e textura nova: o agrupamento recomeca, para o primeiro
        // upload da foto (ou do nivel) nao esperar a janela.
        ultimoUpload = 0;
        textura = new THREE.CanvasTexture(canvas);
        textura.colorSpace = THREE.SRGBColorSpace;
        // Sem mipmap: a piramide ja E o mipmap, e gerar niveis de uma textura de
        // 7680x3840 a cada needsUpdate custaria mais que a propria composicao.
        textura.generateMipmaps = false;
        textura.minFilter = THREE.LinearFilter;
        textura.magFilter = THREE.LinearFilter;

        if (bitmapPreview) pintarFundo(bitmapPreview);
        repintarDoCache(0);
        repintarDoCache(nivel);

        if (onTextura) onTextura(textura);
        texturaSuja = true;
        log(`canvas ${largura}x${altura} para o nivel ${nivel} (max textura ${maxTextura})`);
    }

    /**
     * Pinta a imagem base esticada no canvas inteiro. E o que garante que a
     * esfera nunca aparece preta: os tiles entram por cima conforme chegam.
     * @param {ImageBitmap} bitmap
     */
    function pintarFundo(bitmap) {
        ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        texturaSuja = true;
        if (estat.msPrimeiraPintura === null) {
            estat.msPrimeiraPintura = Math.round(performance.now() - estat.inicio);
        }
    }

    /**
     * Desenha um tile no canvas atual, na escala do canvas.
     * A largura vem do proprio bitmap, e nunca de uma conta: a ultima coluna e a
     * ultima linha sao recortadas, e supor 512 px esticaria a borda.
     * @param {number} nivel
     * @param {number} x
     * @param {number} y
     * @param {ImageBitmap} bitmap
     */
    function desenharTile(nivel, x, y, bitmap) {
        if (!ctx || nivelAtual === null) return;
        // So dois niveis chegam ao canvas: o alvo e o nivel 0 do fundo.
        if (nivel !== nivelAtual && nivel !== 0) return;
        if (nivel === 0 && nivel !== nivelAtual && cobertoPorFino(x, y)) return;

        const info = niveis[nivel];
        const escala = canvas.width / info.width;
        const tam = descritor.tileSize;
        ctx.drawImage(
            bitmap,
            x * tam * escala,
            y * tam * escala,
            bitmap.width * escala,
            bitmap.height * escala,
        );

        desenhados.add(`${nivel}/${x}/${y}`);
        texturaSuja = true;
        estat.tilesDesenhados++;
        if (estat.msPrimeiraPintura === null) {
            estat.msPrimeiraPintura = Math.round(performance.now() - estat.inicio);
        }
    }

    /**
     * Diz se algum tile do nivel atual ja pintou dentro da area de um tile de
     * nivel 0. Sem esta guarda, um tile grosso que chega atrasado apaga o
     * detalhe que chegou antes, e a mancha so sumiria na proxima troca de
     * nivel, porque a chave ja consta como desenhada.
     *
     * A varredura vai de `floor(x0*razao)` ate `ceil((x0+1)*razao)` porque a
     * razao entre dois niveis NAO e necessariamente inteira: a escada arredonda
     * a cada metade, e com passo fracionario a versao antiga (que andava de 1 em
     * 1 a partir de `x0*razao`) nunca caia numa chave existente. A guarda
     * simplesmente nao disparava.
     *
     * @param {number} x0
     * @param {number} y0
     * @returns {boolean}
     */
    function cobertoPorFino(x0, y0) {
        const razao = niveis[nivelAtual].width / niveis[0].width;
        const xFim = Math.ceil((x0 + 1) * razao);
        const yFim = Math.ceil((y0 + 1) * razao);
        for (let x = Math.floor(x0 * razao); x < xFim; x++) {
            for (let y = Math.floor(y0 * razao); y < yFim; y++) {
                if (desenhados.has(`${nivelAtual}/${x}/${y}`)) return true;
            }
        }
        return false;
    }

    /**
     * Repinta no canvas novo todos os tiles daquele nivel que ja estao em cache.
     * @param {number} nivel
     */
    function repintarDoCache(nivel) {
        for (const [chave, bitmap] of cache) {
            const [n, x, y] = chave.split('/').map(Number);
            if (n === nivel) desenharTile(n, x, y, bitmap);
        }
    }

    // ========================================================================
    // BUSCA
    // ========================================================================

    /**
     * Enfileira os tiles que faltam. Tile em cache e so redesenhado.
     * @param {number} nivel
     * @param {Array<{x: number, y: number}>} lista
     * @param {boolean} contaNoAlvo - se conta para o tempo ate o nivel completo
     * @returns {Promise<void>} resolve quando este lote termina
     */
    function pedirTiles(nivel, lista, contaNoAlvo) {
        const g = geracao;
        const esperas = [];
        for (const { x, y } of lista) {
            const chave = `${nivel}/${x}/${y}`;
            if (desenhados.has(chave)) continue;
            const emCache = cache.get(chave);
            if (emCache) {
                desenharTile(nivel, x, y, emCache);
                continue;
            }
            if (chavesEmVoo.has(`${g}/${chave}`)) continue;
            if (fila.some((t) => t.chave === chave)) continue;
            let concluir;
            esperas.push(new Promise((resolve) => { concluir = resolve; }));
            fila.push({ chave, nivel, x, y, g, alvo: contaNoAlvo, concluir });
            estat.tilesPedidos++;
            if (contaNoAlvo) alvoPendente++;
        }
        // Conjunto inteiro vindo do cache (voltar a um nivel ja visitado) nao
        // gera requisicao nenhuma, e sem esta linha o tempo ate completar
        // ficaria eternamente nulo. A lista vazia fica de fora: camera sem area
        // nao enxerga tile nenhum, e marcar "completo" ali seria medir o nada.
        if (contaNoAlvo && lista.length > 0 && alvoPendente === 0
            && estat.msNivelCompleto === null) {
            estat.msNivelCompleto = Math.round(performance.now() - estat.inicio);
        }
        bombear();
        publicar();
        return Promise.all(esperas).then(() => undefined);
    }

    function bombear() {
        while (emVoo < MAX_PARALELO && fila.length > 0) {
            const item = fila.shift();
            emVoo++;
            // A chave sai da fila e entra no conjunto EM VOO no mesmo passo,
            // senao ela fica invisivel para a deduplicacao ate a resposta.
            const emVooChave = `${item.g}/${item.chave}`;
            chavesEmVoo.add(emVooChave);
            baixarTile(item).finally(() => {
                emVoo--;
                chavesEmVoo.delete(emVooChave);
                item.concluir();
                if (item.alvo && item.g === geracao) {
                    alvoPendente--;
                    if (alvoPendente <= 0 && estat.msNivelCompleto === null) {
                        estat.msNivelCompleto = Math.round(performance.now() - estat.inicio);
                    }
                }
                bombear();
                publicar();
            });
        }
    }

    /**
     * Baixa, decodifica, guarda e desenha um tile.
     * O arrayBuffer vem antes do decode de proposito: e o unico jeito de medir
     * os bytes que passaram na rede, que sao o produto deste piloto.
     * @param {{chave: string, nivel: number, x: number, y: number, g: number}} item
     */
    async function baixarTile(item) {
        try {
            estat.requests++;
            const resposta = await fetch(urlTile(item.nivel, item.x, item.y), {
                signal: controlador.signal,
                cache: modoCache,
            });
            if (!resposta.ok) {
                log(`tile ${item.chave}: HTTP ${resposta.status}`);
                return;
            }
            const buffer = await resposta.arrayBuffer();
            if (item.g !== geracao) return;
            const bytes = bytesDaResposta(resposta, buffer);
            estat.bytes += bytes;
            // Tile que nao conta no alvo e tile de FUNDO, por construcao: e o
            // unico lote que `carregarFoto` dispara com `contaNoAlvo` falso.
            if (!item.alvo) estat.bytesFundo += bytes;
            const bitmap = await createImageBitmap(new Blob([buffer], { type: 'image/webp' }));
            if (item.g !== geracao) {
                bitmap.close();
                return;
            }
            guardarNoCache(item.chave, bitmap);
            desenharTile(item.nivel, item.x, item.y, bitmap);
        } catch (erro) {
            if (erro.name !== 'AbortError') log(`tile ${item.chave}: ${erro.message}`);
        }
    }

    /**
     * Guarda o bitmap com teto de memoria. O Map preserva a ordem de insercao,
     * entao o primeiro a sair e o mais antigo.
     * @param {string} chave
     * @param {ImageBitmap} bitmap
     */
    function guardarNoCache(chave, bitmap) {
        cache.set(chave, bitmap);
        while (cache.size > MAX_TILES_EM_CACHE) {
            const velha = cache.keys().next().value;
            const antigo = cache.get(velha);
            cache.delete(velha);
            if (antigo) antigo.close();
        }
    }

    // ========================================================================
    // CICLO
    // ========================================================================

    /**
     * Recalcula nivel e tiles visiveis. Roda so quando a camera para, porque
     * arrastar dispara dezenas de eventos por segundo e cada recalculo pediria
     * o mesmo conjunto de novo.
     */
    function reavaliar() {
        if (!descritor) return;
        const nivel = nivelDesejado();
        // O canvas se refaz por DOIS motivos, e nao so por troca de nivel: a
        // largura util da tela tambem muda com zoom e com redimensionamento da
        // janela, e ela e quem dita o tamanho da textura. Sem esta segunda
        // condicao, dar zoom dentro do mesmo nivel deixaria a textura no
        // degrau antigo, e o detalhe que os tiles trazem morreria na
        // reamostragem do canvas.
        const trocouNivel = nivel !== nivelAtual;
        const trocouCanvas = canvas !== null && larguraDoCanvas(niveis[nivel]) !== canvas.width;
        if (trocouNivel || trocouCanvas) reconstruirCanvas(nivel);
        pedirTiles(nivel, visiveis(nivel), true);
    }

    function agendarReavaliacao() {
        if (temporizador) clearTimeout(temporizador);
        temporizador = setTimeout(() => {
            temporizador = null;
            reavaliar();
        }, DEBOUNCE_MS);
    }

    /**
     * Solta tudo o que o carregador guarda entre fotos: bitmaps, preview, fila e
     * chaves em voo. E o que faz uma execucao comecar de cache FRIO.
     *
     * Existe uma vez so, e `carregarFoto` a chama, porque o modo dirigido
     * tambem precisa dela: sem limpar, a segunda medida da mesma foto leria a
     * memoria do processo e mediria decodificacao, nunca rede.
     */
    function soltarCaches() {
        fila.length = 0;
        chavesEmVoo.clear();
        alvoPendente = 0;
        if (bitmapPreview) {
            bitmapPreview.close();
            bitmapPreview = null;
        }
        for (const bitmap of cache.values()) bitmap.close();
        cache.clear();
        desenhados = new Set();
    }

    // ========================================================================
    // API
    // ========================================================================

    return {
        /**
         * Carrega uma foto: descritor, preview, o fundo pedido pela estrategia
         * e, por fim, os tiles visiveis do nivel alvo. Aborta o que a foto
         * anterior ainda tinha em voo.
         *
         * Devolve `null` quando outra foto tomou o lugar desta no meio do
         * caminho. Cada `await` reconfere a geracao ANTES de escrever qualquer
         * estado: clicar a foto A e depois a B, antes de A resolver, fazia a
         * continuacao de A sobrescrever descritor e niveis e reconstruir o
         * canvas no formato de A, enquanto os tiles de B chegavam por cima.
         *
         * @param {string} uuid
         * @param {Object} [opcoes]
         * @param {string} [opcoes.estrategiaFundo] - so para esta foto
         * @returns {Promise<Object|null>} o descritor, ou null se foi superado
         */
        async carregarFoto(uuid, opcoes = {}) {
            if (controlador) controlador.abort();
            controlador = new AbortController();
            // A reavaliacao agendada pela camera anterior morre AQUI. Se ela
            // disparasse no meio desta carga, pediria o nivel alvo junto com o
            // fundo, as duas rajadas disputariam o mesmo pool de 24 e o tempo
            // ate o alvo completo mediria a briga, nao o desenho.
            if (temporizador) {
                clearTimeout(temporizador);
                temporizador = null;
            }
            geracao++;
            nivelAtual = null;
            soltarCaches();
            if (opcoes.estrategiaFundo !== undefined) {
                fundoAtual = estrategiaDeFundoValida(opcoes.estrategiaFundo);
            }
            estat = zerarEstatisticas();
            estat.inicio = performance.now();
            uuidAtual = uuid;
            publicar();

            const g = geracao;
            urlDescritor = new URL(`${raizApi}/photos/${uuid}/tiles.json`, location.href);
            estat.requests++;
            const resposta = await fetch(urlDescritor.href, {
                signal: controlador.signal,
                // O descritor tambem obedece ao modo de cache. Ele responde com
                // `no-cache` mais validador, entao sem esta linha a segunda
                // execucao levaria um 304 do cache do navegador e a medida de
                // rede comecaria adulterada logo na primeira requisicao.
                cache: modoCache,
            });
            if (g !== geracao) return null;
            if (!resposta.ok) {
                // O status viaja NO ERRO porque 404 e o caminho normal, e nao
                // uma falha: 28 dos 29 projetos nao tem piramide gerada. Quem
                // chama precisa separar "nao existe piramide" de "a rede caiu"
                // sem ler a mensagem, que e texto e muda.
                const erro = new Error(`tiles.json: HTTP ${resposta.status}`);
                erro.status = resposta.status;
                throw erro;
            }
            // O corpo vem como buffer, e o JSON sai do texto, porque `.json()`
            // consome a resposta e apagaria a chance de pesar o descritor.
            const bufferDescritor = await resposta.arrayBuffer();
            const documento = JSON.parse(new TextDecoder().decode(bufferDescritor));
            // A reconferencia vem ANTES da primeira escrita de estado. So o
            // `abort` nao basta: o fetch de A pode ja ter respondido, e ai a
            // continuacao roda inteira mesmo com o sinal abortado.
            if (g !== geracao) return null;
            if (documento.schemaVersion !== 1) {
                throw new Error(`schemaVersion ${documento.schemaVersion} desconhecida`);
            }
            estat.bytesDescritor = bytesDaResposta(resposta, bufferDescritor);
            estat.bytes += estat.bytesDescritor;
            descritor = documento;
            // O descritor traz `levels` redundante de proposito, para o cliente
            // nao repetir o ceil e um arredondamento divergente nao virar tile
            // faltando. `niveis` indexa por `level` e protege contra ordem
            // trocada; `escada` e a copia ORDENADA, porque `escolherNivel`
            // percorre do mais grosso ao mais fino e para no primeiro que cobre.
            niveis = [];
            for (const nivel of descritor.levels) niveis[nivel.level] = nivel;
            escada = [...descritor.levels].sort((a, b) => a.level - b.level);

            reconstruirCanvas(nivelDesejado());

            // 1. Preview esticado. Vale nas TRES estrategias: e ele que impede a
            // tela preta, e chega antes de qualquer tile.
            estat.requests++;
            const respPreview = await fetch(resolver(descritor.base), {
                signal: controlador.signal,
                cache: modoCache,
            });
            if (g !== geracao) return null;
            if (respPreview.ok) {
                const buffer = await respPreview.arrayBuffer();
                if (g !== geracao) return null;
                estat.bytesPreview = bytesDaResposta(respPreview, buffer);
                estat.bytes += estat.bytesPreview;
                bitmapPreview = await createImageBitmap(
                    new Blob([buffer], { type: 'image/webp' }),
                );
                if (g !== geracao) {
                    bitmapPreview.close();
                    bitmapPreview = null;
                    return null;
                }
                pintarFundo(bitmapPreview);
                publicar();
            }

            // 2. Fundo de nivel 0, conforme a estrategia.
            //
            // O lote e ESPERADO antes do detalhe, e nao disparado junto: os dois
            // concorreriam no mesmo pool de 24, e um tile grosso que chegasse
            // depois de um fino apagaria o detalhe dele.
            //
            // Quando o proprio alvo E o nivel 0 (tela pequena, ou nivel travado
            // a mao) o fundo nao existe como etapa separada: baixar os mesmos
            // tiles fora do alvo esconderia o custo deles do relogio do alvo, e
            // o piloto mediria um nivel que se completa sozinho.
            const tilesDoFundo = nivelAtual === 0 ? [] : tilesDeFundo();
            if (tilesDoFundo.length > 0) {
                await pedirTiles(0, tilesDoFundo, false);
                if (g !== geracao) return null;
            }

            // 3. Nivel alvo, so o que a camera enxerga.
            pedirTiles(nivelAtual, visiveis(nivelAtual), true);
            return descritor;
        },

        /**
         * Informa o estado da camera. Chame a cada frame: a comparacao interna
         * e barata e o recalculo pesado fica no debounce.
         * @param {{lon: number, lat: number, fov: number, largura: number, altura: number}} novo
         */
        atualizarCamera(novo) {
            const mudou =
                novo.lon !== camera.lon ||
                novo.lat !== camera.lat ||
                novo.fov !== camera.fov ||
                novo.largura !== camera.largura ||
                novo.altura !== camera.altura;
            camera = { ...camera, ...novo };
            if (mudou && descritor) agendarReavaliacao();
        },

        /**
         * Sobe as pinturas acumuladas para a GPU. Chame UMA vez por frame: por
         * tile, cada needsUpdate reenviaria o canvas inteiro.
         * @returns {boolean} se houve upload
         */
        aplicarAtualizacoes() {
            if (!texturaSuja || !textura) return false;

            // AGRUPA NO TEMPO, e nao so por frame. Uma vez por frame ainda era
            // uma vez por tile que chega: medidos 12 uploads e 1.013,5 MB para
            // abrir uma foto, contra 4 uploads e 127,1 MB do caminho antigo. O
            // `needsUpdate` do three re-especifica a textura INTEIRA, entao o
            // custo nao e proporcional ao pedaco que mudou, e sim ao canvas.
            //
            // A janela deixa a chegada em rajada virar UM upload. O ultimo
            // upload nunca se perde: quando a rajada para, o proximo frame ja
            // passou da janela e sobe o que faltava.
            const agora = performance.now();
            const rajadaViva = agora - ultimoUpload < MS_ENTRE_UPLOADS;
            const primeiro = ultimoUpload === 0;
            if (rajadaViva && !primeiro) return false;

            textura.needsUpdate = true;
            texturaSuja = false;
            ultimoUpload = agora;
            estat.uploads = (estat.uploads || 0) + 1;
            return true;
        },

        /**
         * Fixa um nivel, ou volta ao automatico com null.
         * @param {number|null} nivel
         */
        fixarNivel(nivel) {
            nivelFixo = nivel;
            if (descritor) reavaliar();
        },

        /**
         * Escolhe o modo de cache HTTP de toda busca deste carregador.
         *
         * Sem isso a segunda medida le do cache do navegador (os tiles saem
         * `immutable` por um ano) e mede disco, nao rede.
         *
         * `reload` e `no-store` NAO sao a mesma coisa, e a diferenca decide uma
         * serie de execucoes: `reload` obriga a ida a rede mas GRAVA a resposta
         * no cache, entao a execucao seguinte que pedir `default` le do disco.
         * `no-store` nao le nem grava, e e por isso que ele e o padrao aqui.
         *
         * @param {boolean|'default'|'reload'|'no-store'} valor - `true` vira
         *   `reload` e `false` vira `default`, para o interruptor simples do demo
         */
        ignorarCache(valor) {
            if (valor === true) modoCache = 'reload';
            else if (valor === false) modoCache = 'default';
            else if (['default', 'reload', 'no-store'].includes(valor)) modoCache = valor;
            else log(`modo de cache "${valor}" desconhecido, mantendo ${modoCache}`);
        },

        /** @returns {string} modo de cache em vigor */
        getModoCache() {
            return modoCache;
        },

        /**
         * Troca a estrategia de fundo das PROXIMAS fotos.
         * @param {string} nome - um de ESTRATEGIAS_FUNDO
         */
        definirEstrategiaFundo(nome) {
            fundoAtual = estrategiaDeFundoValida(nome);
        },

        /** @returns {string} estrategia de fundo em vigor */
        getEstrategiaFundo() {
            return fundoAtual;
        },

        /**
         * Solta bitmaps, preview e fila sem descartar a textura nem o descritor.
         * O modo dirigido chama antes de cada execucao, para medir rede e nao a
         * memoria da execucao anterior.
         */
        limparCaches() {
            soltarCaches();
        },

        /**
         * Larga a foto em composicao e RENUNCIA a textura, sem descarta-la.
         *
         * Existe para o caminho do 404, que e o normal e nao a excecao: 28 dos
         * 29 projetos nao tem piramide, e `carregarFoto` sobe o erro DEPOIS de
         * ja ter zerado a geracao e os caches, deixando `descritor` com o
         * documento da foto ANTERIOR. Sem esta limpeza, a proxima
         * `atualizarCamera` ainda veria descritor vivo, o debounce chamaria
         * `reavaliar`, e o canvas da foto velha voltaria para a tela por cima da
         * foto nova.
         *
         * A textura sai VIVA, e nao descartada, porque ela ainda esta na esfera
         * de quem chamou. Descartar aqui deixaria uma textura morta na tela ate
         * o full chegar. Quem recebe vira o dono e a descarta ao substitui-la.
         *
         * @returns {THREE.CanvasTexture|null} a textura renunciada, se havia uma
         */
        soltarFoto() {
            if (controlador) controlador.abort();
            if (temporizador) {
                clearTimeout(temporizador);
                temporizador = null;
            }
            // A geracao sobe junto do abort. Tile que ja tinha resposta em maos
            // resolve mesmo depois do abort, e sem isto pintaria num canvas que
            // nao e mais de foto nenhuma.
            geracao++;
            soltarCaches();
            descritor = null;
            niveis = [];
            escada = [];
            urlDescritor = null;
            uuidAtual = null;
            nivelAtual = null;
            const renunciada = textura;
            textura = null;
            canvas = null;
            ctx = null;
            texturaSuja = false;
            estat = zerarEstatisticas();
            publicar();
            return renunciada;
        },

        /** @returns {string} raiz da API que este carregador usa */
        getBase() {
            return raizApi;
        },

        /** @returns {THREE.CanvasTexture|null} */
        getTextura() {
            return textura;
        },

        /** @returns {Object|null} */
        getDescritor() {
            return descritor;
        },

        /** @returns {string|null} */
        getUuid() {
            return uuidAtual;
        },

        /** @returns {Object} copia das estatisticas */
        getEstatisticas() {
            return { ...estat, pendentes: fila.length + emVoo };
        },

        /** Libera bitmaps, textura e requisicoes em voo. */
        dispose() {
            if (controlador) controlador.abort();
            if (temporizador) clearTimeout(temporizador);
            soltarCaches();
            if (textura) textura.dispose();
            textura = null;
            canvas = null;
            ctx = null;
        },
    };
}
