/**
 * @module tests/integration/floors
 * @description Andares: a rota /floors, e o filtro de andar do /nearby.
 *
 * O filtro do /nearby e o teste que importa. Ele nao pode ser "so devolveu o
 * andar 1", porque isso passaria tambem se nao houvesse vizinho de outro andar
 * nenhum. Cada caso aqui AFIRMA A VARIANCIA primeiro: monta fotos empilhadas
 * na vertical e confere que a consulta sem filtro as devolveria.
 *
 * Medido no lote real: numa foto do 1o andar do Beira-Rio, a busca sem filtro
 * devolve 51 fotos, 38 delas dos outros SEIS niveis.
 */

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert';
import { createTestData, destroyTestData, SEEDS } from '../helpers/test-db.js';

let app, dataDir, getIndexDb;

/** Nivel do predio de teste. */
const ANDAR_TERREO = 0;
const ANDAR_UM = 1;

/**
 * Empilha fotos sobre a foto 1: mesma posicao em planta, andar diferente.
 * E a geometria que quebra qualquer consulta espacial 2D.
 */
function empilharFotos(db) {
  const insertPhoto = db.prepare(`
    INSERT INTO photos (id, project_id, original_name, display_name, sequence_number,
                        lat, lon, ele, heading, camera_height, mesh_rotation_y,
                        floor_level, floor_label, full_size_bytes, preview_size_bytes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)
  `);
  const insertRowid = db.prepare('INSERT INTO photos_rowid (photo_id) VALUES (?)');
  const insertRtree = db.prepare(
    'INSERT INTO photos_rtree (rowid_id, min_lon, max_lon, min_lat, max_lat) VALUES (?, ?, ?, ?, ?)'
  );

  const empilhadas = [
    { id: 'aaaaaaaa-0000-4000-8000-000000000001', nivel: ANDAR_TERREO, rotulo: 'Térreo', seq: 101 },
    { id: 'aaaaaaaa-0000-4000-8000-000000000002', nivel: 2, rotulo: '2º andar', seq: 102 },
    { id: 'aaaaaaaa-0000-4000-8000-000000000003', nivel: 5, rotulo: '5º andar', seq: 103 },
  ];

  for (const e of empilhadas) {
    // Deslocamento de ~1 m: perto o bastante para cair na bbox, distinto o
    // bastante para nao colidir com a foto de origem.
    const lat = SEEDS.PHOTO_1_LAT + 0.00001;
    const lon = SEEDS.PHOTO_1_LON + 0.00001;
    insertPhoto.run(
      e.id, SEEDS.PROJECT_ID, `EMPILHADA_${e.seq}`, `Empilhada ${e.seq}`, e.seq,
      lat, lon, 0, 0, 2, 180, e.nivel, e.rotulo
    );
    const rowid = insertRowid.run(e.id).lastInsertRowid;
    insertRtree.run(rowid, lon, lon, lat, lat);
  }

  // A foto de origem passa a ser do 1o andar.
  db.prepare('UPDATE photos SET floor_level = ?, floor_label = ? WHERE id = ?')
    .run(ANDAR_UM, '1º andar', SEEDS.PHOTO_1_ID);

  // E o projeto passa a TER andares. Sem esta linha o filtro fica desligado,
  // que e o comportamento correto para os projetos externos do acervo.
  const insertFloor = db.prepare(
    'INSERT OR REPLACE INTO project_floors (project_id, level, label, plan_coords) VALUES (?, ?, ?, ?)'
  );
  insertFloor.run(SEEDS.PROJECT_ID, ANDAR_TERREO, 'Térreo', null);
  insertFloor.run(SEEDS.PROJECT_ID, ANDAR_UM, '1º andar', JSON.stringify([
    [[SEEDS.PHOTO_1_LON, SEEDS.PHOTO_1_LAT], [SEEDS.PHOTO_1_LON + 0.0001, SEEDS.PHOTO_1_LAT]],
  ]));
  insertFloor.run(SEEDS.PROJECT_ID, 2, '2º andar', null);
  insertFloor.run(SEEDS.PROJECT_ID, 5, '5º andar', null);
}

before(async () => {
  ({ dataDir } = createTestData());
  process.env.STREETVIEW_DATA_DIR = dataDir;

  ({ getIndexDb } = await import('../../src/db/connection.js'));
  empilharFotos(getIndexDb());

  const { buildApp } = await import('../helpers/build-app.js');
  app = await buildApp();
});

after(async () => {
  if (app) await app.close();
  await destroyTestData(dataDir);
});

describe('GET /api/v1/projects/:slug/floors', () => {
  test('lista os andares de cima para baixo, com planta e contagem', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${SEEDS.PROJECT_SLUG}/floors`,
    });

    assert.equal(res.statusCode, 200);
    const { floors } = JSON.parse(res.body);

    assert.deepEqual(floors.map(f => f.level), [5, 2, 1, 0]);
    assert.deepEqual(floors.map(f => f.label), ['5º andar', '2º andar', '1º andar', 'Térreo']);

    const primeiro = floors.find(f => f.level === ANDAR_UM);
    assert.equal(primeiro.plan.type, 'FeatureCollection');
    assert.equal(primeiro.plan.features.length, 1);
    assert.equal(primeiro.plan.features[0].geometry.type, 'LineString');

    // Andar sem planta desenhada devolve null, nao uma colecao vazia: os dois
    // significam coisas diferentes para quem desenha a camada.
    assert.equal(floors.find(f => f.level === ANDAR_TERREO).plan, null);
  });

  test('projeto inexistente da 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/projects/nao-existe/floors' });
    assert.equal(res.statusCode, 404);
  });
});

describe('GET /api/v1/photos/:uuid/nearby com andares', () => {
  test('a busca crua DEVOLVERIA os outros andares', async () => {
    // A variancia, afirmada antes da comparacao. Sem este caso, o teste
    // seguinte passaria num conjunto onde nao ha nada para filtrar.
    const db = getIndexDb();
    const cru = db.prepare(`
      SELECT COUNT(*) AS n FROM photos
      WHERE project_id = ? AND id != ? AND floor_level != ?
        AND ABS(lat - ?) < 0.0005 AND ABS(lon - ?) < 0.0005
    `).get(SEEDS.PROJECT_ID, SEEDS.PHOTO_1_ID, ANDAR_UM, SEEDS.PHOTO_1_LAT, SEEDS.PHOTO_1_LON);

    assert.ok(cru.n >= 3, `esperava fotos de outro andar por perto, achei ${cru.n}`);
  });

  test('mas o /nearby devolve so o andar da foto de origem', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/photos/${SEEDS.PHOTO_1_ID}/nearby?radius=100`,
    });

    assert.equal(res.statusCode, 200);
    const { photos } = JSON.parse(res.body);

    const niveis = [...new Set(photos.map(p => p.floor_level))];
    assert.deepEqual(niveis, [ANDAR_UM], `vazou andar: ${JSON.stringify(niveis)}`);
  });

  // O filtro protege contra a ligacao acidental entre andares, mas ele nao pode
  // ser absoluto: escada e vomitorio ligam niveis diferentes de proposito. No
  // Beira-Rio, 84 das 894 ligacoes cruzam nivel. Sem a saida abaixo a interface
  // nao consegue ligar o campo a arquibancada.
  test('floor=all abre a busca para todos os andares', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/photos/${SEEDS.PHOTO_1_ID}/nearby?radius=100&floor=all`,
    });

    assert.equal(res.statusCode, 200);
    const { photos } = JSON.parse(res.body);
    const niveis = [...new Set(photos.map(p => p.floor_level))];

    assert.ok(niveis.length > 1,
      `com floor=all esperava mais de um nivel, veio ${JSON.stringify(niveis)}`);
    assert.ok(niveis.includes(ANDAR_UM), 'o andar da origem tem de continuar na lista');
  });

  test('floor=<n> fixa um nivel', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/photos/${SEEDS.PHOTO_1_ID}/nearby?radius=100&floor=${ANDAR_TERREO}`,
    });

    assert.equal(res.statusCode, 200);
    const { photos } = JSON.parse(res.body);
    assert.ok(photos.length > 0, 'esperava foto no terreo');
    assert.deepEqual([...new Set(photos.map(p => p.floor_level))], [ANDAR_TERREO]);
  });

  test('floor invalido e 400, e nao um filtro silencioso', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/photos/${SEEDS.PHOTO_1_ID}/nearby?radius=100&floor=terreo`,
    });
    assert.equal(res.statusCode, 400);
  });

  test('o andar da origem vem PRIMEIRO, e o outro traz distancia 3D', async () => {
    // Em planta a foto empilhada aparece colada (0,7 m no Beira-Rio). Se a
    // ordem fosse so por distancia 2D, ela lideraria a lista sem ser a vizinha
    // que o operador procura.
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/photos/${SEEDS.PHOTO_1_ID}/nearby?radius=100&floor=all`,
    });
    const { photos } = JSON.parse(res.body);

    const primeiroDeFora = photos.findIndex(p => p.floor_level !== ANDAR_UM);
    const ultimoDoAndar = photos.map(p => p.floor_level).lastIndexOf(ANDAR_UM);
    assert.ok(primeiroDeFora === -1 || primeiroDeFora > ultimoDoAndar,
      'foto de outro andar apareceu antes de alguma do andar da origem');

    for (const p of photos) {
      assert.equal(typeof p.distance3d, 'number', 'distance3d tem de vir sempre');
      assert.ok(p.distance3d >= p.distance - 1e-9,
        'a distancia 3D nunca e menor que a distancia em planta');
    }
  });

  test('projeto SEM andares nao ganha filtro nenhum', async () => {
    // Os 28 projetos externos do acervo tem floor_level = 1 e nenhuma linha em
    // project_floors. O filtro tem de ficar desligado para eles.
    const db = getIndexDb();
    db.prepare('DELETE FROM project_floors WHERE project_id = ?').run(SEEDS.PROJECT_ID);

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/photos/${SEEDS.PHOTO_1_ID}/nearby?radius=100`,
    });
    const { photos } = JSON.parse(res.body);
    const niveis = [...new Set(photos.map(p => p.floor_level))].sort();

    assert.ok(niveis.length > 1, `esperava varios niveis sem o filtro, veio ${JSON.stringify(niveis)}`);
  });
});
