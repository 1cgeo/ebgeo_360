/**
 * @module tests/integration/project-map.test
 * @description Integration tests for GET /api/v1/projects/:slug/map — o payload
 * do modo mapa da calibracao. Arquivo proprio (e nao um bloco em
 * calibration.test.js) porque aquele suite apaga fotos ao longo do caminho e
 * termina com o projeto reduzido a uma foto, o que tornaria o tracado trivial.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestData, destroyTestData, SEEDS } from '../helpers/test-db.js';

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

const getMap = (slug = SEEDS.PROJECT_SLUG) =>
  app.inject({ method: 'GET', url: `/api/v1/projects/${slug}/map` });

describe('GET /api/v1/projects/:slug/map', () => {
  it('returns 404 for an unknown project', async () => {
    const res = await getMap('nao-existe');
    assert.equal(res.statusCode, 404);
    assert.equal(JSON.parse(res.body).error, 'Project not found or has no photos');
  });

  it('returns every photo of the project, ordered by sequence', async () => {
    const res = await getMap();
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);

    assert.equal(body.slug, SEEDS.PROJECT_SLUG);
    assert.equal(body.photos.length, 3);
    assert.deepEqual(body.photos.map(p => p.seq), [1, 2, 3]);
    assert.deepEqual(
      body.photos.map(p => p.id),
      [SEEDS.PHOTO_1_ID, SEEDS.PHOTO_2_ID, SEEDS.PHOTO_3_ID],
    );
  });

  it('carries position, name and review state per photo', async () => {
    const body = JSON.parse((await getMap()).body);
    const p1 = body.photos.find(p => p.id === SEEDS.PHOTO_1_ID);

    assert.equal(p1.name, SEEDS.PHOTO_1_DISPLAY_NAME);
    assert.equal(p1.lat, SEEDS.PHOTO_1_LAT);
    assert.equal(p1.lon, SEEDS.PHOTO_1_LON);
    assert.equal(p1.heading, SEEDS.PHOTO_1_HEADING);
    assert.equal(p1.reviewed, false);
  });

  it('carries the three calibration angles', async () => {
    // Escreve valores distintos nos tres eixos para provar que o mapa devolve
    // cada um no seu campo, e nao o mesmo numero repetido.
    await app.inject({
      method: 'PUT',
      url: `/api/v1/photos/${SEEDS.PHOTO_1_ID}/calibration`,
      payload: { mesh_rotation_y: 123.5 },
    });
    await app.inject({
      method: 'PUT',
      url: `/api/v1/photos/${SEEDS.PHOTO_1_ID}/rotation-x`,
      payload: { mesh_rotation_x: -7.25 },
    });
    await app.inject({
      method: 'PUT',
      url: `/api/v1/photos/${SEEDS.PHOTO_1_ID}/rotation-z`,
      payload: { mesh_rotation_z: 4.5 },
    });

    const body = JSON.parse((await getMap()).body);
    const p1 = body.photos.find(p => p.id === SEEDS.PHOTO_1_ID);
    assert.equal(p1.ry, 123.5);
    assert.equal(p1.rx, -7.25);
    assert.equal(p1.rz, 4.5);
  });

  it('serves the track stored in project_tracks, verbatim', async () => {
    const body = JSON.parse((await getMap()).body);
    assert.equal(body.track.length, 2);
    assert.deepEqual(body.track[0], SEEDS.TRACK_1);
    assert.deepEqual(body.track[1], SEEDS.TRACK_2);
  });

  it('keeps track vertices that are not photo positions', async () => {
    // O tracado vem do geojson do levantamento, nao das posicoes das fotos: um
    // vertice intermediario entre duas fotos tem de sobreviver. Derivar a linha
    // do grafo (o modelo anterior) descartava justamente esse detalhe.
    const body = JSON.parse((await getMap()).body);
    const posicoes = new Set(body.photos.map(p => `${p.lon},${p.lat}`));
    const vertices = body.track.flat();
    const foraDasFotos = vertices.filter(([lon, lat]) => !posicoes.has(`${lon},${lat}`));
    assert.ok(foraDasFotos.length > 0, 'o tracado deveria ter vertice que nao e foto');
  });

  it('bounds enclose every photo', async () => {
    const body = JSON.parse((await getMap()).body);
    const [oeste, sul, leste, norte] = body.bounds;
    for (const p of body.photos) {
      assert.ok(p.lon >= oeste && p.lon <= leste, `lon ${p.lon} fora dos bounds`);
      assert.ok(p.lat >= sul && p.lat <= norte, `lat ${p.lat} fora dos bounds`);
    }
  });

  it('reports review stats and reflects a review', async () => {
    let body = JSON.parse((await getMap()).body);
    assert.equal(body.reviewStats.total, 3);
    assert.equal(body.reviewStats.reviewed, 0);

    await app.inject({
      method: 'PUT',
      url: `/api/v1/photos/${SEEDS.PHOTO_3_ID}/reviewed`,
      payload: { reviewed: true },
    });

    body = JSON.parse((await getMap()).body);
    assert.equal(body.reviewStats.reviewed, 1);
    assert.equal(body.photos.find(p => p.id === SEEDS.PHOTO_3_ID).reviewed, true);
  });

  it('drops soft-deleted photos but keeps the track', async () => {
    const del = await app.inject({ method: 'DELETE', url: `/api/v1/photos/${SEEDS.PHOTO_2_ID}` });
    assert.equal(del.statusCode, 200);

    const body = JSON.parse((await getMap()).body);
    assert.equal(body.photos.length, 2);
    assert.equal(body.photos.some(p => p.id === SEEDS.PHOTO_2_ID), false);
    assert.equal(body.reviewStats.total, 2);
    // O tracado e o caminho por onde a captura passou — apagar uma foto nao
    // desfaz o percurso, entao a linha continua inteira.
    assert.equal(body.track.length, 2);
  });
});
