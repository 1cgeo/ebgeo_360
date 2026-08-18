/**
 * @module tests/unit/tile-loader-fundo.test
 * @description O FUNDO do carregador depois que a escada passou a descer ate um
 * tile.
 *
 * O QUE ESTE ARQUIVO PROTEGE. O fundo era o `descritor.base`, que aponta para
 * `image?quality=preview`. O `preview_webp` vai ser APAGADO do disco, entao o
 * cliente nao pode mais pedi-lo em caminho nenhum que seja padrao. O fundo
 * passou a ser o tile de nivel 0, que a escada nova faz caber num tile so.
 *
 * Tres coisas quebram calado se ninguem medir:
 *   1. um caminho padrao que volte a pedir `quality=preview` ou `quality=full`
 *      so aparece como 404 no log quando o dado sumir do servidor;
 *   2. o fundo chegar DEPOIS do detalhe apaga o detalhe, porque tile grosso
 *      pinta por cima;
 *   3. o tile de fundo ser despejado do cache deixa a esfera com buraco na
 *      proxima reconstrucao do canvas, e nao lanca erro nenhum.
 *
 * COMO O ARQUIVO REAL ENTRA AQUI. O ebgeo_360 e um servico, e nao instala
 * `three`: o navegador o recebe por importmap. O texto vem do disco e so os dois
 * imports de topo viram especificadores absolutos, com um `three` de mentira.
 * Reescrever o import nao toca no que esta sob teste.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { montarEscada } from '../../public/calibration/js/pyramid-math.js';

const PASTA = new URL('../../public/calibration/js/', import.meta.url);

/** Lado do tile em toda a piramide do acervo. */
const TILE = 512;

/**
 * Bytes do corpo de um tile de NIVEL 0 no `fetch` de mentira.
 *
 * O numero e a identidade do objeto, e nao enfeite: `createImageBitmap` so
 * recebe o Blob, e e por este tamanho que ele sabe se esta decodificando o fundo
 * ou um tile fino. Ele tambem e o que `bytesFundo` tem de somar.
 * @constant {number}
 */
const BYTES_FUNDO = 7;

/** Bytes do corpo de qualquer outro tile. */
const BYTES_TILE = 64;

/**
 * Um `three` de mentira, so com o que o carregador toca. Sem ele o import de
 * topo derruba o arquivo de teste inteiro, antes da primeira asercao.
 */
const THREE_FALSO = comoModulo(`
export const SRGBColorSpace = 'srgb';
export const LinearFilter = 1006;
export class CanvasTexture {
  constructor(imagem) { this.image = imagem; this.needsUpdate = false; }
  dispose() { this.descartada = true; }
}
`);

/**
 * Empacota codigo num modulo importavel. BASE64, e nao texto por cento: o
 * `encodeURIComponent` deixa a aspa simples passar, e a URL do dublê entra
 * DENTRO de uma aspa simples do arquivo reescrito.
 * @param {string} codigo
 * @returns {string} URL `data:` do modulo.
 */
function comoModulo(codigo) {
    return `data:text/javascript;base64,${Buffer.from(codigo, 'utf8').toString('base64')}`;
}

/**
 * Importa o `tile-loader.js` REAL, com os imports de topo reescritos.
 * @returns {Promise<Object>} O modulo, com `createTileLoader`.
 */
async function importarTileLoader() {
    const fonte = await readFile(new URL('tile-loader.js', PASTA), 'utf8');
    const reescrita = fonte
        .replace("from 'three'", `from '${THREE_FALSO}'`)
        .replace(
            "from './pyramid-math.js'",
            `from '${new URL('pyramid-math.js', PASTA).href}'`,
        );
    return import(comoModulo(reescrita));
}

/**
 * Um canvas de mentira que ANOTA cada pintura.
 *
 * A anotacao guarda a marca do bitmap e a largura pintada, porque e assim que o
 * teste separa o fundo (uma pintura do canvas inteiro) de um tile fino (um
 * pedaco). Sem isso o unico observavel seria a largura do canvas, que nao diz
 * nada sobre o que foi desenhado dentro dele.
 * @returns {Object}
 */
function canvasFalso() {
    const pinturas = [];
    return {
        width: 0,
        height: 0,
        pinturas,
        getContext: () => ({
            drawImage(bitmap, dx, dy, dw, dh) {
                pinturas.push({ marca: bitmap.marca, dx, dy, dw, dh });
            },
        }),
    };
}

/**
 * Um descritor `tiles.json` valido, na escada real do formato pedido.
 * @param {number} largura - Largura nativa em pixels.
 * @param {number} altura - Altura nativa em pixels.
 * @param {number} razao - A razao daquele formato: 1,6 em 7680, 2 no resto.
 * @returns {Object}
 */
function descritorDe(largura, altura, razao) {
    return {
        schemaVersion: 1,
        tileSize: TILE,
        // O MESMO valor que a rota grava (phototiles.js:234). O teste tem de
        // reprovar exatamente esta URL, e nao uma parecida.
        base: 'image?quality=preview',
        template: '{level}/{x}/{y}.webp',
        levels: montarEscada(largura, altura, TILE, razao),
    };
}

/**
 * Instala o ambiente de navegador que o carregador exige, e devolve o desfazer.
 *
 * O `fetch` ANOTA toda URL pedida, na ordem: e esse registro que prova que o
 * caminho padrao nao pede o preview, e que o fundo vem antes do detalhe.
 *
 * @param {Object} descritor
 * @param {string[]} log - Recebe as URLs, na ordem em que forem pedidas.
 * @returns {() => void} Desfaz tudo o que foi instalado.
 */
function instalarNavegador(descritor, log) {
    const antes = {
        document: globalThis.document,
        location: globalThis.location,
        fetch: globalThis.fetch,
        createImageBitmap: globalThis.createImageBitmap,
    };

    const nivel0 = descritor.levels[0];
    const corpoDescritor = new TextEncoder().encode(JSON.stringify(descritor)).buffer;
    const resposta = (corpo) => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        async arrayBuffer() { return corpo; },
    });

    globalThis.document = { createElement: () => canvasFalso() };
    globalThis.location = { href: 'http://teste.local/', pathname: '/calibration/x.html' };
    globalThis.fetch = async (url) => {
        const alvo = String(url);
        log.push(alvo);
        if (alvo.endsWith('tiles.json')) return resposta(corpoDescritor);
        // O tile de nivel 0 responde um corpo de tamanho unico, para o
        // decodificador de mentira saber quem ele e.
        if (/\/0\/0\/0\.webp$/.test(alvo)) {
            // E responde DEVAGAR, de proposito. A ordem em que as URLs sao
            // PEDIDAS nao distingue esperar o lote do fundo de so dispara-lo:
            // `pedirTiles` chama `bombear` na hora, entao o fundo sai na frente
            // nos dois desenhos. O que distingue e a ordem em que as respostas
            // PINTAM, e ela so muda se o fundo demorar mais que o detalhe.
            await new Promise((resolve) => { setTimeout(resolve, 5); });
            return resposta(new ArrayBuffer(BYTES_FUNDO));
        }
        return resposta(new ArrayBuffer(BYTES_TILE));
    };
    globalThis.createImageBitmap = async (blob) => (
        blob.size === BYTES_FUNDO
            // O bitmap do fundo tem a largura do NIVEL, e nao 512: o nivel 0
            // cabe em um tile, entao o tile e menor que o proprio tile.
            ? { width: nivel0.width, height: nivel0.height, marca: 'fundo', close() {} }
            : { width: TILE, height: TILE, marca: 'fino', close() {} }
    );

    return () => {
        for (const [chave, valor] of Object.entries(antes)) {
            if (valor === undefined) delete globalThis[chave];
            else globalThis[chave] = valor;
        }
    };
}

/** Camera do monitor MEDIDO no piloto: 1904x985 pede 6119 px de panoramica. */
const MONITOR = { lon: 0, lat: 0, fov: 75, largura: 1904, altura: 985 };

/**
 * Espera a fila do carregador esvaziar.
 *
 * `carregarFoto` NAO espera o lote do nivel alvo, de proposito: quem chama quer
 * a foto na tela, e nao o fim do download. O teste precisa do fim.
 *
 * @param {Object} carregador
 * @returns {Promise<void>}
 */
async function esperarFila(carregador) {
    for (let volta = 0; volta < 20000; volta++) {
        if (carregador.getEstatisticas().pendentes === 0) return;
        await new Promise((resolve) => { setTimeout(resolve, 0); });
    }
    throw new Error('a fila do carregador nao esvaziou');
}

test('o caminho padrao NAO pede o preview nem o full', async () => {
    const descritor = descritorDe(7680, 3840, 1.6);
    const log = [];
    const desfazer = instalarNavegador(descritor, log);
    const { createTileLoader, ESTRATEGIA_FUNDO_PADRAO } = await importarTileLoader();
    const carregador = createTileLoader({ gl: null, base: 'http://teste.local/api/v1' });

    try {
        assert.equal(ESTRATEGIA_FUNDO_PADRAO, 'nivel0');
        carregador.atualizarCamera(MONITOR);
        await carregador.carregarFoto('foto-1');
        await esperarFila(carregador);

        const pedidas = log.join('\n');
        assert.ok(!pedidas.includes('quality=preview'),
            'o caminho padrao pediu o preview, que vai ser apagado do disco');
        assert.ok(!pedidas.includes('quality=full'),
            'o caminho padrao pediu o full, que vai ser apagado do disco');

        // O fundo E o tile de nivel 0, e os bytes dele sao os do tile: 7 no
        // `fetch` de mentira. `bytesPreview` fica zerado porque nao houve
        // preview nenhum.
        const estat = carregador.getEstatisticas();
        assert.equal(estat.bytesPreview, 0);
        assert.equal(estat.bytesFundo, BYTES_FUNDO);
        assert.ok(log.some((u) => u.endsWith('/0/0/0.webp')),
            'o tile de nivel 0, que e o fundo, nao foi pedido');
    } finally {
        carregador.dispose();
        desfazer();
    }
});

test('o fundo PINTA antes do primeiro tile do nivel alvo', async () => {
    // O lote do fundo e ESPERADO, e nao so disparado. Sem a espera os dois lotes
    // disputam o mesmo pool de 24, e o tile grosso que chega atrasado pinta por
    // cima do detalhe que ja chegou. Aqui o fundo responde 5 ms depois dos
    // finos, entao so a espera de verdade mantem a ordem.
    const descritor = descritorDe(7680, 3840, 1.6);
    const log = [];
    const desfazer = instalarNavegador(descritor, log);
    const { createTileLoader } = await importarTileLoader();
    const carregador = createTileLoader({ gl: null, base: 'http://teste.local/api/v1' });

    try {
        carregador.atualizarCamera(MONITOR);
        await carregador.carregarFoto('foto-2');
        await esperarFila(carregador);

        // O nivel alvo do monitor e o 6, o nativo.
        assert.equal(carregador.getEstatisticas().nivel, 6);
        const pinturas = carregador.getTextura().image.pinturas;
        assert.ok(pinturas.length > 1, 'o canvas nao recebeu pintura nenhuma');
        assert.equal(pinturas[0].marca, 'fundo',
            'um tile fino pintou antes do fundo, e o fundo apagaria o detalhe');
        assert.ok(pinturas.slice(1).some((p) => p.marca === 'fino'),
            'nenhum tile do nivel alvo pintou');
    } finally {
        carregador.dispose();
        desfazer();
    }
});

test('nivel 0 cabe em UM tile nos tres formatos do acervo', async () => {
    // E ESTA a premissa que unificou 'nivel0' e 'nivel0vis'. Com um tile so nao
    // ha conjunto visivel a recortar: os dois nomes descreviam o mesmo pedido.
    // Se a escada voltar a parar antes, os nomes precisam voltar tambem.
    const formatos = [
        { largura: 7680, altura: 3840, razao: 1.6, niveis: 7, base: 458 },
        { largura: 5760, altura: 2880, razao: 2, niveis: 5, base: 360 },
        { largura: 2048, altura: 1024, razao: 2, niveis: 3, base: 512 },
    ];
    const { ESTRATEGIAS_FUNDO } = await importarTileLoader();

    for (const f of formatos) {
        const escada = montarEscada(f.largura, f.altura, TILE, f.razao);
        assert.equal(escada.length, f.niveis, `escada de ${f.largura}`);
        assert.equal(escada[0].width, f.base);
        assert.equal(escada[0].cols * escada[0].rows, 1,
            `o nivel 0 de ${f.largura} deixou de caber em um tile`);
    }
    assert.deepEqual(ESTRATEGIAS_FUNDO, ['nivel0', 'preview'],
        "'nivel0vis' voltou, e ele descreve o mesmo pedido que 'nivel0'");
});

test('a estrategia legada preview ainda pede o descritor.base', async () => {
    // Ela existe so enquanto o `preview_webp` existir no disco. Enquanto durar,
    // ela tem de continuar funcionando, e NAO pode baixar o tile de fundo junto:
    // seriam duas imagens grossas para a mesma funcao.
    const descritor = descritorDe(5760, 2880, 2);
    const log = [];
    const desfazer = instalarNavegador(descritor, log);
    const { createTileLoader } = await importarTileLoader();
    const carregador = createTileLoader({ gl: null, base: 'http://teste.local/api/v1' });

    try {
        carregador.atualizarCamera(MONITOR);
        await carregador.carregarFoto('foto-3', { estrategiaFundo: 'preview' });
        await esperarFila(carregador);

        assert.equal(carregador.getEstrategiaFundo(), 'preview');
        assert.ok(log.some((u) => u.endsWith('image?quality=preview')),
            'a estrategia legada deixou de pedir o descritor.base');
        assert.ok(!log.some((u) => u.endsWith('/0/0/0.webp')),
            'a estrategia legada baixou o preview E o tile de fundo');
    } finally {
        carregador.dispose();
        desfazer();
    }
});

test('o tile de fundo sobrevive ao despejo do cache', async () => {
    // O DEFEITO QUE ESTE TESTE MATA. O fundo e o PRIMEIRO objeto a entrar no
    // cache, e o cache despeja pela ordem de insercao. Antes isso nao machucava,
    // porque o fundo era o preview e morava fora do cache. Agora ele e um tile
    // como qualquer outro, e uma vista que peca mais de 256 tiles o despejaria.
    // O sintoma seria buraco na esfera na proxima reconstrucao do canvas, sem
    // erro nenhum no console.
    //
    // A foto de 30720x15360 nao existe no acervo, e e de proposito: ela e a
    // menor maneira de pedir mais de 256 tiles numa vista so. O acervo real
    // (7680) tem 196 tiles somando TODOS os niveis, e nunca encheria o cache.
    const descritor = descritorDe(30720, 15360, 1.6);
    const log = [];
    const desfazer = instalarNavegador(descritor, log);
    const { createTileLoader } = await importarTileLoader();
    const carregador = createTileLoader({ gl: null, base: 'http://teste.local/api/v1' });

    try {
        // Fov 179 numa tela larga: a vista pega todas as colunas do nivel 8, que
        // tem 38x19 tiles.
        carregador.atualizarCamera({ lon: 0, lat: 0, fov: 179, largura: 6000, altura: 3000 });
        await carregador.carregarFoto('foto-4');
        await esperarFila(carregador);

        assert.equal(carregador.getEstatisticas().nivel, 8);
        assert.ok(carregador.getEstatisticas().tilesPedidos > 256,
            'a vista nao encheu o cache, entao o teste nao prova nada');

        // Troca de nivel, que joga o canvas fora e o repinta do cache. Um nivel
        // do meio, e nao o 0: se o alvo fosse o proprio nivel 0, o lote do alvo
        // baixaria o tile de novo e esconderia o despejo.
        carregador.fixarNivel(5);
        const canvas = carregador.getTextura().image;
        const doFundo = canvas.pinturas.filter((p) => p.marca === 'fundo');
        assert.equal(doFundo.length, 1,
            'o canvas novo nao recebeu o fundo: o tile de nivel 0 foi despejado');
        // Ele cobre o canvas inteiro, e nao um pedaco de tile.
        assert.equal(doFundo[0].dw, canvas.width);
        assert.equal(doFundo[0].dx, 0);
    } finally {
        carregador.dispose();
        desfazer();
    }
});
