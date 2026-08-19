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
 * A NUMERACAO ANDOU, e o contrato nao. A escada passou a descer ate o nivel
 * caber em UM TILE, entao a piramide ganhou niveis POR BAIXO: o que era `level`
 * 0 virou level 2 ou level 3. `level` 0 segue sendo o mais grosso, e essa e a
 * unica coisa que este arquivo supoe. Ele nunca conta quantos niveis existem,
 * nem deduz largura de nivel por uma conta propria: tudo sai de
 * `descritor.levels`. Por isso ele le dado velho e dado novo sem saber a
 * diferenca.
 *
 * DOIS CONSUMIDORES, e nao mais so o demo: `tile-demo.html`, que compara tiles
 * contra o full, e `viewer.js`, a interface de calibracao. O que os dois
 * precisam saber e a POSSE DA TEXTURA, porque descartar em dobro mata a esfera
 * em silencio:
 *   - `onTextura` entrega a textura nova. A anterior NAO foi descartada: ela
 *     ainda pode estar na esfera, e quem a tirar de la e quem a descarta. O
 *     carregador descartar por conta propria fazia o three recriar a textura no
 *     quadro seguinte, do zero, com o canvas inteiro subindo de novo.
 *   - `soltarFoto()` devolve a posse: ele para tudo, esquece o descritor e
 *     entrega a ultima textura viva. Dali em diante quem descarta e o chamador.
 *   - `dispose()` descarta a textura que ainda for dele.
 *
 * O FUNDO E O NIVEL 0, e nao mais o preview. Com a escada descendo ate um tile,
 * o nivel 0 E a imagem base borrada que Google, Photo Sphere Viewer e Marzipano
 * pintam antes dos tiles: 458x229 em 7680, 360x180 em 5760, 512x256 em 2048,
 * sempre um objeto so. A piramide passa a bastar sozinha, e o `preview_webp` e o
 * `full_webp` saem do disco.
 *
 * QUANTO CUSTA O FUNDO NOVO, medido e nao estimado. O gerador foi reproduzido
 * (lanczos3 e webp q80, generate-tiles.js:194) sobre o `full_webp` de cada foto,
 * e o tile de nivel 0 foi pesado contra o `preview_webp` da MESMA foto:
 *   7680x3840, nivel 0 de 458x229: 17.547 B contra 16.400 B, 1,07x (162 fotos
 *     de blumenau, o projeto inteiro naquele formato)
 *   5760x2880, nivel 0 de 360x180: 11.471 B contra 15.956 B, 0,72x (19 fotos
 *     de blumenau, o projeto inteiro naquele formato)
 *   2048x1024, nivel 0 de 512x256: 18.214 B contra 14.576 B, 1,25x (20 fotos
 *     de santana_livramento, amostra de 828)
 * O fundo custa de 0,72x a 1,25x o preview, ou seja troca-se um objeto por outro
 * do mesmo tamanho. O 2048 e o pior caso, e a razao e exata: o nivel 0 dele tem
 * os MESMOS 512x256 do preview, so que em q80 contra os q70 do preview
 * (migrate.js:1036). Paga-se 3,6 KB por foto em 828 fotos, ou 3,0 MB, para
 * apagar 62,6 GB de `full_webp` e 1,03 GB de `preview_webp`.
 *
 * A MEDIDA ANTIGA NAO VALE MAIS, e por isso ela sai daqui. Ela dizia 13,0 KB de
 * preview contra 139,3 KB de nivel 0, ou 10,7x. Aquele nivel 0 tinha 1875 ou
 * 1440 px de largura, em 8 ou 6 tiles, porque a escada parava em 2048. O de
 * agora tem 458 ou 360 px, em UM tile.
 *
 * `descritor.base` continua no documento por compatibilidade, e o caminho padrao
 * NAO o toca. So a estrategia legada 'preview' o pede, e ela morre junto do dado
 * que ela busca.
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
 * Os DOIS desenhos de fundo que sobraram.
 *
 * - `nivel0`: o nivel 0 da propria piramide. E o padrao, e e um tile so.
 * - `preview`: o `descritor.base`, ou seja `image?quality=preview`. E o desenho
 *   LEGADO, mantido so enquanto o `preview_webp` existir no disco.
 *
 * ERAM TRES NOMES PARA DOIS DESENHOS, e agora sao dois. 'nivel0vis' baixava so
 * os tiles do nivel 0 que a camera enxergava, e 'nivel0' baixava a grade
 * inteira; a diferenca media 4 tiles de 8. Com o nivel 0 cabendo em UM tile nao
 * ha o que recortar, entao os dois viraram a mesma requisicao, e manter os dois
 * nomes so rotularia duas execucoes identicas com rotulos diferentes. Junto
 * deles sai `MARGEM_FUNDO`, a margem que existia para recortar esse conjunto.
 * @constant {string[]}
 */
export const ESTRATEGIAS_FUNDO = ['nivel0', 'preview'];

/**
 * Estrategia de fundo padrao.
 *
 * E 'nivel0', porque o `preview_webp` vai ser apagado e o cliente nao pode
 * depender de um dado que deixa de existir. Nenhum caminho padrao pede
 * `image?quality=preview` nem `image?quality=full`.
 *
 * A MEDIDA DE PAREDE QUE ELEGEU O PREVIEW MEDIU OUTRO OBJETO. Ela comparou
 * 13,0 KB de preview contra 139,3 KB de nivel 0, e aquele nivel 0 eram 8 tiles
 * de uma escada que parava em 2048. O nivel 0 de hoje e UM tile de 458 ou 360 px
 * de largura, e custa de 0,72x a 1,25x o preview (numeros no cabecalho). O que
 * a medida de parede decidiu continua valendo: paga-se UM objeto grosso, nunca
 * oito.
 * @constant {string}
 */
export const ESTRATEGIA_FUNDO_PADRAO = 'nivel0';

/** Espera de camera parada antes de recalcular nivel e tiles visiveis (ms). */
const DEBOUNCE_MS = 120;

/** Banda morta da troca de nivel, conforme o contrato. */
const HISTERESE = 1.3;

/**
 * Quanto a largura util precisa crescer para valer um canvas novo.
 *
 * Os degraus de canvas sao de 1024 px, entao entre degraus vizinhos a razao vai
 * de 1,07x (7168 para 7680) a 1,25x (4096 para 5120). Com 1,5 nenhum degrau
 * sozinho refaz a textura, e so um salto real de tela ou de campo refaz. E a
 * diferenca entre atravessar um zoom sem alocar nada e alocar quatro vezes.
 */
const CRESCE_CANVAS = 1.5;

/**
 * Quanto a largura util precisa ENCOLHER para valer devolver memoria.
 *
 * Maior que o de crescer, e de proposito: a textura grande ja esta paga, e
 * encolher no meio de um gesto troca memoria por uma pausa justamente quando a
 * mao esta na tela. Com 2,0 so um afastamento franco devolve o canvas.
 */
const ENCOLHE_CANVAS = 2.0;

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
 * SO VALE NO CAMINHO SEM `renderer`. Quem passa o renderer sobe o retangulo do
 * tile (ver `subirSoOPedaco`) e nao agrupa nada: o custo ja e proporcional ao
 * que mudou, e o tile aparece assim que chega.
 *
 * O `needsUpdate` do three re-especifica a textura INTEIRA, entao subir por
 * tile que chega custa o canvas inteiro por tile. Com 120 ms uma rajada de
 * tiles vira poucos uploads, e o olho nao distingue a diferenca: 120 ms sao
 * cerca de sete frames, e a foto leva bem mais que isso para completar.
 *
 * O DEFEITO QUE ELE TEM, e que motivou a subida parcial: a conta cresce com a
 * LENTIDAO da maquina. Uma maquina lenta espalha a chegada dos tiles por mais
 * janelas e paga mais subidas do canvas inteiro. Medido: 3 lotes e 216 MB na
 * estacao, 6 lotes e 432 MB no perfil de CPU seis vezes mais lenta, para a
 * mesma foto.
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
 * Teto de lado de textura que ESTA maquina merece, independente do driver.
 *
 * POR QUE UM TETO DE MAQUINA. A textura da panoramica e uma so, e o lado dela
 * decide tudo: 6144 custam 72 MB, 7680 custam 113 MB, e o canvas de origem custa
 * o mesmo de novo. Numa estacao isso e ruido; num equipamento com 4 GB e video
 * integrado, que divide memoria com o sistema, sao dois blocos de 113 MB que
 * disputam com o navegador inteiro. Medido no perfil de maquina fraca: 432 MB de
 * textura subidos por troca de foto, contra 216 MB na estacao, para a mesma
 * cena.
 *
 * O QUE SE PERDE E POUCO, e vale dizer quanto. A 1904x985 e campo de 75 graus a
 * tela resolve 5.816 px de panoramica, entao 4096 mostram 70% do detalhe que ela
 * poderia mostrar. E menos nitidez ao aproximar, e nao imagem faltando: os tiles
 * continuam vindo do mesmo nivel, so desenhados numa escala menor.
 *
 * AS DUAS PISTAS SAO IMPERFEITAS, e por isso a regra e conservadora. `deviceMemory`
 * vem arredondada para baixo em degraus (4 significa "4 ou menos") e nao existe
 * no Firefox nem no Safari; `hardwareConcurrency` conta nucleos logicos e nao diz
 * nada sobre o video. Na ausencia das duas, o teto NAO se aplica: e melhor pagar
 * memoria numa maquina boa do que borrar a foto numa maquina que ninguem mediu.
 *
 * @returns {number} lado maximo, em pixels
 */
export function tetoDaMaquina(navegador = globalThis.navigator) {
    const memoriaGB = navegador?.deviceMemory;
    const nucleos = navegador?.hardwareConcurrency;
    const poucaMemoria = typeof memoriaGB === 'number' && memoriaGB <= 4;
    const poucosNucleos = typeof nucleos === 'number' && nucleos <= 4;
    return poucaMemoria || poucosNucleos ? 4096 : LIMITE_CANVAS;
}

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
 * @param {THREE.WebGLRenderer} [opcoes.renderer] - o renderer inteiro. Sem ele,
 *   cada tile que chega faz a textura INTEIRA subir de novo; com ele, sobe so o
 *   retangulo do tile (ver `subirSoOPedaco`). E opcional para o demo e a pagina
 *   de calibracao, que so tem o contexto a mao
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
    renderer,
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
    //
    // O QUE O DRIVER PERMITE NAO E O QUE A MAQUINA AGUENTA. Video integrado
    // anuncia 16384 sem pestanejar, e a textura de 7680x3840 que cabe nesse
    // teto custa 113 MB de memoria compartilhada com o sistema, mais o mesmo
    // tanto no canvas de origem. Por isso entra um teto de MAQUINA por cima do
    // teto de driver.
    const maxTextura = Math.min(
        gl ? gl.getParameter(gl.MAX_TEXTURE_SIZE) : LIMITE_CANVAS,
        LIMITE_CANVAS,
        tetoDaMaquina(),
    );

    /** Raiz da API desta instancia, fixada na criacao. */
    const raizApi = base || raizDaApi();

    // Sem renderer, a subida parcial nao existe e tudo segue pelo caminho de
    // sempre. E o caso da pagina de calibracao e do demo, que criam o
    // carregador so com o contexto. Nao e degradacao escondida: a coluna
    // `uploadsParciais` fica em zero e denuncia.
    let renderizador = renderer || null;

    let descritor = null;
    let niveis = [];
    let escada = [];
    let urlDescritor = null;
    let uuidAtual = null;

    let canvas = null;
    let ctx = null;
    let textura = null;
    let texturaSuja = false;
    /**
     * O canvas pequeno de onde sai cada retangulo, e a textura que o embrulha.
     * Um so por carregador: as subidas sao sequenciais, e alocar um por tile
     * jogaria fora justamente o que a subida parcial economiza.
     */
    let recorte = null;
    /**
     * A textura ainda nao existe na GPU, ou o canvas acabou de ser refeito.
     * Enquanto isto vale, cada tile so pinta no canvas: quem sobe e a primeira
     * subida INTEIRA, que ja carrega tudo que foi pintado ate ali.
     */
    let precisaSubirTudo = true;
    /**
     * Um pedaco subiu e a tela ainda nao redesenhou.
     *
     * A subida parcial acontece na volta da rede, e nao no laco de quadro, entao
     * quem desenha precisa saber que ha o que mostrar. Sem este aviso o tile
     * chegaria a GPU e ficaria invisivel ate o operador encostar no mouse: o
     * visualizador so desenha quando esta sujo.
     */
    let pedeQuadro = false;
    /**
     * A caixa que envolve tudo que mudou no canvas desde o ultimo quadro, em
     * pixels do canvas. Nula quando nao ha nada a subir.
     */
    let pedaco = null;
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
    /**
     * Preview esticado, guardado para repintar o fundo sem baixar de novo.
     * So a estrategia legada 'preview' o enche. No caminho padrao ele fica nulo,
     * e quem repinta o fundo e `repintarDoCache(0)`, com o tile de nivel 0.
     */
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
            // `bytesPreview` fica ZERO no caminho padrao, porque o preview nao
            // e mais baixado. Ele sobrevive para a estrategia legada, e para o
            // painel do demo nao perder a coluna que separa fundo de descritor.
            bytesPreview: 0,
            bytesFundo: 0,
            // `uploads` conta as subidas da textura INTEIRA e `uploadsParciais`
            // as de um retangulo so. `bytesParaGpu` soma as duas em bytes, que e
            // a unica medida comparavel entre os dois caminhos: 55 tiles custam
            // 216 MB pelo caminho inteiro e 38 MB pelo parcial.
            uploads: 0,
            uploadsParciais: 0,
            bytesParaGpu: 0,
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
     * Pede os tiles do nivel, em UMA onda.
     *
     * AQUI ESTEVE UMA SEGUNDA ONDA, e ela foi medida e desfeita. A ideia era
     * pedir primeiro o que a camera enxerga (32 tiles no formato 7680 a
     * 1904x985) e so depois a folga de vizinhanca (os outros 28), para a foto
     * ficar nitida depois de metade das decodificacoes. O numero reprovou:
     *
     *   troca de foto, perfil de maquina fraca:  1.255 ms -> 2.276 ms  (+81%)
     *   giro de 360 graus, mesma maquina:        1.496 ms -> 2.618 ms  (+75%)
     *
     * Duas causas, e as duas sao do desenho e nao do ajuste. A onda seguinte so
     * comeca quando a anterior TERMINA, entao a fila de 24 requisicoes esvazia
     * antes de encher de novo, e numa maquina lenta esse vao e longo. E pior:
     * durante um arrasto a reavaliacao dispara a cada 120 ms, cada uma deixando
     * uma continuacao pendente, e todas elas acordam depois pedindo a margem de
     * um azimute que ja passou.
     *
     * Fica registrado para nao ser reinventado. Quem tentar de novo precisa de
     * uma fila com PRIORIDADE, e nao de duas ondas em serie: a margem entra no
     * fim da mesma fila, e a reavaliacao seguinte a descarta.
     */
    function tilesDeFundo() {
        if (fundoAtual === 'preview') return [];
        const base = niveis[0];
        const todos = [];
        for (let x = 0; x < base.cols; x++) {
            for (let y = 0; y < base.rows; y++) todos.push({ x, y });
        }
        return todos;
    }

    function larguraDoCanvas(info) {
        const teto = Math.min(info.width, maxTextura);
        const passo = 1024;
        const pedida = larguraNecessaria(camera.largura, camera.altura, camera.fov);
        if (!(pedida > 0)) {
            // Devolver a largura do canvas atual tambem evita a reconstrucao:
            // `reavaliar` compara esta conta com `canvas.width`, e igual nao
            // reconstroi. Quem nao esta vendo nada nao paga textura nenhuma.
            return canvas ? Math.min(teto, canvas.width) : Math.min(teto, passo);
        }
        const quantizada = Math.ceil(pedida / passo) * passo;
        return Math.max(passo, Math.min(teto, quantizada));
    }

    /**
     * Recria o canvas no tamanho do nivel, entrega uma textura nova e repinta o
     * que ja esta em cache (preview, nivel 0 e tiles do proprio nivel).
     * @param {number} nivel
     */
    /**
     * Arma a textura para receber pedacos, e o canvas de onde eles saem.
     *
     * `flipY` desligado E a condicao para o retangulo cair no lugar certo, e a
     * UV invertida desfaz o efeito na amostragem. As duas linhas andam juntas:
     * mexer numa sem a outra poe a panoramica de cabeca para baixo, e o unico
     * jeito honesto de saber e comparar pixel contra a versao anterior.
     *
     * Sem `renderizador` nada disto vale, e a textura fica como sempre foi.
     */
    function prepararSubidaParcial() {
        precisaSubirTudo = true;
        // O retangulo pendente e do canvas ANTIGO. Aplicado no novo, subiria
        // pixel de outro tamanho para a coordenada errada.
        pedaco = null;
        if (!renderizador) return;

        textura.flipY = false;
        textura.repeat.set(1, -1);
        textura.offset.set(0, 1);

        if (!recorte) {
            const pequeno = document.createElement('canvas');
            const ctxPequeno = pequeno.getContext('2d', { alpha: false });
            const texturaPequena = new THREE.CanvasTexture(pequeno);
            texturaPequena.flipY = false;
            texturaPequena.colorSpace = THREE.SRGBColorSpace;
            texturaPequena.generateMipmaps = false;
            recorte = { canvas: pequeno, ctx: ctxPequeno, textura: texturaPequena };
        }
    }

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

        // A TEXTURA ANTERIOR NAO E DESCARTADA AQUI, e a mudanca nao e de estilo.
        //
        // Ela ainda esta na esfera: o consumidor so troca o `map` do material
        // quando o primeiro tile pinta, que e dezenas ou centenas de
        // milissegundos depois. Descartar agora deixa o material apontando para
        // uma textura morta, e o three.js, ao desenhar o quadro seguinte,
        // RECRIA a textura do zero: uma alocacao nova e o canvas inteiro subindo
        // de novo para a GPU.
        //
        // Medido numa troca de foto a 1904x985 no perfil de maquina fraca: DUAS
        // alocacoes de 6144x3072 no mesmo salto, a 56 ms uma da outra, com as
        // pilhas de chamada apontando as duas para o mesmo caminho interno do
        // three (`setTexture2D` durante o render). Sao 72 MB de alocacao e 72 MB
        // de subida jogados fora por foto, e nada na tela denuncia: a foto
        // anterior continua correta enquanto isso acontece.
        //
        // Quem descarta passa a ser QUEM TIRA A TEXTURA DA ESFERA, que e o unico
        // ponto do sistema que sabe que ela nao esta mais em uso.
        // Canvas novo e textura nova: o agrupamento recomeca, para o primeiro
        // upload da foto (ou do nivel) nao esperar a janela.
        ultimoUpload = 0;
        textura = new THREE.CanvasTexture(canvas);
        textura.colorSpace = THREE.SRGBColorSpace;
        prepararSubidaParcial();
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
     * Pinta a imagem base esticada no canvas inteiro.
     *
     * So a estrategia legada 'preview' chega aqui. No caminho padrao quem
     * garante que a esfera nunca aparece preta e `desenharTile` com o tile de
     * nivel 0: sendo um tile so, ele ja cobre o canvas inteiro pela mesma
     * escala, e nao precisa de um desenho a parte.
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
    /**
     * Sobe para a GPU SO O RETANGULO que acabou de mudar.
     *
     * O PROBLEMA. `textura.needsUpdate = true` faz o three re-especificar a
     * textura INTEIRA. Um tile de 512 px muda 0,64 MB do canvas e custava 72 MB
     * de subida. Para nao pagar isso por tile, o carregador agrupava as subidas
     * numa janela de 120 ms, e o agrupamento tinha um defeito perverso: a conta
     * cresce com a LENTIDAO da maquina. Medido numa troca de foto a 1904x985,
     * 55 tiles: 3 lotes e 216 MB na estacao, 6 lotes e 432 MB no perfil de CPU
     * seis vezes mais lenta. Quanto mais fraco o equipamento, mais ele pagava.
     *
     * A SAIDA. `renderer.copyTextureToTexture` do three chama `texSubImage2D`,
     * que escreve um retangulo dentro da textura ja alocada. Com ele o custo
     * passa a ser proporcional ao que mudou: os mesmos 55 tiles somam cerca de
     * 38 MB, e a janela de agrupamento deixa de existir. O tile aparece no
     * instante em que chega, em vez de esperar o proximo lote.
     *
     * A FONTE E O PROPRIO CANVAS, e nao o bitmap do tile. Copiar do canvas ja
     * composto garante que o pedaco subido e EXATAMENTE o que a subida inteira
     * poria ali: mesma reamostragem, mesma borda, mesmo antisserrilhado entre
     * tiles vizinhos. Subir o bitmap direto exigiria alinhar o canvas ao grid de
     * tiles, e uma costura de um pixel numa panoramica vira grade visivel.
     *
     * `flipY` E FALSO, e a UV compensa. O `texSubImage2D` grava a partir do
     * canto de cima, e com `flipY` ligado o pedaco entraria espelhado dentro do
     * proprio retangulo. Desligar inverte a imagem toda, e `repeat.y = -1` com
     * `offset.y = 1` desfaz a inversao na amostragem: a esfera ve o mesmo de
     * antes, provado por comparacao de pixel contra a versao anterior.
     *
     * @returns {boolean} true se o pedaco subiu, false se cabe a subida inteira
     */
    function marcarPedaco(dx, dy, dw, dh) {
        if (!renderizador || !textura || precisaSubirTudo) return false;

        // Inteiros para FORA: `texSubImage2D` nao aceita fracao, e arredondar
        // para dentro deixaria de fora a coluna de pixels da borda, que e
        // justamente onde dois tiles se encontram.
        const x0 = Math.max(0, Math.floor(dx));
        const y0 = Math.max(0, Math.floor(dy));
        const x1 = Math.min(canvas.width, Math.ceil(dx + dw));
        const y1 = Math.min(canvas.height, Math.ceil(dy + dh));
        if (x1 <= x0 || y1 <= y0) return true;

        pedaco = pedaco
            ? {
                x0: Math.min(pedaco.x0, x0), y0: Math.min(pedaco.y0, y0),
                x1: Math.max(pedaco.x1, x1), y1: Math.max(pedaco.y1, y1),
            }
            : { x0, y0, x1, y1 };
        return true;
    }

    /**
     * Sobe o retangulo acumulado, uma vez por quadro.
     *
     * UM POR QUADRO, E NAO UM POR TILE, e a diferenca foi medida. A primeira
     * versao subia cada tile na hora, e cada subida exige LER DE VOLTA um pedaco
     * do canvas grande, que mora na GPU. Cinquenta e cinco leituras por foto
     * custaram 117 ms de `drawImage` no perfil de maquina fraca, contra 10 ms
     * antes: a economia de banda voltava como custo de leitura.
     *
     * Juntar por quadro reduz as leituras a um punhado, e a caixa que envolve os
     * tiles de uma rajada e apertada porque eles chegam do centro da tela para
     * fora, um ao lado do outro. No pior caso a caixa e o canvas inteiro, que e
     * exatamente o que a versao anterior a esta fazia sempre.
     *
     * @returns {boolean} true se algo subiu
     */
    function subirPedacoAcumulado() {
        if (!pedaco || !renderizador || !textura || !recorte) return false;
        const { x0, y0, x1, y1 } = pedaco;
        pedaco = null;
        const w = x1 - x0;
        const h = y1 - y0;

        try {
            recorte.canvas.width = w;
            recorte.canvas.height = h;
            recorte.ctx.drawImage(canvas, x0, y0, w, h, 0, 0, w, h);
            recorte.textura.needsUpdate = true;
            renderizador.copyTextureToTexture(new THREE.Vector2(x0, y0), recorte.textura, textura);
            estat.uploadsParciais++;
            estat.bytesParaGpu += w * h * 4;
            return true;
        } catch (erro) {
            // Uma falha aqui nao pode deixar o tile invisivel: volta para a
            // subida inteira, que e o caminho de sempre, e o log diz o que houve.
            log(`subida parcial falhou (${erro.message}); voltando para a inteira`);
            renderizador = null;
            texturaSuja = true;
            return false;
        }
    }

    function desenharTile(nivel, x, y, bitmap) {
        if (!ctx || nivelAtual === null) return;
        // So dois niveis chegam ao canvas: o alvo e o nivel 0 do fundo.
        if (nivel !== nivelAtual && nivel !== 0) return;
        if (nivel === 0 && nivel !== nivelAtual && cobertoPorFino(x, y)) return;

        const info = niveis[nivel];
        const escala = canvas.width / info.width;
        const tam = descritor.tileSize;
        const dx = x * tam * escala;
        const dy = y * tam * escala;
        const dw = bitmap.width * escala;
        const dh = bitmap.height * escala;
        ctx.drawImage(bitmap, dx, dy, dw, dh);

        desenhados.add(`${nivel}/${x}/${y}`);
        if (marcarPedaco(dx, dy, dw, dh)) pedeQuadro = true;
        else texturaSuja = true;
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
     *
     * O NIVEL 0 NAO SAI. Ele e o FUNDO, e o fundo e o primeiro a entrar, ou seja
     * seria justamente o primeiro despejado. Antes isso nao machucava: o fundo
     * de verdade era o preview, que morava fora do cache, em `bitmapPreview`.
     * Agora o fundo e um tile como qualquer outro, e sem esta guarda uma sessao
     * longa de arrasto (mais de 256 tiles) o despejaria em silencio. O buraco so
     * apareceria na proxima reconstrucao do canvas, quando `repintarDoCache(0)`
     * nao achasse mais nada para pintar embaixo. Pinar custa pouco: o nivel 0 e
     * 1 tile na escada nova, e 8 na antiga.
     * @param {string} chave
     * @param {ImageBitmap} bitmap
     */
    function guardarNoCache(chave, bitmap) {
        cache.set(chave, bitmap);
        while (cache.size > MAX_TILES_EM_CACHE) {
            const velha = primeiraDespejavel();
            if (velha === null) break;
            const antigo = cache.get(velha);
            cache.delete(velha);
            if (antigo) antigo.close();
        }
    }

    /**
     * A chave mais antiga que pode ser despejada, pulando o nivel 0.
     * @returns {string|null} `null` quando so resta fundo no cache.
     */
    function primeiraDespejavel() {
        for (const chave of cache.keys()) {
            if (!chave.startsWith('0/')) return chave;
        }
        return null;
    }

    // ========================================================================
    // CICLO
    // ========================================================================

    /**
     * Recalcula nivel e tiles visiveis. Roda so quando a camera para, porque
     * arrastar dispara dezenas de eventos por segundo e cada recalculo pediria
     * o mesmo conjunto de novo.
     */
    /**
     * O canvas vale a pena ser refeito para esta largura?
     *
     * REFAZER NAO E DE GRACA, e a versao anterior refazia a qualquer diferenca
     * de um degrau de 1024 px. Como a largura pedida cresce com o inverso do
     * campo de visao, uma aproximacao comum passeia por varios degraus, e cada
     * um custa uma textura nova inteira. Medido num ciclo de zoom de 75 a 10
     * graus e de volta, a 1904x985: quatro canvas alocados, 369 MB subidos,
     * 184 MB alocados e pior quadro de 622 ms, sem BAIXAR UM TILE NOVO. Todo
     * aquele trabalho era o mesmo pixel subindo de novo, maior.
     *
     * A banda e assimetrica de proposito. Crescer exige ganho grande, porque o
     * detalhe que se ganha e sublinear (a tela ja mostra menos do que o canvas
     * tem) e o preco e uma textura inteira. Encolher exige ganho ainda maior,
     * porque a memoria devolvida so importa se for muita, e encolher no meio de
     * um gesto e o pior momento possivel.
     */
    function valeRefazerCanvas(alvo, atual) {
        if (alvo > atual * CRESCE_CANVAS) return true;
        if (alvo * ENCOLHE_CANVAS < atual) return true;
        return false;
    }

    function reavaliar() {
        if (!descritor) return;
        const nivel = nivelDesejado();
        // O canvas se refaz por DOIS motivos, e nao so por troca de nivel: a
        // largura util da tela tambem muda com zoom e com redimensionamento da
        // janela, e ela e quem dita o tamanho da textura.
        //
        // Trocar de nivel obriga: o desenho do tile usa `canvas.width /
        // info.width` como escala, e um canvas de outro nivel poria o tile no
        // lugar errado. Mudar so a largura util NAO obriga, e passa pela banda
        // de `valeRefazerCanvas`.
        const trocouNivel = nivel !== nivelAtual;
        const trocouCanvas = canvas !== null
            && valeRefazerCanvas(larguraDoCanvas(niveis[nivel]), canvas.width);
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
         * Carrega uma foto: descritor, fundo e, por fim, os tiles visiveis do
         * nivel alvo. Aborta o que a foto anterior ainda tinha em voo.
         *
         * NO CAMINHO PADRAO O FUNDO E O TILE DE NIVEL 0, e sao duas requisicoes
         * antes do detalhe (o `tiles.json` e o tile). A estrategia legada
         * 'preview' troca esse tile pelo `descritor.base`.
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

            // 1. Preview esticado, SO na estrategia legada. O caminho padrao
            // nao toca em `descritor.base`, porque ele aponta para
            // `image?quality=preview`, e esse dado vai ser apagado.
            if (fundoAtual === 'preview') {
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
            }

            // 2. Fundo de nivel 0. E ele que impede a esfera preta, e por isso
            // vem antes do detalhe.
            //
            // O lote e ESPERADO, e nao disparado junto do alvo: os dois
            // concorreriam no mesmo pool de 24, e um tile grosso que chegasse
            // depois de um fino apagaria o detalhe dele.
            //
            // O ALVO SER O PROPRIO NIVEL 0 DEIXOU DE SER CASO ESPECIAL. A versao
            // antiga pulava o fundo nesse estado, para o relogio do alvo nao
            // esconder o custo de tiles baixados fora dele. So que com a tela
            // sem area (painel recolhido, aba trocada) o alvo cai no nivel 0 e o
            // conjunto visivel sai VAZIO: ninguem baixava nada, e agora que o
            // preview nao vem mais a esfera ficaria preta ate a tela voltar.
            // Um tile de 11 a 18 KB nao distorce medida nenhuma, e o quadro
            // garantido vale mais. Quando o alvo repete o nivel 0, `pedirTiles`
            // acha a chave em `desenhados` e nao pede duas vezes.
            const tilesDoFundo = tilesDeFundo();
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
            if (!textura) return false;

            // A PRIMEIRA SUBIDA E SEMPRE INTEIRA. Ela leva o fundo de nivel 0 e
            // o que ja tiver sido repintado do cache, e e ela que da existencia
            // a textura na GPU: sem uma textura alocada, `texSubImage2D` nao tem
            // onde escrever.
            if (texturaSuja && precisaSubirTudo) {
                textura.needsUpdate = true;
                texturaSuja = false;
                precisaSubirTudo = false;
                ultimoUpload = performance.now();
                estat.uploads++;
                estat.bytesParaGpu += canvas.width * canvas.height * 4;
                return true;
            }

            // O retangulo acumulado sobe AQUI, no laco de quadro, e nao na
            // volta da rede: uma leitura por quadro em vez de uma por tile.
            if (pedeQuadro) {
                pedeQuadro = false;
                subirPedacoAcumulado();
                return true;
            }

            if (!texturaSuja) return false;

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
            estat.uploads++;
            estat.bytesParaGpu += canvas.width * canvas.height * 4;
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
