/**
 * @module tests/integration/phototiles.test
 * @description Testes de integracao das duas rotas de tile da panoramica:
 *
 *   GET /api/v1/photos/:uuid/tiles.json          descritor da piramide
 *   GET /api/v1/photos/:uuid/tiles/:level/:x/:y  um tile WebP
 *
 * A fonte da verdade aqui e o contrato de tiles 360, e nao o que a rota fizer:
 * o corpo do descritor e comparado INTEIRO contra o literal do contrato, porque
 * ele e a unidade portavel que o cliente copia verbatim.
 *
 * A ESCADA DESCE ATE CABER EM UM TILE desde 2026-08-18, e nao ate 2048. O nivel
 * mais grosso passou a ser o proprio preview, e a piramide basta sozinha. Toda
 * piramide da fixture ganhou niveis embaixo, e a NUMERACAO EMPURROU: o que era
 * level 0 virou level 2 ou 3. O contrato de level 0 ser o mais grosso nao mudou.
 *
 * Quatro convencoes decidem quase todo teste deste arquivo:
 *   - level 0 e o MAIS GROSSO, e maxLevel e a resolucao nativa;
 *   - cols NAO e 2^level (aqui e 1, 2, 3 e depois 5), entao a faixa valida de x
 *     muda por nivel e a matematica XYZ do tiles.js nao serve;
 *   - a borda e RECORTADA, entao o ultimo tile mede o resto, nunca 512;
 *   - a escada sai de (width, height, tileSize, razao), e a RAZAO vem gravada na
 *     piramide. Reconstruir com outra razao nao estoura: produz outra grade, e o
 *     sintoma e tile faltando na tela. Por isso a fixture tem uma piramide de
 *     razao 1,6 e um banco SEM a coluna, e as duas sao conferidas grade a grade;
 *   - a URL do tile leva o TOKEN DE GERACAO (`?v=<total_bytes>`), porque o tile
 *     e servido com immutable de um ano. Sem o token, regerar a piramide muda a
 *     escada e nao muda a URL de tile nenhum.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import sharp from 'sharp';
import { createTestData, destroyTestData, SEEDS } from '../helpers/test-db.js';
import { createTilesFixture, TILE_SEEDS, chaveTile } from '../helpers/tiles-db.js';

const T = TILE_SEEDS;

let app;
let dataDir;
let fixture;
let computeImageETag;
let computeMetadataETag;

/**
 * URL do descritor de uma foto.
 * @param {string} uuid - UUID da foto
 * @returns {string} Caminho do descritor
 */
const urlDescritor = uuid => `/api/v1/photos/${uuid}/tiles.json`;

/**
 * URL de um tile. O ultimo segmento leva a extensao, como no template.
 * @param {string} uuid - UUID da foto
 * @param {number|string} level - Nivel
 * @param {number|string} x - Coluna
 * @param {number|string} y - Linha
 * @returns {string} Caminho do tile
 */
const urlTile = (uuid, level, x, y) => `/api/v1/photos/${uuid}/tiles/${level}/${x}/${y}.webp`;

before(async () => {
  ({ dataDir } = createTestData());
  process.env.STREETVIEW_DATA_DIR = dataDir;
  fixture = await createTilesFixture(dataDir);

  // Falha alta e clara enquanto a rota nao existir. A guarda equivalente em
  // build-app.js protege os OUTROS arquivos de teste, e nao este.
  assert.ok(
    existsSync(new URL('../../src/routes/phototiles.js', import.meta.url)),
    'src/routes/phototiles.js nao existe: as rotas de tile ainda nao foram implementadas',
  );

  ({ computeImageETag, computeMetadataETag } = await import('../../src/middleware/cache.js'));
  const { buildApp } = await import('../helpers/build-app.js');
  app = await buildApp();
});

after(async () => {
  if (app) await app.close();
  // As conexoes de tiles que ROTACIONARAM pertencem a tiles-queries.js, e o
  // closeAll() de destroyTestData nao as alcanca. No Windows um handle aberto
  // segura o arquivo, e o rmSync do dataDir volta EPERM. server.js fecha as duas
  // donarias no shutdown pela mesma razao.
  const { resetTileStatements } = await import('../../src/db/tiles-queries.js');
  resetTileStatements();
  await destroyTestData(dataDir);
});

// ============================================================================
// GET /api/v1/photos/:uuid/tiles.json: descritor
// ============================================================================

describe('GET /api/v1/photos/:uuid/tiles.json', () => {
  it('devolve 200 com o documento exato do contrato', async () => {
    const res = await app.inject({ method: 'GET', url: urlDescritor(T.TILED_PHOTO_ID) });
    assert.equal(res.statusCode, 200);

    // Comparacao do documento INTEIRO: campo a mais, campo a menos ou nome
    // trocado ('col' em vez de 'x', 'z' em vez de 'level', 'image/webp' em vez
    // de 'webp') reprova aqui. Os numeros saem da geometria da fixture, com a
    // conta do ceil feita a mao de proposito, para o teste nao repetir a formula
    // que ele deveria estar conferindo.
    assert.deepEqual(JSON.parse(res.body), {
      schemaVersion: 1,
      photoId: T.TILED_PHOTO_ID,
      projectSlug: SEEDS.PROJECT_SLUG,
      format: 'webp',
      encoder: { quality: 80 },
      tileSize: 512,
      // A fixture GRAVA razao 2 nesta piramide, e o descritor publica o valor
      // gravado, nunca um calculado. Sem ele a escada nao se reproduz fora daqui.
      razao: 2,
      width: 2560,
      height: 1280,
      origin: 'top-left',
      edge: 'crop',
      wrapX: true,
      minLevel: 0,
      // A ESCADA DESCE ATE CABER EM UM TILE, e nao ate 2048. 2560 desce 1280,
      // 640 e 320, e para em 320 porque 320 nao passa do tile de 512. Sao 4
      // niveis, e nao 2: o nivel mais grosso E o preview de antes, e a piramide
      // basta sozinha. A numeracao EMPURROU, e o que era level 0 virou level 2.
      maxLevel: 3,
      base: 'image?quality=preview',
      // O token de geracao sai do total_bytes MEDIDO nos BLOBs que a fixture
      // gravou, o mesmo numero que valida o ETag do tile. Escrever o literal
      // aqui amarraria o teste a um tamanho de WebP que a versao do sharp muda.
      template: `tiles/{level}/{x}/{y}.webp?v=${fixture.totalBytes}`,
      levels: [
        { level: 0, width: 320, height: 160, cols: 1, rows: 1 },
        { level: 1, width: 640, height: 320, cols: 2, rows: 1 },
        { level: 2, width: 1280, height: 640, cols: 3, rows: 2 },
        { level: 3, width: 2560, height: 1280, cols: 5, rows: 3 },
      ],
    });
  });

  it('devolve application/json', async () => {
    const res = await app.inject({ method: 'GET', url: urlDescritor(T.TILED_PHOTO_ID) });
    assert.ok(res.headers['content-type']?.includes('application/json'));
  });

  it('publica template e base RELATIVOS ao documento', async () => {
    // URL absoluta esta proibida: atras do location /ebgeo_360/ o prefixo nao
    // viaja no pedido, e a absoluta montada aqui daria 404 do lado de fora.
    const { template, base } = JSON.parse(
      (await app.inject({ method: 'GET', url: urlDescritor(T.TILED_PHOTO_ID) })).body,
    );
    for (const valor of [template, base]) {
      assert.ok(!/^https?:\/\//.test(valor), `URL absoluta no descritor: ${valor}`);
      assert.ok(!valor.startsWith('/'), `caminho absoluto no descritor: ${valor}`);
    }

    // Resolvidos contra a URL do documento, os dois tem de cair nas rotas reais.
    const doc = new URL(urlDescritor(T.TILED_PHOTO_ID), 'https://exemplo.invalid');
    const tile = new URL(template.replace('{level}', '3').replace('{x}', '2').replace('{y}', '1'), doc);
    assert.equal(tile.pathname, urlTile(T.TILED_PHOTO_ID, 3, 2, 1));
    assert.equal(
      new URL(base, doc).pathname + new URL(base, doc).search,
      `/api/v1/photos/${T.TILED_PHOTO_ID}/image?quality=preview`,
    );
  });

  it('valida com no-cache e ETag da assinatura da piramide', async () => {
    const res = await app.inject({ method: 'GET', url: urlDescritor(T.TILED_PHOTO_ID) });
    assert.ok(res.headers['cache-control']?.includes('no-cache'));
    assert.ok(!res.headers['cache-control']?.includes('immutable'));

    // Assinatura do contrato: photoId|width|height|tileSize|maxLevel|quality|totalBytes|builtAt
    const assinatura = [
      T.TILED_PHOTO_ID, T.TILED_WIDTH, T.TILED_HEIGHT, T.TILE_SIZE,
      T.TILED_MAX_LEVEL, T.QUALITY, fixture.totalBytes, T.BUILT_AT,
    ].join('|');
    assert.equal(res.headers['etag'], `"${computeMetadataETag(assinatura)}"`);
  });

  it('devolve 304 quando o If-None-Match casa', async () => {
    const primeira = await app.inject({ method: 'GET', url: urlDescritor(T.TILED_PHOTO_ID) });
    const etag = primeira.headers['etag'];
    assert.ok(etag);

    const segunda = await app.inject({
      method: 'GET',
      url: urlDescritor(T.TILED_PHOTO_ID),
      headers: { 'if-none-match': etag },
    });
    assert.equal(segunda.statusCode, 304);
    assert.equal(segunda.body, '');
  });

  it('devolve 200 quando o If-None-Match nao casa', async () => {
    const res = await app.inject({
      method: 'GET',
      url: urlDescritor(T.TILED_PHOTO_ID),
      headers: { 'if-none-match': '"piramide-velha"' },
    });
    assert.equal(res.statusCode, 200);
  });

  it('devolve 404 Tile not found para foto sem piramide', async () => {
    const res = await app.inject({ method: 'GET', url: urlDescritor(T.NO_PYRAMID_PHOTO_ID) });
    assert.equal(res.statusCode, 404);
    assert.equal(JSON.parse(res.body).error, 'Tile not found');
  });

  it('devolve 404 Photo not found para uuid inexistente', async () => {
    const res = await app.inject({ method: 'GET', url: urlDescritor(T.MISSING_PHOTO_ID) });
    assert.equal(res.statusCode, 404);
    assert.equal(JSON.parse(res.body).error, 'Photo not found');
  });

  it('devolve 404 para foto apagada, mesmo com a piramide gravada', async () => {
    // A foto TEM linha em tile_pyramids e TEM tiles no banco: quem a exclui e a
    // lapide em deleted_photos. Uma implementacao que so consulta tile_pyramids
    // responde 200 aqui e vaza foto apagada.
    assert.ok(fixture.deletedTiles.size > 0);

    const res = await app.inject({ method: 'GET', url: urlDescritor(T.DELETED_PHOTO_ID) });
    assert.equal(res.statusCode, 404);
    assert.equal(JSON.parse(res.body).error, 'Photo not found');
  });

  it('devolve 404 para projeto sem banco de tiles, e o servico segue de pe', async () => {
    const semBanco = await app.inject({ method: 'GET', url: urlDescritor(T.NO_DB_PHOTO_ID) });
    assert.equal(semBanco.statusCode, 404);
    assert.equal(JSON.parse(semBanco.body).error, 'Tile not found');

    // O arquivo ausente nao pode derrubar o processo nem envenenar a conexao
    // cacheada: a foto com piramide continua respondendo.
    const comBanco = await app.inject({ method: 'GET', url: urlDescritor(T.TILED_PHOTO_ID) });
    assert.equal(comBanco.statusCode, 200);
  });
});

// ============================================================================
// O token de geracao na URL do tile
// ============================================================================

describe('tiles.json: o token de geracao no template', () => {
  // POR QUE ESTE BLOCO EXISTE. O tile sai com `immutable` de um ano, entao o
  // navegador que ja visitou a foto nao pergunta mais nada ao servidor: o ETag
  // nunca chega a ser consultado. Enquanto o template era
  // 'tiles/{level}/{x}/{y}.webp', regerar a piramide com outra razao trocava a
  // ESCADA inteira sem mudar um caractere de URL nenhuma, e o cliente compunha
  // tiles da escada velha dentro da grade nova, sem erro no console. O museu_cms
  // e o caso real: saiu com razao 2 e foi regerado com 1,6.

  /**
   * Extrai o valor de `v` do template publicado.
   * @param {string} template - O campo `template` do descritor
   * @returns {string|null} O token, ou null se o template nao tiver query
   */
  const tokenDo = (template) => new URL(template, 'https://exemplo.invalid/')
    .searchParams.get('v');

  it('o template carrega o total_bytes da piramide como token', async () => {
    // O token E o total_bytes, e nao um numero qualquer: e o MESMO valor que
    // valida o ETag do tile. Um token proprio deixaria a URL e o validador
    // discordarem, e uma regeracao poderia mudar so um dos dois.
    const doc = JSON.parse(
      (await app.inject({ method: 'GET', url: urlDescritor(T.TILED_PHOTO_ID) })).body,
    );
    assert.equal(tokenDo(doc.template), String(fixture.totalBytes));

    const tile = await app.inject({ method: 'GET', url: urlTile(T.TILED_PHOTO_ID, 3, 2, 1) });
    assert.ok(tile.headers['etag'].includes(String(fixture.totalBytes)),
      'o ETag do tile deixou de usar o mesmo token que a URL');
  });

  it('duas piramides com total_bytes diferentes publicam templates diferentes', async () => {
    // O TESTE QUE REPROVA O DEFEITO ANTIGO. Com o template constante as duas
    // piramides publicavam a MESMA string, e era exatamente isso que fazia a URL
    // sobreviver a regeracao.
    //
    // As duas piramides sao lidas do banco, e a diferenca de total_bytes e
    // conferida ANTES: sem ela o resto do caso nao provaria nada.
    assert.notEqual(fixture.totalBytes, fixture.razaoTotalBytes,
      'a fixture precisa de duas piramides com total_bytes diferentes');

    const daRazao2 = JSON.parse(
      (await app.inject({ method: 'GET', url: urlDescritor(T.TILED_PHOTO_ID) })).body,
    ).template;
    const daRazao16 = JSON.parse(
      (await app.inject({ method: 'GET', url: urlDescritor(T.RAZAO_PHOTO_ID) })).body,
    ).template;

    assert.notEqual(daRazao2, daRazao16);
    assert.equal(tokenDo(daRazao2), String(fixture.totalBytes));
    assert.equal(tokenDo(daRazao16), String(fixture.razaoTotalBytes));
  });

  it('o banco SEM a coluna razao tambem publica o seu token', async () => {
    // O acervo que ja esta no disco e quem mais precisa disto: ele e o que vai
    // ser regerado. `total_bytes` existe no DDL anterior a coluna `razao`, entao
    // o token nao depende da migracao.
    const doc = JSON.parse(
      (await app.inject({ method: 'GET', url: urlDescritor(T.LEGACY_PHOTO_ID) })).body,
    );
    assert.equal(tokenDo(doc.template), String(fixture.legacyTotalBytes));
  });

  it('a query do template sobrevive a resolucao relativa do cliente', async () => {
    // O CLIENTE USA O TEMPLATE VERBATIM. tile-loader.js resolve com
    // `new URL(relativa, urlDescritor)`, e a URL do documento termina em
    // "tiles.json". Se a query se perdesse nessa resolucao, o token sumiria da
    // rede e o immutable de um ano voltaria a colar escada velha em grade nova.
    // O `base` ja provava que uma query relativa resolve; aqui prova-se para o
    // template, que e o campo que passou a ter uma.
    const { template } = JSON.parse(
      (await app.inject({ method: 'GET', url: urlDescritor(T.TILED_PHOTO_ID) })).body,
    );
    assert.ok(!/^https?:\/\//.test(template), `URL absoluta no descritor: ${template}`);
    assert.ok(!template.startsWith('/'), `caminho absoluto no descritor: ${template}`);

    const doc = new URL(urlDescritor(T.TILED_PHOTO_ID), 'https://exemplo.invalid');
    const resolvida = new URL(
      template.replace('{level}', '3').replace('{x}', '2').replace('{y}', '1'), doc,
    );
    assert.equal(resolvida.pathname, urlTile(T.TILED_PHOTO_ID, 3, 2, 1));
    assert.equal(resolvida.search, `?v=${fixture.totalBytes}`);
  });

  it('a rota do tile responde 200 com o token, e devolve os mesmos bytes', async () => {
    // O CUIDADO DO CONSERTO. O tile passa a chegar com query string, e a rota
    // nao pode responder 400 por causa dela. A URL sai do TEMPLATE PUBLICADO,
    // montada como o cliente monta, e nao escrita a mao aqui.
    const { template } = JSON.parse(
      (await app.inject({ method: 'GET', url: urlDescritor(T.TILED_PHOTO_ID) })).body,
    );
    const doc = new URL(urlDescritor(T.TILED_PHOTO_ID), 'https://exemplo.invalid');
    const alvo = new URL(
      template.replace('{level}', '3').replace('{x}', '2').replace('{y}', '1'), doc,
    );

    const comToken = await app.inject({ method: 'GET', url: alvo.pathname + alvo.search });
    const semToken = await app.inject({ method: 'GET', url: urlTile(T.TILED_PHOTO_ID, 3, 2, 1) });

    assert.equal(comToken.statusCode, 200, `a rota recusou a propria URL que publicou: ${alvo.search}`);
    assert.deepEqual(comToken.rawPayload, fixture.tiles.get(chaveTile(3, 2, 1)));
    assert.ok(comToken.headers['content-type']?.includes('image/webp'));

    // O TOKEN NAO ENTRA NO VALIDADOR nem no corpo: ele so separa a entrada de
    // cache. Duas URLs da mesma geracao tem de responder identico.
    assert.deepEqual(comToken.rawPayload, semToken.rawPayload);
    assert.equal(comToken.headers['etag'], semToken.headers['etag']);
  });

  it('a rota do tile nao valida a query, nem o token velho nem o desconhecido', async () => {
    // A ROTA SEGUE SEM SCHEMA DE QUERY, de proposito. Um `querystring` no schema
    // com additionalProperties: false responderia 400 no tile por causa do
    // proprio token que o descritor publicou.
    //
    // E o token VELHO tambem passa. No instante da regeracao o cliente ainda
    // segura o descritor antigo: recusa-lo pintaria buraco na parede em vez de
    // servir o tile bom. A resposta certa e sempre o tile de hoje.
    const casos = [
      `${urlTile(T.TILED_PHOTO_ID, 3, 2, 1)}?v=1`,
      `${urlTile(T.TILED_PHOTO_ID, 3, 2, 1)}?v=${fixture.totalBytes}&nada=disso`,
      `${urlTile(T.TILED_PHOTO_ID, 3, 2, 1)}?desconhecido=1`,
      `${urlTile(T.TILED_PHOTO_ID, 3, 2, 1)}?v=`,
    ];
    for (const url of casos) {
      const res = await app.inject({ method: 'GET', url });
      assert.equal(res.statusCode, 200, `a query derrubou o tile em ${url}`);
      assert.deepEqual(res.rawPayload, fixture.tiles.get(chaveTile(3, 2, 1)),
        `corpo trocado em ${url}`);
    }
  });

  it('a mesma foto publica outra URL de tile depois de regerada', async () => {
    // O CASO museu_cms, REPRODUZIDO. Ele saiu com razao 2 e foi regerado com
    // 1,6: a escada mudou, e a URL de todo tile continuou a mesma. Aqui a
    // piramide de uma foto e reescrita no banco com outro total_bytes, que e o
    // que toda regeracao faz, e o descritor tem de publicar outra URL.
    //
    // A COMPARACAO E DA MESMA FOTO, e nao de duas. Duas fotos ja tinham URLs
    // diferentes pelo caminho, e isso nunca foi o defeito.
    const antes = JSON.parse(
      (await app.inject({ method: 'GET', url: urlDescritor(T.RAZAO_PHOTO_ID) })).body,
    );

    /**
     * A URL de um tile, montada como o cliente monta.
     * @param {string} template - O campo `template` do descritor
     * @returns {URL} A URL resolvida contra o documento
     */
    const urlDoTile = (template) => new URL(
      template.replace('{level}', '4').replace('{x}', '5').replace('{y}', '2'),
      new URL(urlDescritor(T.RAZAO_PHOTO_ID), 'https://exemplo.invalid'),
    );

    // A escrita vai por uma conexao PROPRIA. A rota le o arquivo readonly, e o
    // WAL absorve este UPDATE sem mexer no mtime do .db, entao a leitura
    // seguinte ja enxerga o valor novo (ver tiles-queries.js).
    const caminho = join(dataDir, 'projects', T.TILES_DB_FILENAME);
    const escrita = new Database(caminho);
    const ler = escrita.prepare('SELECT total_bytes FROM tile_pyramids WHERE photo_id = ?');
    const gravar = escrita.prepare('UPDATE tile_pyramids SET total_bytes = ? WHERE photo_id = ?');
    const original = ler.get(T.RAZAO_PHOTO_ID).total_bytes;

    try {
      gravar.run(original + 4096, T.RAZAO_PHOTO_ID);

      const depois = JSON.parse(
        (await app.inject({ method: 'GET', url: urlDescritor(T.RAZAO_PHOTO_ID) })).body,
      );
      assert.notEqual(depois.template, antes.template,
        'a piramide foi regerada e a URL do tile nao mudou: o cache immutable serve a escada velha');
      assert.notEqual(urlDoTile(depois.template).href, urlDoTile(antes.template).href);

      // SO O TOKEN MUDA. O caminho continua o mesmo, o que mostra que a URL
      // velha nao some do cache: ela e que deixa de ser pedida.
      assert.equal(urlDoTile(depois.template).pathname, urlDoTile(antes.template).pathname);
      assert.equal(tokenDo(depois.template), String(original + 4096));

      // E a URL nova serve o tile, com os bytes gravados.
      const alvo = urlDoTile(depois.template);
      const res = await app.inject({ method: 'GET', url: alvo.pathname + alvo.search });
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.rawPayload, fixture.razaoTiles.get(chaveTile(4, 5, 2)));
    } finally {
      gravar.run(original, T.RAZAO_PHOTO_ID);
      escrita.close();
    }

    // A fixture volta ao estado de origem, senao os casos seguintes mediriam o
    // banco que ESTE caso deixou para tras.
    const voltou = JSON.parse(
      (await app.inject({ method: 'GET', url: urlDescritor(T.RAZAO_PHOTO_ID) })).body,
    );
    assert.deepEqual(voltou, antes);
  });
});

// ============================================================================
// A coluna razao: a escada fina e o banco velho
// ============================================================================

describe('tiles.json: a piramide de razao 1,6', () => {
  it('publica 5 niveis e a razao gravada', async () => {
    // O DOCUMENTO INTEIRO da escada fina. A geometria e escolhida para
    // DISCRIMINAR: em 5376, com tile de 1024, a razao 1,6 desce quatro degraus
    // e da 5 niveis (821, 1313, 2100, 3360, 5376), e a razao 2 desce tres e da
    // 4 (672, 1344, 2688, 5376). Uma rota que ignore a coluna e monte a escada
    // com 2 publica outra lista e reprova aqui, campo a campo.
    //
    // O tileSize de 1024 e proposital: as outras piramides da fixture usam 512,
    // entao uma rota que leia um 512 constante reprova junto.
    const res = await app.inject({ method: 'GET', url: urlDescritor(T.RAZAO_PHOTO_ID) });
    assert.equal(res.statusCode, 200);

    assert.deepEqual(JSON.parse(res.body), {
      schemaVersion: 1,
      photoId: T.RAZAO_PHOTO_ID,
      projectSlug: SEEDS.PROJECT_SLUG,
      format: 'webp',
      encoder: { quality: 80 },
      tileSize: 1024,
      razao: 1.6,
      width: 5376,
      height: 2688,
      origin: 'top-left',
      edge: 'crop',
      wrapX: true,
      minLevel: 0,
      maxLevel: 4,
      base: 'image?quality=preview',
      template: `tiles/{level}/{x}/{y}.webp?v=${fixture.razaoTotalBytes}`,
      levels: [
        { level: 0, width: 821, height: 410, cols: 1, rows: 1 },
        { level: 1, width: 1313, height: 656, cols: 2, rows: 1 },
        { level: 2, width: 2100, height: 1050, cols: 3, rows: 2 },
        { level: 3, width: 3360, height: 1680, cols: 4, rows: 2 },
        { level: 4, width: 5376, height: 2688, cols: 6, rows: 3 },
      ],
    });
  });

  it('publica a razao como numero, e nao como texto', async () => {
    // O cliente passa este valor direto a montarEscada. Um "1.6" em texto
    // sobreviveria ao JSON.parse e so quebraria na divisao, dentro do laco.
    const { razao } = JSON.parse(
      (await app.inject({ method: 'GET', url: urlDescritor(T.RAZAO_PHOTO_ID) })).body,
    );
    assert.equal(typeof razao, 'number');
    assert.equal(razao, 1.6);
  });

  it('o maxLevel publicado casa com o comprimento da lista de niveis', async () => {
    // Publicar o max_level gravado ao lado de uma escada calculada reabriria a
    // divergencia que pyramid-math.js fechou. Aqui os dois tem de sair da mesma
    // conta, e a conta agora depende da razao.
    const doc = JSON.parse(
      (await app.inject({ method: 'GET', url: urlDescritor(T.RAZAO_PHOTO_ID) })).body,
    );
    assert.equal(doc.maxLevel, doc.levels.length - 1);
    assert.equal(doc.levels[doc.maxLevel].width, doc.width);
    assert.equal(doc.levels[doc.maxLevel].height, doc.height);
  });
});

describe('tiles: a faixa valida sai da escada DAQUELA razao', () => {
  it('serve x = cols-1 do nivel 3, que so existe na escada de 1,6', async () => {
    // O nivel 3 da escada fina mede 3360x1680, ou seja 4 colunas de 1024. A
    // ultima e a coluna 3, e o corpo tem de ser o tile gravado.
    const res = await app.inject({ method: 'GET', url: urlTile(T.RAZAO_PHOTO_ID, 3, 3, 1) });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.rawPayload, fixture.razaoTiles.get(chaveTile(3, 3, 1)));
  });

  it('recusa x = 4 no nivel 3, que a leitura com razao 2 aceitaria', async () => {
    // O TESTE QUE SEPARA AS DUAS LEITURAS. Com razao 2 a escada de 5376 tem 4
    // niveis, e o nivel 3 e o NATIVO, de 6 colunas: ali x=4 seria valido e a
    // rota devolveria 200 com o tile de outra escada. Com a razao gravada o
    // nivel 3 tem 4 colunas, e x=4 e 400.
    //
    // O SEPARADOR SUBIU UM DEGRAU. Ele era (nivel 2, x 4), e o nivel 2 hoje tem
    // 3 colunas nas DUAS leituras: continuaria verde sem separar nada.
    const res = await app.inject({ method: 'GET', url: urlTile(T.RAZAO_PHOTO_ID, 3, 4, 0) });
    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(res.body).error, 'Tile out of range');
  });

  it('recusa y = 2 no nivel 2, que tem 2 linhas', async () => {
    const res = await app.inject({ method: 'GET', url: urlTile(T.RAZAO_PHOTO_ID, 2, 0, 2) });
    assert.equal(res.statusCode, 400);
  });

  it('serve o nivel 4, que a escada de razao 2 nem teria', async () => {
    // Canto inferior direito do nativo: coluna 5 mede 5376 - 5120 = 256 px, e a
    // linha 2 mede 2688 - 2048 = 640, cortada em 640. O WebP prova a dimensao.
    const res = await app.inject({ method: 'GET', url: urlTile(T.RAZAO_PHOTO_ID, 4, 5, 2) });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.rawPayload, fixture.razaoTiles.get(chaveTile(4, 5, 2)));

    const meta = await sharp(res.rawPayload).metadata();
    assert.equal(meta.format, 'webp');
    assert.equal(meta.width, 256);
    assert.equal(meta.height, 640);
  });

  it('recusa o nivel 5, que passa do nativo da escada fina', async () => {
    const res = await app.inject({ method: 'GET', url: urlTile(T.RAZAO_PHOTO_ID, 5, 0, 0) });
    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(res.body).error, 'Tile out of range');
  });

  it('a faixa que o descritor publica nunca vira 400 no tile', async () => {
    // A promessa do contrato, varrida inteira: o cliente le `levels` e pede o
    // canto de cada nivel. Se a rota montasse a escada com outra razao que o
    // descritor, algum destes viraria 400, e o buraco apareceria na tela.
    const { levels } = JSON.parse(
      (await app.inject({ method: 'GET', url: urlDescritor(T.RAZAO_PHOTO_ID) })).body,
    );

    for (const nivel of levels) {
      const dentro = await app.inject({
        method: 'GET',
        url: urlTile(T.RAZAO_PHOTO_ID, nivel.level, nivel.cols - 1, nivel.rows - 1),
      });
      assert.equal(dentro.statusCode, 200, `nivel ${nivel.level} recusou o proprio canto`);

      const fora = await app.inject({
        method: 'GET',
        url: urlTile(T.RAZAO_PHOTO_ID, nivel.level, nivel.cols, 0),
      });
      assert.equal(fora.statusCode, 400, `nivel ${nivel.level} aceitou x = cols`);
    }
  });
});

describe('o banco SEM a coluna razao responde como razao 2', () => {
  it('publica razao 2 e a escada classica', async () => {
    // O CASO DO ARQUIVO JA NO DISCO. O museu_cms_tiles.db tem 76 fotos e 12160
    // tiles gravados antes desta coluna existir, e nao vai ser regerado por
    // causa dela. A fixture cria este banco com o DDL ANTERIOR, verbatim.
    //
    // 3072 tambem discrimina: com razao 2 a escada desce 1536, 768 e 384, e da
    // 4 niveis; com 1,6 desceria 1920, 1200, 750 e 469, e daria 5. Ler a razao
    // errada aqui muda a lista inteira, e nao so um numero.
    const res = await app.inject({ method: 'GET', url: urlDescritor(T.LEGACY_PHOTO_ID) });
    assert.equal(res.statusCode, 200);

    const doc = JSON.parse(res.body);
    assert.equal(doc.razao, 2);
    assert.equal(doc.tileSize, 512);
    assert.equal(doc.maxLevel, 3);
    assert.deepEqual(doc.levels, [
      { level: 0, width: 384, height: 192, cols: 1, rows: 1 },
      { level: 1, width: 768, height: 384, cols: 2, rows: 1 },
      { level: 2, width: 1536, height: 768, cols: 3, rows: 2 },
      { level: 3, width: 3072, height: 1536, cols: 6, rows: 3 },
    ]);
  });

  it('serve o tile do banco velho byte a byte', async () => {
    const res = await app.inject({ method: 'GET', url: urlTile(T.LEGACY_PHOTO_ID, 3, 5, 2) });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.rawPayload, fixture.legacyTiles.get(chaveTile(3, 5, 2)));
  });

  it('recusa o nivel 4, que a leitura com razao 1,6 aceitaria', async () => {
    // O SEPARADOR ANDOU DE LUGAR com a escada nova, e o antigo deixou de
    // separar. Ele era x=3 no nivel 0, quando o nivel 0 media 1536x768 (3
    // colunas) contra 1920x960 (4 colunas) da leitura errada. Hoje a escada
    // desce ate caber num tile, e o nivel 0 tem 1 coluna nas DUAS leituras:
    // aquele x=3 continuaria 400 mesmo com a razao lida errada.
    //
    // O que ainda separa e o TAMANHO da escada. Com razao 2 o 3072 desce 1536,
    // 768 e 384, e da 4 niveis; com 1,6 desce 1920, 1200, 750 e 469, e da 5.
    // Logo o nivel 4 e 400 na leitura certa e 200 na errada.
    const res = await app.inject({ method: 'GET', url: urlTile(T.LEGACY_PHOTO_ID, 4, 0, 0) });
    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(res.body).error, 'Tile out of range');

    // E o nivel 3, que so a leitura certa tem como nativo, serve os 6 tiles de
    // largura que a leitura errada nao teria: la o nivel 3 mede 1920 e para em
    // 4 colunas.
    const nativo = await app.inject({ method: 'GET', url: urlTile(T.LEGACY_PHOTO_ID, 3, 5, 0) });
    assert.equal(nativo.statusCode, 200);
    assert.deepEqual(nativo.rawPayload, fixture.legacyTiles.get(chaveTile(3, 5, 0)));
  });

  it('a falta da coluna nao derruba o projeto vizinho', async () => {
    // O risco operacional real. Um SELECT com `razao` num banco sem a coluna
    // estoura em "no such column", e um catch largo trataria o arquivo como
    // projeto sem piramide: o acervo inteiro pararia de servir tile por causa de
    // uma coluna nova. Aqui os dois bancos respondem na mesma sessao.
    const velho = await app.inject({ method: 'GET', url: urlDescritor(T.LEGACY_PHOTO_ID) });
    const novo = await app.inject({ method: 'GET', url: urlDescritor(T.RAZAO_PHOTO_ID) });
    assert.equal(velho.statusCode, 200);
    assert.equal(novo.statusCode, 200);
    assert.notEqual(JSON.parse(velho.body).razao, JSON.parse(novo.body).razao);
  });
});

// ============================================================================
// GET /api/v1/photos/:uuid/tiles/:level/:x/:y: o tile
// ============================================================================

describe('GET /api/v1/photos/:uuid/tiles/:level/:x/:y', () => {
  it('devolve 200 com image/webp e os bytes exatos do tile pedido', async () => {
    const esperado = fixture.tiles.get(chaveTile(3, 2, 1));
    assert.ok(esperado, 'tile ausente da fixture');

    const res = await app.inject({ method: 'GET', url: urlTile(T.TILED_PHOTO_ID, 3, 2, 1) });
    assert.equal(res.statusCode, 200);
    assert.ok(res.headers['content-type']?.includes('image/webp'));
    assert.equal(parseInt(res.headers['content-length'], 10), esperado.length);
    assert.deepEqual(res.rawPayload, esperado);
  });

  it('nao troca x por y', async () => {
    // (1,2,1) e (1,1,2) sao os dois validos e tem corpos diferentes de
    // proposito. Uma rota que inverta os dois parametros passa em tudo que so
    // confere o status.
    const a = await app.inject({ method: 'GET', url: urlTile(T.TILED_PHOTO_ID, 3, 2, 1) });
    const b = await app.inject({ method: 'GET', url: urlTile(T.TILED_PHOTO_ID, 3, 1, 2) });

    assert.equal(a.statusCode, 200);
    assert.equal(b.statusCode, 200);
    assert.deepEqual(a.rawPayload, fixture.tiles.get(chaveTile(3, 2, 1)));
    assert.deepEqual(b.rawPayload, fixture.tiles.get(chaveTile(3, 1, 2)));
    assert.notDeepEqual(a.rawPayload, b.rawPayload);
  });

  it('serve o tile de borda com a dimensao recortada', async () => {
    // Nivel 2 mede 1280x640, entao a coluna 2 tem 1280 - 1024 = 256 px de
    // largura. O corpo tem de ser um WebP decodificavel com essa medida: e o
    // que prova que a piramide recorta, e o cliente desenha em (x*512, y*512)
    // tomando a largura do proprio bitmap.
    const res = await app.inject({ method: 'GET', url: urlTile(T.TILED_PHOTO_ID, 2, 2, 0) });
    assert.equal(res.statusCode, 200);

    const meta = await sharp(res.rawPayload).metadata();
    assert.equal(meta.format, 'webp');
    assert.equal(meta.width, 256);
    assert.equal(meta.height, 512);
  });

  it('serve o canto inferior direito do nivel nativo', async () => {
    // Nivel 3 mede 2560x1280: a ultima coluna e cheia (512) e a ultima linha
    // mede 1280 - 1024 = 256.
    const res = await app.inject({ method: 'GET', url: urlTile(T.TILED_PHOTO_ID, 3, 4, 2) });
    assert.equal(res.statusCode, 200);

    const meta = await sharp(res.rawPayload).metadata();
    assert.equal(meta.width, 512);
    assert.equal(meta.height, 256);
  });

  it('cacheia por um ano como imutavel', async () => {
    const res = await app.inject({ method: 'GET', url: urlTile(T.TILED_PHOTO_ID, 3, 2, 1) });
    assert.ok(res.headers['cache-control']?.includes('immutable'));
    assert.ok(res.headers['cache-control']?.includes('31536000'));
    assert.ok(res.headers['cache-control']?.includes('public'));
  });

  it('usa o ETag do contrato, com o total_bytes da piramide como token', async () => {
    const res = await app.inject({ method: 'GET', url: urlTile(T.TILED_PHOTO_ID, 3, 2, 1) });
    const esperado = computeImageETag(T.TILED_PHOTO_ID, 't3-2-1', fixture.totalBytes);
    assert.equal(res.headers['etag'], `"${esperado}"`);

    // O token NAO pode ser o full_size_bytes: reconstruir a piramide com outro
    // quality nao muda o tamanho do full, e o immutable de um ano misturaria
    // tiles velhos e novos na mesma panoramica.
    assert.notEqual(fixture.totalBytes, SEEDS.FULL_BLOB.length);
    assert.ok(!res.headers['etag'].includes(`-${SEEDS.FULL_BLOB.length}"`));
  });

  it('da ETags diferentes a tiles diferentes', async () => {
    const a = await app.inject({ method: 'GET', url: urlTile(T.TILED_PHOTO_ID, 3, 2, 1) });
    const b = await app.inject({ method: 'GET', url: urlTile(T.TILED_PHOTO_ID, 3, 1, 2) });
    assert.notEqual(a.headers['etag'], b.headers['etag']);
  });

  it('devolve 304 sem corpo quando o If-None-Match casa', async () => {
    const primeira = await app.inject({ method: 'GET', url: urlTile(T.TILED_PHOTO_ID, 3, 2, 1) });
    const etag = primeira.headers['etag'];
    assert.ok(etag);

    const segunda = await app.inject({
      method: 'GET',
      url: urlTile(T.TILED_PHOTO_ID, 3, 2, 1),
      headers: { 'if-none-match': etag },
    });
    assert.equal(segunda.statusCode, 304);
    assert.equal(segunda.body, '');
  });

  it('devolve 200 quando o If-None-Match e de outro tile', async () => {
    const outro = await app.inject({ method: 'GET', url: urlTile(T.TILED_PHOTO_ID, 3, 1, 2) });
    const res = await app.inject({
      method: 'GET',
      url: urlTile(T.TILED_PHOTO_ID, 3, 2, 1),
      headers: { 'if-none-match': outro.headers['etag'] },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.rawPayload, fixture.tiles.get(chaveTile(3, 2, 1)));
  });

  it('nao anuncia Range e ignora o pedido de intervalo', async () => {
    // Range e 206 existem para o full de 1 a 4 MB, nao para um tile de 20 KB.
    const res = await app.inject({
      method: 'GET',
      url: urlTile(T.TILED_PHOTO_ID, 3, 2, 1),
      headers: { range: 'bytes=0-4' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['accept-ranges'], undefined);
    assert.equal(res.headers['content-range'], undefined);
    assert.deepEqual(res.rawPayload, fixture.tiles.get(chaveTile(3, 2, 1)));
  });

  it('serve a rajada do frustum sem cruzar os corpos', async () => {
    // A rajada real e de 24 tiles no frustum, e esta e a que o cliente dispara.
    //
    // O RISCO QUE ESTE TESTE COBRE e o estado compartilhado: a conexao e o
    // statement preparado do better-sqlite3 vivem no cache de tiles-queries.js e
    // servem todos os requests em voo. Se um deles guardasse estado entre as
    // chamadas, dois pedidos concorrentes trocariam de corpo, e o cliente
    // pintaria o tile do vizinho. Por isso cada resposta e conferida byte a
    // byte contra a fixture, e nao so pelo status.
    //
    // O TETO DE CONCORRENCIA NAO E EXERCITADO AQUI: 30 cabem nas 64 vagas de
    // MAX_INFLIGHT_TILE_REQUESTS. Quem o exercita e o teste da rajada de 96,
    // logo abaixo.
    const coordenadas = [];
    for (let i = 0; i < 30; i++) coordenadas.push({ x: i % 5, y: i % 3 });

    const respostas = await Promise.all(coordenadas.map(({ x, y }) =>
      app.inject({ method: 'GET', url: urlTile(T.TILED_PHOTO_ID, 3, x, y) })));

    respostas.forEach((res, i) => {
      const { x, y } = coordenadas[i];
      const esperado = fixture.tiles.get(chaveTile(3, x, y));
      assert.ok(esperado, `tile ${x},${y} ausente da fixture`);
      assert.equal(res.statusCode, 200, `tile ${x},${y} nao respondeu 200`);
      assert.deepEqual(res.rawPayload, esperado, `corpo trocado no tile ${x},${y}`);
    });

    // A rajada tem de cobrir mais tiles DISTINTOS que a fixture teria por
    // acaso: um teste que pedisse o mesmo tile 30 vezes nao cruzaria nada.
    const distintos = new Set(coordenadas.map(({ x, y }) => `${x},${y}`));
    assert.equal(distintos.size, 15);
  });

  it('poe mais de 64 pedidos em voo AO MESMO TEMPO', { timeout: 30000 }, async () => {
    // A PREMISSA DO TESTE SEGUINTE, MEDIDA AQUI. A rajada de 96 so exercita a
    // fila do semaforo se os 96 estiverem em voo juntos. Se o inject
    // serializasse os pedidos, o pico ficaria em 1, ninguem esperaria vaga, e o
    // teste passaria sem tocar no limitador.
    //
    // O comentario que este caso substitui dizia "medido numa replica do
    // semaforo". Replica nao e prova: ela confirma quem a escreveu, e o que roda
    // em producao e a rota. Aqui a contagem sai do proprio Fastify.
    //
    // Os hooks vao numa instancia PROPRIA. Pendura-los no `app` compartilhado
    // mudaria o caminho de todos os outros casos deste arquivo.
    const { buildApp } = await import('../helpers/build-app.js');
    const medidor = await buildApp();

    let emVoo = 0;
    let pico = 0;
    medidor.addHook('onRequest', async () => {
      emVoo++;
      if (emVoo > pico) pico = emVoo;
    });
    medidor.addHook('onResponse', async () => { emVoo--; });

    try {
      const respostas = await Promise.all(Array.from({ length: 96 }, (_, i) =>
        medidor.inject({ method: 'GET', url: urlTile(T.TILED_PHOTO_ID, 3, i % 5, i % 3) })));
      respostas.forEach((res, i) => assert.equal(res.statusCode, 200, `pedido ${i} nao respondeu 200`));
    } finally {
      await medidor.close();
    }

    // 64 e o teto da rota. Passar dele e o que poe pedido na fila. MEDIDO: o
    // pico deu 96 em tres corridas seguidas, ou seja os 96 chegam ao handler
    // antes de o primeiro soltar a vaga. O piso do assert fica em 64 mesmo
    // assim, porque o que importa e passar do teto, e nao empatar com 96.
    assert.ok(pico > 64, `pico de ${pico} pedidos em voo: a rajada nao passou do teto de 64`);
  });

  it('atende 96 pedidos concorrentes, 32 acima do teto de 64', { timeout: 30000 }, async () => {
    // O TESTE DO LIMITADOR. A rota tem semaforo proprio, de 64
    // (MAX_INFLIGHT_TILE_REQUESTS), e 96 injects em Promise.all passam desse
    // teto: o caso acima MEDE o pico de pedidos em voo e exige mais de 64, entao
    // 32 destes pedidos entram mesmo na fila.
    //
    // A PROVA E QUE TODOS OS 96 RESPONDEM. Os 32 enfileirados so saem se a vaga
    // VOLTAR, e a vaga volta num listener de 'close' da resposta. Se esse
    // listener nao disparasse, ou se releaseTileSlot deixasse de promover o
    // proximo da fila, os 32 ficariam parados para sempre e este teste estouraria
    // o timeout em vez de passar.
    //
    // O que ele NAO prova, e nao da para provar de fora do processo: que o teto
    // e 64 e nao outro numero. O contador e privado do modulo.
    const CONCORRENTES = 96;
    const coordenadas = [];
    for (let i = 0; i < CONCORRENTES; i++) coordenadas.push({ x: i % 5, y: i % 3 });

    const respostas = await Promise.all(coordenadas.map(({ x, y }) =>
      app.inject({ method: 'GET', url: urlTile(T.TILED_PHOTO_ID, 3, x, y) })));

    assert.equal(respostas.length, CONCORRENTES);
    respostas.forEach((res, i) => {
      const { x, y } = coordenadas[i];
      assert.equal(res.statusCode, 200, `pedido ${i} (tile ${x},${y}) nao respondeu 200`);
      assert.deepEqual(res.rawPayload, fixture.tiles.get(chaveTile(3, x, y)),
        `corpo trocado no pedido ${i}, tile ${x},${y}`);
    });

    // A vaga tem de estar de volta DEPOIS da rajada tambem. Um vazamento que
    // deixasse contador preso serviria os 96 e travaria o proximo pedido.
    const depois = await app.inject({ method: 'GET', url: urlTile(T.TILED_PHOTO_ID, 3, 2, 1) });
    assert.equal(depois.statusCode, 200);
  });

  it('o caminho do 304 nao consome vaga do semaforo', { timeout: 30000 }, async () => {
    // A OUTRA METADE DO LIMITADOR. O 304 curto-circuita ANTES de pegar a vaga,
    // porque nao carrega BLOB nenhum. Quem mover o acquire para cima do teste de
    // If-None-Match sem soltar a vaga cria um vazamento de uma vaga por 304: as
    // 64 acabam, e a rota para de servir tile para sempre.
    //
    // 80 e maior que 64 de proposito. Com o vazamento, 64 destes pedidos comem
    // as vagas e os 16 restantes nunca saem da fila.
    const primeira = await app.inject({ method: 'GET', url: urlTile(T.TILED_PHOTO_ID, 3, 3, 1) });
    const etag = primeira.headers['etag'];
    assert.ok(etag);

    const respostas = await Promise.all(Array.from({ length: 80 }, () =>
      app.inject({
        method: 'GET',
        url: urlTile(T.TILED_PHOTO_ID, 3, 3, 1),
        headers: { 'if-none-match': etag },
      })));

    respostas.forEach((res, i) => {
      assert.equal(res.statusCode, 304, `pedido ${i} nao respondeu 304`);
      assert.equal(res.body, '');
    });

    // E a rota continua servindo tile de verdade depois dos 80.
    const depois = await app.inject({ method: 'GET', url: urlTile(T.TILED_PHOTO_ID, 3, 3, 1) });
    assert.equal(depois.statusCode, 200);
    assert.deepEqual(depois.rawPayload, fixture.tiles.get(chaveTile(3, 3, 1)));
  });
});

// ============================================================================
// Faixa valida de level, x e y
// ============================================================================

describe('GET /api/v1/photos/:uuid/tiles/:level/:x/:y: faixa', () => {
  it('devolve 400 para nivel acima do maxLevel', async () => {
    // O maxLevel desta piramide e 3: a escada desce 1280, 640 e 320, e para em
    // 320 porque ele cabe no tile de 512.
    const res = await app.inject({ method: 'GET', url: urlTile(T.TILED_PHOTO_ID, 4, 0, 0) });
    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(res.body).error, 'Tile out of range');
  });

  it('devolve 400 para nivel negativo', async () => {
    const res = await app.inject({ method: 'GET', url: urlTile(T.TILED_PHOTO_ID, -1, 0, 0) });
    assert.equal(res.statusCode, 400);
  });

  it('devolve 400 para level, x ou y nao inteiro', async () => {
    const casos = [
      urlTile(T.TILED_PHOTO_ID, 'abc', 0, 0),
      urlTile(T.TILED_PHOTO_ID, 3, '1.5', 0),
      urlTile(T.TILED_PHOTO_ID, 3, 0, 'xyz'),
      urlTile(T.TILED_PHOTO_ID, '1e1', 0, 0),
    ];
    for (const url of casos) {
      const res = await app.inject({ method: 'GET', url });
      assert.equal(res.statusCode, 400, `esperava 400 em ${url}`);
    }
  });

  it('devolve 400 para x negativo', async () => {
    const res = await app.inject({ method: 'GET', url: urlTile(T.TILED_PHOTO_ID, 3, -1, 0) });
    assert.equal(res.statusCode, 400);
  });

  it('mede x contra as colunas DAQUELE nivel', async () => {
    // O nivel 2 tem 3 colunas e o nivel 3 tem 5. O mesmo x=3 e invalido num e
    // valido no outro: e o teste que reprova qualquer reuso do teto 2**z da
    // rota de tile vetorial, que aqui falharia em silencio.
    const grosso = await app.inject({ method: 'GET', url: urlTile(T.TILED_PHOTO_ID, 2, 3, 0) });
    assert.equal(grosso.statusCode, 400);
    assert.equal(JSON.parse(grosso.body).error, 'Tile out of range');

    const nativo = await app.inject({ method: 'GET', url: urlTile(T.TILED_PHOTO_ID, 3, 3, 0) });
    assert.equal(nativo.statusCode, 200);
    assert.deepEqual(nativo.rawPayload, fixture.tiles.get(chaveTile(3, 3, 0)));
  });

  it('mede y contra as linhas DAQUELE nivel', async () => {
    // Nivel 2 tem 2 linhas, nivel 3 tem 3.
    const grosso = await app.inject({ method: 'GET', url: urlTile(T.TILED_PHOTO_ID, 2, 0, 2) });
    assert.equal(grosso.statusCode, 400);

    const nativo = await app.inject({ method: 'GET', url: urlTile(T.TILED_PHOTO_ID, 3, 0, 2) });
    assert.equal(nativo.statusCode, 200);
  });

  it('recusa x = cols em vez de dar a volta no eixo', async () => {
    // O wrapX e do CLIENTE. Aceitar x = cols daria duas URLs aos mesmos pixels
    // e dobraria o cache.
    const res = await app.inject({ method: 'GET', url: urlTile(T.TILED_PHOTO_ID, 3, 5, 0) });
    assert.equal(res.statusCode, 400);
  });

  it('devolve 404 Tile not found para buraco na piramide', async () => {
    // Dentro da grade, mas sem linha em `tiles`. Nao e 400 (a coordenada e
    // valida) nem 500 (o banco respondeu, so nao tinha a linha).
    const { level, x, y } = T.TILED_HOLE;
    assert.equal(fixture.tiles.has(chaveTile(level, x, y)), false);

    const res = await app.inject({ method: 'GET', url: urlTile(T.TILED_PHOTO_ID, level, x, y) });
    assert.equal(res.statusCode, 404);
    assert.equal(JSON.parse(res.body).error, 'Tile not found');
  });
});

// ============================================================================
// Fotos que nao servem tile
// ============================================================================

describe('GET /api/v1/photos/:uuid/tiles/...: fotos sem tile', () => {
  it('devolve 404 Tile not found para foto sem piramide', async () => {
    const res = await app.inject({ method: 'GET', url: urlTile(T.NO_PYRAMID_PHOTO_ID, 0, 0, 0) });
    assert.equal(res.statusCode, 404);
    assert.equal(JSON.parse(res.body).error, 'Tile not found');
  });

  it('devolve 404 Photo not found para uuid inexistente', async () => {
    const res = await app.inject({ method: 'GET', url: urlTile(T.MISSING_PHOTO_ID, 0, 0, 0) });
    assert.equal(res.statusCode, 404);
    assert.equal(JSON.parse(res.body).error, 'Photo not found');
  });

  it('nao serve tile de foto apagada, que existe no banco de tiles', async () => {
    // O TESTE DA IMPLEMENTACAO INGENUA. O tile (0,0,0) desta foto esta gravado
    // e e um WebP valido: um handler que va direto a tabela `tiles` devolve 200
    // com a imagem de uma foto que o operador apagou.
    const gravado = fixture.deletedTiles.get(chaveTile(0, 0, 0));
    assert.ok(gravado && gravado.length > 0, 'a fixture precisa ter o tile da foto apagada');

    const res = await app.inject({ method: 'GET', url: urlTile(T.DELETED_PHOTO_ID, 0, 0, 0) });
    assert.equal(res.statusCode, 404);
    assert.equal(JSON.parse(res.body).error, 'Photo not found');
    assert.notDeepEqual(res.rawPayload, gravado);
  });

  it('devolve 404 para projeto sem banco de tiles, e o servico segue de pe', async () => {
    const semBanco = await app.inject({ method: 'GET', url: urlTile(T.NO_DB_PHOTO_ID, 0, 0, 0) });
    assert.equal(semBanco.statusCode, 404);
    assert.equal(JSON.parse(semBanco.body).error, 'Tile not found');

    const comBanco = await app.inject({ method: 'GET', url: urlTile(T.TILED_PHOTO_ID, 3, 2, 1) });
    assert.equal(comBanco.statusCode, 200);
    assert.deepEqual(comBanco.rawPayload, fixture.tiles.get(chaveTile(3, 2, 1)));
  });
});

// ============================================================================
// O fallback: quem nao tem piramide continua servido pelo full
// ============================================================================

/**
 * URL da imagem de uma foto, na qualidade pedida.
 * @param {string} uuid - UUID da foto
 * @param {string} quality - 'full' ou 'preview'
 * @returns {string} Caminho da imagem
 */
const urlImagem = (uuid, quality) => `/api/v1/photos/${uuid}/image?quality=${quality}`;

describe('o fallback do cliente sem piramide', () => {
  // O RISCO REAL DESTA RODADA. A UI de calibracao passou a pedir tiles, e 28 dos
  // 29 projetos nao tem piramide nenhuma. Se o 404 do tiles.json arrastar junto a
  // rota de imagem, o acervo inteiro apaga na tela, e nada nos testes de tile
  // acusaria: eles conferem tile, e o que sumiu foi o full.
  //
  // Os dois casos moram no MESMO arquivo de proposito. Os testes de photos.test
  // provam que /image funciona quando ninguem pediu tile; o que falta e provar
  // que ele continua funcionando com a rota de tile registrada e respondendo 404
  // para a mesma foto, na mesma sessao.

  it('foto SEM piramide: tiles.json da 404 e o full continua em 200', async () => {
    // A ORDEM IMPORTA. O 404 vem primeiro, como no cliente: ele dispara o
    // descritor e o fundo em paralelo, e desenha o full quando o descritor nega.
    const descritor = await app.inject({ method: 'GET', url: urlDescritor(T.NO_PYRAMID_PHOTO_ID) });
    assert.equal(descritor.statusCode, 404);
    assert.equal(JSON.parse(descritor.body).error, 'Tile not found');

    const full = await app.inject({ method: 'GET', url: urlImagem(T.NO_PYRAMID_PHOTO_ID, 'full') });
    assert.equal(full.statusCode, 200);
    assert.deepEqual(full.rawPayload, SEEDS.FULL_BLOB);
    assert.equal(parseInt(full.headers['content-length'], 10), SEEDS.FULL_BLOB.length);
  });

  it('foto SEM piramide: o preview tambem responde, e e o fundo da decisao 1', async () => {
    // O fundo passou a ser o `preview` (decisao 1), e o descritor o publica em
    // `base`. Quem nao tem piramide nem descritor tem: o preview precisa
    // responder sozinho, pela URL montada pelo cliente.
    const res = await app.inject({ method: 'GET', url: urlImagem(T.NO_PYRAMID_PHOTO_ID, 'preview') });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.rawPayload, SEEDS.PREVIEW_BLOB);
    assert.notDeepEqual(SEEDS.PREVIEW_BLOB, SEEDS.FULL_BLOB);
  });

  it('foto COM piramide: o full NAO sai agora, e continua em 200', async () => {
    // DECISAO 3, na metade que vale HOJE. O `full_webp` sai no fim, e nada desta
    // rodada o apaga: o ebgeo_web em producao ainda pede `image?quality=full`, e
    // ele nao sabe o que e tile. Uma rota de imagem que passasse a exigir a
    // piramide, ou a redirecionar para o tile, quebraria producao em silencio.
    const full = await app.inject({ method: 'GET', url: urlImagem(T.TILED_PHOTO_ID, 'full') });
    assert.equal(full.statusCode, 200);
    assert.deepEqual(full.rawPayload, SEEDS.FULL_BLOB);

    // E a piramide da MESMA foto continua servindo, na mesma sessao.
    const tile = await app.inject({ method: 'GET', url: urlTile(T.TILED_PHOTO_ID, 3, 2, 1) });
    assert.equal(tile.statusCode, 200);
    assert.deepEqual(tile.rawPayload, fixture.tiles.get(chaveTile(3, 2, 1)));
  });

  it('o 404 do tile nao envenena a rota de imagem da mesma foto', async () => {
    // O defeito que este caso pega e de ESTADO COMPARTILHADO: as duas rotas
    // passam pelo cache de conexoes de src/db. Um 404 que descartasse a conexao
    // errada, ou que deixasse um statement invalidado no cache, so apareceria na
    // proxima leitura de imagem, e nunca no proprio pedido de tile.
    const foraDaGrade = await app.inject({ method: 'GET', url: urlTile(T.TILED_PHOTO_ID, 2, 9, 9) });
    assert.equal(foraDaGrade.statusCode, 400);

    const buraco = await app.inject({
      method: 'GET',
      url: urlTile(T.TILED_PHOTO_ID, T.TILED_HOLE.level, T.TILED_HOLE.x, T.TILED_HOLE.y),
    });
    assert.equal(buraco.statusCode, 404);

    const semBanco = await app.inject({ method: 'GET', url: urlDescritor(T.NO_DB_PHOTO_ID) });
    assert.equal(semBanco.statusCode, 404);

    for (const quality of ['full', 'preview']) {
      const res = await app.inject({ method: 'GET', url: urlImagem(T.TILED_PHOTO_ID, quality) });
      assert.equal(res.statusCode, 200, `image?quality=${quality} caiu depois dos 404`);
    }
  });
});

// ============================================================================
// O descritor contra o banco: a base da UV
// ============================================================================

describe('o descritor bate com o banco, tile a tile', () => {
  // POR QUE ESTE BLOCO EXISTE. A regressao mais provavel desta rodada e a
  // textura por tiles trocar a UV: a panoramica gira de alguns graus, ou a
  // emenda abre uma faixa. WebGL nao roda em node, entao o que da para provar
  // aqui e o que SUSTENTA a UV.
  //
  // O cliente compoe o canvas em (x*tileSize, y*tileSize) e toma a largura do
  // proprio bitmap, porque a borda e recortada. Logo a UV so fecha se tres
  // coisas concordarem: a escada publicada, as dimensoes de cada nivel e o
  // recorte de cada tile gravado. Um unico tile de borda com 512 px onde o
  // descritor promete 256 desloca a coluna seguinte, e a panoramica inteira
  // escorrega.
  //
  // O que ja existia cobria a FAIXA (canto de cada nivel da 200, x = cols da
  // 400), e nao a MEDIDA. Aqui a grade e varrida inteira, e cada corpo e
  // decodificado.

  /**
   * Percorre a grade inteira que o descritor publica.
   * @param {object} nivel - Um item de `levels`
   * @param {number} tileSize - Lado do tile, do descritor
   * @yields {{level:number,x:number,y:number,largura:number,altura:number}}
   */
  function* gradeDe(nivel, tileSize) {
    for (let y = 0; y < nivel.rows; y++) {
      for (let x = 0; x < nivel.cols; x++) {
        yield {
          level: nivel.level,
          x,
          y,
          // O RECORTE, escrito aqui a mao. Um teste que perguntasse a medida ao
          // proprio bitmap nao conferiria nada.
          largura: Math.min(tileSize, nivel.width - x * tileSize),
          altura: Math.min(tileSize, nivel.height - y * tileSize),
        };
      }
    }
  }

  /**
   * Varre a piramide de uma foto e confere cada tile contra o descritor.
   * @param {string} photoId - UUID da foto
   * @param {Map<string, Buffer>} gravados - Tiles da fixture
   * @param {Array<{level:number,x:number,y:number}>} buracos - Tiles ausentes de proposito
   * @returns {Promise<number>} Quantos tiles a grade publicada tem
   */
  async function conferirPiramide(photoId, gravados, buracos = []) {
    const doc = JSON.parse((await app.inject({ method: 'GET', url: urlDescritor(photoId) })).body);
    const ausente = new Set(buracos.map(b => chaveTile(b.level, b.x, b.y)));
    let previstos = 0;

    for (const nivel of doc.levels) {
      // A soma das larguras de uma LINHA inteira tem de fechar a largura do
      // nivel. E o invariante da UV: se ela nao fechar, o canvas montado sobra
      // ou falta pixel, e a longitude inteira desanda.
      let somaLargura = 0;
      let somaAltura = 0;

      for (const alvo of gradeDe(nivel, doc.tileSize)) {
        previstos++;
        const chave = chaveTile(alvo.level, alvo.x, alvo.y);
        if (alvo.y === 0) somaLargura += alvo.largura;
        if (alvo.x === 0) somaAltura += alvo.altura;

        if (ausente.has(chave)) {
          // O buraco proposital nao invalida a grade: ele so nao tem bytes.
          const res = await app.inject({ method: 'GET', url: urlTile(photoId, alvo.level, alvo.x, alvo.y) });
          assert.equal(res.statusCode, 404, `o buraco ${chave} deixou de ser 404`);
          continue;
        }

        const res = await app.inject({ method: 'GET', url: urlTile(photoId, alvo.level, alvo.x, alvo.y) });
        assert.equal(res.statusCode, 200, `o descritor promete ${chave}, e a rota nao serve`);
        assert.deepEqual(res.rawPayload, gravados.get(chave), `corpo trocado em ${chave}`);

        const meta = await sharp(res.rawPayload).metadata();
        assert.equal(meta.format, 'webp', `${chave} nao e webp`);
        assert.equal(meta.width, alvo.largura,
          `${chave}: o descritor preve ${alvo.largura} px de largura, o bitmap tem ${meta.width}`);
        assert.equal(meta.height, alvo.altura,
          `${chave}: o descritor preve ${alvo.altura} px de altura, o bitmap tem ${meta.height}`);
      }

      assert.equal(somaLargura, nivel.width,
        `nivel ${nivel.level}: as colunas somam ${somaLargura} e o nivel mede ${nivel.width}`);
      assert.equal(somaAltura, nivel.height,
        `nivel ${nivel.level}: as linhas somam ${somaAltura} e o nivel mede ${nivel.height}`);
    }

    // O nivel nativo e a foto, e nada abaixo dele. Um descritor que publicasse
    // um nativo menor que `width` faria o cliente esticar a textura.
    const nativo = doc.levels[doc.levels.length - 1];
    assert.equal(nativo.width, doc.width);
    assert.equal(nativo.height, doc.height);
    assert.equal(nativo.level, doc.maxLevel);

    return previstos;
  }

  it('a escada de razao 2 nao promete nem esconde um tile', { timeout: 60000 }, async () => {
    // A CONTAGEM FECHA NOS DOIS SENTIDOS. Tile prometido e nao gravado vira
    // quadrado preto na parede; tile gravado e nao prometido e escada trocada,
    // e o cliente nunca o pede.
    const previstos = await conferirPiramide(T.TILED_PHOTO_ID, fixture.tiles, [T.TILED_HOLE]);
    // 1x1 + 2x1 + 3x2 + 5x3, os quatro niveis da escada que desce ate o tile.
    assert.equal(previstos, 1 * 1 + 2 * 1 + 3 * 2 + 5 * 3);
    assert.equal(previstos, fixture.tiles.size + 1, 'a grade publicada divergiu do que a fixture gravou');
  });

  it('a escada fina de razao 1,6 nao promete nem esconde um tile', { timeout: 60000 }, async () => {
    // A escada de 5 niveis, com tile de 1024 e duas bordas parciais no nativo (a
    // coluna 5 mede 256 px e a linha 2 mede 640). E onde o recorte erra mais
    // facil. O nivel 0 mede 821x410 e cabe num tile so, que e a parada nova.
    const previstos = await conferirPiramide(T.RAZAO_PHOTO_ID, fixture.razaoTiles);
    assert.equal(previstos, 1 * 1 + 2 * 1 + 3 * 2 + 4 * 2 + 6 * 3);
    assert.equal(previstos, fixture.razaoTiles.size);
  });

  it('o banco sem a coluna razao tambem fecha grade a grade', { timeout: 60000 }, async () => {
    // O acervo que ja esta no disco entra na mesma conferencia. Ele e quem vai
    // alimentar a UI de calibracao antes de qualquer regeracao.
    const previstos = await conferirPiramide(T.LEGACY_PHOTO_ID, fixture.legacyTiles);
    assert.equal(previstos, 1 * 1 + 2 * 1 + 3 * 2 + 6 * 3);
    assert.equal(previstos, fixture.legacyTiles.size);
  });

  it('a emenda fecha: a ultima coluna encosta na coluna 0', async () => {
    // O wrapX e do cliente, e ele so fecha se a ultima coluna medir o RESTO.
    // Numa escada de tile 1024 e largura 5376, a coluna 5 mede 256: um cliente
    // que assumisse 1024 escreveria 768 px alem da foto, e a emenda apareceria
    // como faixa duplicada.
    const doc = JSON.parse(
      (await app.inject({ method: 'GET', url: urlDescritor(T.RAZAO_PHOTO_ID) })).body,
    );
    assert.equal(doc.wrapX, true);
    assert.equal(doc.edge, 'crop');
    assert.equal(doc.origin, 'top-left');

    for (const nivel of doc.levels) {
      const restoColuna = nivel.width - (nivel.cols - 1) * doc.tileSize;
      assert.ok(restoColuna > 0 && restoColuna <= doc.tileSize,
        `nivel ${nivel.level}: a ultima coluna mede ${restoColuna}`);

      const ultima = await app.inject({
        method: 'GET',
        url: urlTile(T.RAZAO_PHOTO_ID, nivel.level, nivel.cols - 1, 0),
      });
      assert.equal(ultima.statusCode, 200);
      const meta = await sharp(ultima.rawPayload).metadata();
      assert.equal(meta.width, restoColuna,
        `nivel ${nivel.level}: a ultima coluna tem ${meta.width} px e o descritor preve ${restoColuna}`);
    }
  });
});

// ============================================================================
// A faixa do tile contra a faixa do descritor
// ============================================================================

describe('a faixa valida do tile e a MESMA que o descritor publica', () => {
  // POR QUE ESTE BLOCO EXISTE. Ele guarda um defeito de CLASSE, e nao um caso: a
  // rota recusar a propria URL que ela publicou. Ele ja apareceu duas vezes, por
  // motivos diferentes.
  //
  // A primeira foi o descritor montar a escada por `width / 2**(max-level)`
  // enquanto o gerador dividia com arredondamento: em 8194 de largura os dois
  // discordavam, e o cliente levava 400 num tile realmente gravado. A segunda foi
  // a escada passar a descer ate caber num tile e a FIXTURE ficar na escada
  // velha: a rota calculava 4 niveis e o teste pedia o nivel do documento antigo.
  //
  // Nos dois casos o sintoma na tela e o mesmo, e e o pior tipo: buraco preto na
  // parede, sem erro no console e sem teste vermelho. Por isso a conferencia aqui
  // nao pergunta nada a fixture nem repete a formula da escada. Ela le o
  // descritor, e cobra da rota exatamente o que aquele documento prometeu.
  //
  // AS TRES PIRAMIDES ENTRAM, e nao so a escada fina. Elas tem escadas diferentes
  // (razao 2, razao 1,6 e o banco sem a coluna), e o defeito nasce justo de uma
  // ser lida com a conta da outra.

  /**
   * As piramides da fixture que publicam descritor, com os buracos de proposito.
   * @returns {Array<{nome:string, photoId:string, buracos:Array<object>}>}
   */
  const piramides = [
    { nome: 'a escada de razao 2', photoId: T.TILED_PHOTO_ID, buracos: [T.TILED_HOLE] },
    { nome: 'a escada fina de razao 1,6', photoId: T.RAZAO_PHOTO_ID, buracos: [] },
    { nome: 'o banco sem a coluna razao', photoId: T.LEGACY_PHOTO_ID, buracos: [] },
  ];

  for (const { nome, photoId, buracos } of piramides) {
    it(`${nome}: o canto de cada nivel responde, e um passo fora e 400`, async () => {
      const doc = JSON.parse(
        (await app.inject({ method: 'GET', url: urlDescritor(photoId) })).body,
      );
      const ausente = new Set(buracos.map(b => chaveTile(b.level, b.x, b.y)));

      // A escada nao pode PULAR nivel. O cliente indexa `levels` por `level`, e
      // um vao no meio da lista viraria `undefined` na hora de escolher o nivel.
      assert.equal(doc.minLevel, 0);
      assert.equal(doc.maxLevel, doc.levels.length - 1);
      doc.levels.forEach((nivel, i) => assert.equal(nivel.level, i,
        `a escada pulou do nivel ${i - 1} para o ${nivel.level}`));

      /**
       * Pede um tile pela URL que o proprio descritor publicou, token junto.
       * @param {number} level - Nivel
       * @param {number} x - Coluna
       * @param {number} y - Linha
       * @returns {Promise<object>} A resposta do inject
       */
      const pedirComoOCliente = (level, x, y) => {
        const base = new URL(urlDescritor(photoId), 'https://exemplo.invalid');
        const alvo = new URL(doc.template
          .replace('{level}', String(level))
          .replace('{x}', String(x))
          .replace('{y}', String(y)), base);
        return app.inject({ method: 'GET', url: alvo.pathname + alvo.search });
      };

      for (const nivel of doc.levels) {
        const chave = chaveTile(nivel.level, nivel.cols - 1, nivel.rows - 1);
        const canto = await pedirComoOCliente(nivel.level, nivel.cols - 1, nivel.rows - 1);
        // O buraco proposital e 404, nunca 400: a coordenada esta DENTRO da
        // grade publicada, e so os bytes faltam.
        assert.equal(canto.statusCode, ausente.has(chave) ? 404 : 200,
          `a rota recusou o canto ${chave}, que ela mesma publicou`);

        const foraX = await pedirComoOCliente(nivel.level, nivel.cols, 0);
        assert.equal(foraX.statusCode, 400,
          `o nivel ${nivel.level} aceitou x = cols (${nivel.cols})`);

        const foraY = await pedirComoOCliente(nivel.level, 0, nivel.rows);
        assert.equal(foraY.statusCode, 400,
          `o nivel ${nivel.level} aceitou y = rows (${nivel.rows})`);
      }

      // E o degrau acima do nativo nao existe. Sem esta linha um descritor que
      // publicasse menos niveis que a rota serve passaria: os cantos publicados
      // responderiam todos, e o excesso ficaria invisivel.
      const acima = await pedirComoOCliente(doc.maxLevel + 1, 0, 0);
      assert.equal(acima.statusCode, 400,
        `a rota serviu o nivel ${doc.maxLevel + 1}, que o descritor nao publica`);
    });
  }

  it('a soma dos tiles publicados e a mesma nas tres piramides', async () => {
    // A CONTAGEM FECHA CONTRA O BANCO. Os casos acima provam a faixa, e nao o
    // tamanho: uma escada que publicasse um nivel a menos teria todos os cantos
    // certos. Aqui o total prometido pelo descritor e comparado com o total
    // GRAVADO, com os buracos somados de volta.
    const casos = [
      { photoId: T.TILED_PHOTO_ID, gravados: fixture.tiles, buracos: 1 },
      { photoId: T.RAZAO_PHOTO_ID, gravados: fixture.razaoTiles, buracos: 0 },
      { photoId: T.LEGACY_PHOTO_ID, gravados: fixture.legacyTiles, buracos: 0 },
    ];

    for (const { photoId, gravados, buracos } of casos) {
      const doc = JSON.parse(
        (await app.inject({ method: 'GET', url: urlDescritor(photoId) })).body,
      );
      const previstos = doc.levels.reduce((soma, n) => soma + n.cols * n.rows, 0);
      assert.equal(previstos, gravados.size + buracos,
        `${photoId}: o descritor promete ${previstos} tiles e o banco tem ${gravados.size}`);
    }
  });
});
