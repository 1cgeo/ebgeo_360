/**
 * @module tests/unit/tile-loader-canvas.test
 * @description O tamanho do canvas de textura quando a TELA NAO TEM AREA.
 *
 * O DEFEITO QUE ESTE ARQUIVO MATA. Em `larguraDoCanvas` a guarda de area zero
 * devolvia o TETO, que e `min(largura do nivel, maxTextura)`, ou seja o pior
 * caso. Painel recolhido, aba trocada ou container de altura zero levavam o
 * canvas ao nivel nativo: 7680x3840, 118 MB de textura reconstruidos para quem
 * nao esta vendo nada. `nivelDesejado` ja tratava o MESMO estado ao contrario,
 * segurando o nivel em uso, entao as duas contas discordavam e mandava a errada.
 *
 * O teste mede pela LARGURA REAL do canvas que o carregador criou, e nao por uma
 * copia da formula: copia da conta mediria a copia. A asercao aponta um numero,
 * porque intervalo aceitaria a conta errada junto com a certa.
 *
 * COMO O ARQUIVO REAL ENTRA AQUI. O ebgeo_360 e um servico, e nao instala
 * `three`: o navegador o recebe por importmap. O texto vem do disco e so os dois
 * imports de topo viram especificadores absolutos, com um `three` de mentira.
 * Reescrever o import nao toca na conta sob teste.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { montarEscada } from '../../public/calibration/js/pyramid-math.js';

const PASTA = new URL('../../public/calibration/js/', import.meta.url);

/** Lado do tile em toda a piramide do acervo. */
const TILE = 512;

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
 * DENTRO de uma aspa simples do arquivo reescrito. A primeira aspa do codigo
 * fechava a string e o modulo nem compilava.
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
 * Um canvas de mentira que guarda largura e altura. E o unico observavel do
 * teste: o carregador escreve `canvas.width` e o entrega dentro da textura.
 * @returns {Object}
 */
function canvasFalso() {
    return {
        width: 0,
        height: 0,
        getContext: () => ({ drawImage() {} }),
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
        base: 'preview.webp',
        template: '{level}/{x}/{y}.webp',
        levels: montarEscada(largura, altura, TILE, razao),
    };
}

/**
 * Instala o ambiente de navegador que o carregador exige, e devolve o desfazer.
 * O `fetch` responde o descritor pedido, e qualquer outra coisa vira um corpo
 * curto, que o `createImageBitmap` de mentira transforma num tile qualquer.
 * @param {Object} descritor
 * @returns {() => void} Desfaz tudo o que foi instalado.
 */
function instalarNavegador(descritor) {
    const antes = {
        document: globalThis.document,
        location: globalThis.location,
        fetch: globalThis.fetch,
        createImageBitmap: globalThis.createImageBitmap,
    };

    const corpoDescritor = new TextEncoder().encode(JSON.stringify(descritor)).buffer;
    const resposta = (corpo) => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        async arrayBuffer() { return corpo; },
    });

    globalThis.document = { createElement: () => canvasFalso() };
    globalThis.location = { href: 'http://teste.local/', pathname: '/calibration/x.html' };
    globalThis.fetch = async (url) => (
        String(url).endsWith('tiles.json')
            ? resposta(corpoDescritor)
            : resposta(new ArrayBuffer(64))
    );
    globalThis.createImageBitmap = async () => ({ width: TILE, height: TILE, close() {} });

    return () => {
        for (const [chave, valor] of Object.entries(antes)) {
            if (valor === undefined) delete globalThis[chave];
            else globalThis[chave] = valor;
        }
    };
}

/** Camera do monitor MEDIDO no piloto: 1904x985 pede 6119 px de panoramica. */
const MONITOR = { lon: 0, lat: 0, fov: 75, largura: 1904, altura: 985 };

test('tela sem area SEGURA o canvas, em vez de ir ao nativo', async () => {
    // O formato pesado do acervo: 22 mil fotos de 7680x3840, escada de razao 1,6.
    const descritor = descritorDe(7680, 3840, 1.6);
    const nativo = descritor.levels[descritor.levels.length - 1].width;
    const desfazer = instalarNavegador(descritor);
    const { createTileLoader } = await importarTileLoader();
    const carregador = createTileLoader({ gl: null, base: 'http://teste.local/api/v1' });

    try {
        carregador.atualizarCamera(MONITOR);
        await carregador.carregarFoto('foto-1');

        // 6119 px quantizados para cima em passos de 1024 dao 6144, e o nativo
        // de 7680 fica de fora: o degrau e a conta que consertou o travamento.
        const texturaAntes = carregador.getTextura();
        assert.equal(texturaAntes.image.width, 6144);

        // O painel recolhe, ou a aba troca. `fixarNivel(null)` nao muda estado
        // nenhum (o nivel ja e automatico), e serve so para disparar `reavaliar`
        // na hora, sem esperar o debounce de 120 ms.
        carregador.atualizarCamera({ largura: 0, altura: 0 });
        carregador.fixarNivel(null);

        const depois = carregador.getTextura();
        assert.notEqual(depois.image.width, nativo,
            'area zero levou o canvas ao nivel nativo, que e o pior caso');
        assert.equal(depois.image.width, 6144);
        // Mesma textura, ou seja o canvas nem chegou a ser refeito. A versao
        // antiga trocava o objeto aqui, porque 7680 diferia de 6144.
        assert.equal(depois, texturaAntes,
            'area zero reconstruiu a textura de quem nao esta vendo nada');
    } finally {
        carregador.dispose();
        desfazer();
    }
});

test('sem canvas ainda, area zero fica no nivel 0, que hoje cabe num tile', async () => {
    // Primeira foto com o container ja recolhido: nao ha canvas para segurar.
    //
    // A ESCADA MUDOU EMBAIXO DESTE CASO. Ela desce ate o nivel caber em um tile,
    // entao o 5760 ganhou dois degraus (360 e 720) e o nivel 0 saiu de 1440 para
    // 360. A conta sob teste nao mudou, e o nivel escolhido continua sendo o 0.
    const descritor = descritorDe(5760, 2880, 2);
    const nativo = descritor.levels[descritor.levels.length - 1].width;
    const desfazer = instalarNavegador(descritor);
    const { createTileLoader } = await importarTileLoader();
    const carregador = createTileLoader({ gl: null, base: 'http://teste.local/api/v1' });

    try {
        carregador.atualizarCamera({ lon: 0, lat: 0, fov: 75, largura: 0, altura: 0 });
        await carregador.carregarFoto('foto-2');

        // O nivel escolhido e o 0, o mais grosso, porque `nivelDesejado` ja
        // segurava esse caso.
        assert.equal(carregador.getEstatisticas().nivel, 0);
        assert.equal(descritor.levels[0].width, 360);
        assert.equal(carregador.getTextura().image.width, 360);
        assert.notEqual(carregador.getTextura().image.width, nativo,
            'area zero levou o canvas ao nivel nativo, que e o pior caso');
    } finally {
        carregador.dispose();
        desfazer();
    }
});

test('sem canvas ainda, o nivel travado a mao para no degrau, e nao no teto', async () => {
    // ESTE CASO GUARDA O DEFEITO ORIGINAL, que o caso acima deixou de separar.
    //
    // O defeito era `larguraDoCanvas` devolver o TETO na guarda de area zero.
    // Enquanto a escada parava em 2048, o nivel 0 de 5760 media 1440, e o teto
    // (1440) diferia do degrau (1024): o numero acusava. Agora o nivel 0 cabe em
    // um tile e mede 360, entao o teto e o degrau dao o mesmo valor, e a conta
    // errada passaria verde ali.
    //
    // Quem ainda separa os dois e o nivel TRAVADO A MAO, que o painel de
    // calibracao oferece. Travar o nivel 3 com o container recolhido poe um teto
    // de 2880 na guarda de area zero: a conta certa corta em 1024, e a errada
    // reconstroi 2880x1440 de textura para quem nao esta vendo nada.
    const descritor = descritorDe(5760, 2880, 2);
    const desfazer = instalarNavegador(descritor);
    const { createTileLoader } = await importarTileLoader();
    const carregador = createTileLoader({ gl: null, base: 'http://teste.local/api/v1' });

    try {
        // O nivel se fixa ANTES da foto, de proposito. Com um canvas ja em pe a
        // guarda cai no outro ramo, o que segura a largura em uso, e o degrau
        // nunca entraria na conta.
        carregador.fixarNivel(3);
        carregador.atualizarCamera({ lon: 0, lat: 0, fov: 75, largura: 0, altura: 0 });
        await carregador.carregarFoto('foto-2b');

        assert.equal(carregador.getEstatisticas().nivel, 3);
        assert.equal(descritor.levels[3].width, 2880);
        assert.equal(carregador.getTextura().image.width, 1024,
            'sem canvas, area zero escolheu o teto do nivel em vez do menor degrau');
    } finally {
        carregador.dispose();
        desfazer();
    }
});

test('tela COM area continua quantizando em passos de 1024', async () => {
    // Guarda de regressao: o conserto so pode tocar no ramo de area zero.
    const descritor = descritorDe(7680, 3840, 1.6);
    const desfazer = instalarNavegador(descritor);
    const { createTileLoader } = await importarTileLoader();
    const carregador = createTileLoader({ gl: null, base: 'http://teste.local/api/v1' });

    try {
        // O notebook do piloto, 1350x673, pede 4264 px. O degrau sobe para 5120,
        // e o TETO do nivel escolhido, o de 4800, e quem corta: canvas nunca
        // passa do nivel que o esta enchendo, senao os tiles sairiam esticados.
        //
        // O NIVEL DE 4800 VIROU O 5, e era o 2. A escada de 7680 desce ate caber
        // num tile e passou de 4 degraus para 7 (458, 733, 1172, 1875, 3000,
        // 4800, 7680): a numeracao empurrou tres casas, e a largura escolhida
        // continua a mesma.
        carregador.atualizarCamera({ lon: 0, lat: 0, fov: 75, largura: 1350, altura: 673 });
        await carregador.carregarFoto('foto-3');
        assert.equal(carregador.getEstatisticas().nivel, 5);
        assert.equal(descritor.levels[5].width, 4800);
        assert.equal(carregador.getTextura().image.width, 4800);
    } finally {
        carregador.dispose();
        desfazer();
    }
});
