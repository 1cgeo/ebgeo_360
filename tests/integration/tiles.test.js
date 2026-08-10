/**
 * @module tests/integration/tiles.test
 * @description Integration tests for GET /api/v1/tiles/fotos.json — o TileJSON
 * da camada de pontos.
 *
 * O FOCO E A URL DOS TILES, e a razao e um defeito de producao: atras do nginx
 * o servico montava `https://ebgeo.1cgeo.eb.mil.br:80/...`, misturando o esquema
 * do `x-forwarded-proto` com a porta interna que vinha no `Host`. O navegador
 * abria TLS contra a porta 80 e o MapLibre so via "Failed to fetch (0)".
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestData, destroyTestData } from '../helpers/test-db.js';

let app, dataDir;

before(async () => {
  ({ dataDir } = createTestData());
  process.env.STREETVIEW_DATA_DIR = dataDir;

  const { buildApp } = await import('../helpers/build-app.js');
  app = await buildApp();
});

after(async () => {
  await app.close();
  await destroyTestData(dataDir);
});

const getTileJson = (headers = {}) =>
  app.inject({ method: 'GET', url: '/api/v1/tiles/fotos.json', headers });

const urlDosTiles = async (headers) => JSON.parse((await getTileJson(headers)).body).tiles[0];

describe('GET /api/v1/tiles/fotos.json', () => {
  it('declara a camada, a faixa de zoom e a caixa do acervo', async () => {
    const res = await getTileJson();
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);

    assert.equal(body.tilejson, '3.0.0');
    assert.equal(body.name, 'fotos');
    assert.equal(body.minzoom, 11);
    assert.equal(body.maxzoom, 12);
    assert.deepEqual(body.vector_layers.map(v => v.id), ['fotos']);
    assert.equal(body.bounds.length, 4);
  });

  it('usa o host do pedido quando nao ha proxy', async () => {
    const url = await urlDosTiles({ host: '127.0.0.1:8081' });
    assert.equal(url, 'http://127.0.0.1:8081/api/v1/tiles/fotos/{z}/{x}/{y}.pbf');
  });

  it('honra x-forwarded-proto e x-forwarded-host', async () => {
    const url = await urlDosTiles({
      host: '127.0.0.1:8081',
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'ebgeo.1cgeo.eb.mil.br',
    });
    assert.equal(url, 'https://ebgeo.1cgeo.eb.mil.br/api/v1/tiles/fotos/{z}/{x}/{y}.pbf');
  });

  // O caso de producao: o nginx repassa `$host:$server_port`, entao a porta 80
  // (a escuta interna) chega junto do esquema https. Manter as duas emite uma
  // URL que nenhum navegador consegue abrir.
  it('descarta a porta 80 que o proxy anexa ao host sob https', async () => {
    const url = await urlDosTiles({
      host: 'ebgeo.1cgeo.eb.mil.br:80',
      'x-forwarded-proto': 'https',
    });
    assert.equal(url, 'https://ebgeo.1cgeo.eb.mil.br/api/v1/tiles/fotos/{z}/{x}/{y}.pbf');
  });

  it('descarta a porta 80 tambem quando ela vem no x-forwarded-host', async () => {
    const url = await urlDosTiles({
      host: '127.0.0.1:8081',
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'ebgeo.1cgeo.eb.mil.br:80',
    });
    assert.equal(url, 'https://ebgeo.1cgeo.eb.mil.br/api/v1/tiles/fotos/{z}/{x}/{y}.pbf');
  });

  it('descarta a porta 443 redundante sob https', async () => {
    const url = await urlDosTiles({
      host: 'ebgeo.1cgeo.eb.mil.br:443',
      'x-forwarded-proto': 'https',
    });
    assert.equal(url, 'https://ebgeo.1cgeo.eb.mil.br/api/v1/tiles/fotos/{z}/{x}/{y}.pbf');
  });

  // Porta publica de verdade continua na URL: descartar toda porta quebraria
  // quem publica o servico fora da 80/443.
  it('preserva a porta publica nao padrao', async () => {
    const url = await urlDosTiles({
      host: 'ebgeo.1cgeo.eb.mil.br:8443',
      'x-forwarded-proto': 'https',
    });
    assert.equal(url, 'https://ebgeo.1cgeo.eb.mil.br:8443/api/v1/tiles/fotos/{z}/{x}/{y}.pbf');
  });

  // Dois proxies em serie empilham valor separado por virgula. O primeiro e o
  // que o cliente falou; os demais sao saltos internos.
  it('toma o primeiro valor quando o cabecalho vem em lista', async () => {
    const url = await urlDosTiles({
      host: '127.0.0.1:8081',
      'x-forwarded-proto': 'https, http',
      'x-forwarded-host': 'ebgeo.1cgeo.eb.mil.br, interno.local',
    });
    assert.equal(url, 'https://ebgeo.1cgeo.eb.mil.br/api/v1/tiles/fotos/{z}/{x}/{y}.pbf');
  });

  it('preserva host IPv6 com porta interna', async () => {
    const url = await urlDosTiles({ host: '[::1]:8081' });
    assert.equal(url, 'http://[::1]:8081/api/v1/tiles/fotos/{z}/{x}/{y}.pbf');
  });
});

// O segundo defeito de producao, e o que a normalizacao de porta nao alcanca.
// O servico esta publicado em https://ebgeo.1cgeo.eb.mil.br/ebgeo_360/, e o
// nginx reescreve esse prefixo para /api/v1/ antes de repassar. O pedido chega
// aqui como /api/v1/tiles/fotos.json, sem vestigio do prefixo, entao deduzir
// so podia dar /api/v1/tiles/..., que publicamente e 404.
describe('GET /api/v1/tiles/fotos.json sob prefixo publico', () => {
  after(() => { delete process.env.PUBLIC_API_BASE_URL; });

  it('publica a base declarada, e nao a deduzida do pedido', async () => {
    process.env.PUBLIC_API_BASE_URL = 'https://ebgeo.1cgeo.eb.mil.br/ebgeo_360';
    const url = await urlDosTiles({
      host: '127.0.0.1:8081',
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'ebgeo.1cgeo.eb.mil.br:80',
    });
    assert.equal(
      url,
      'https://ebgeo.1cgeo.eb.mil.br/ebgeo_360/tiles/fotos/{z}/{x}/{y}.pbf',
    );
  });

  it('tolera barra final na chave, que nao dobra na URL', async () => {
    process.env.PUBLIC_API_BASE_URL = 'https://ebgeo.1cgeo.eb.mil.br/ebgeo_360/';
    const url = await urlDosTiles({ host: '127.0.0.1:8081' });
    assert.equal(
      url,
      'https://ebgeo.1cgeo.eb.mil.br/ebgeo_360/tiles/fotos/{z}/{x}/{y}.pbf',
    );
  });

  it('volta a deduzir quando a chave sai do ambiente', async () => {
    process.env.PUBLIC_API_BASE_URL = 'https://ebgeo.1cgeo.eb.mil.br/ebgeo_360';
    delete process.env.PUBLIC_API_BASE_URL;
    const url = await urlDosTiles({ host: '127.0.0.1:8081' });
    assert.equal(url, 'http://127.0.0.1:8081/api/v1/tiles/fotos/{z}/{x}/{y}.pbf');
  });
});
