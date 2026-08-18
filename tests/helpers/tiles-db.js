/**
 * @module tests/helpers/tiles-db
 * @description Monta o banco de tiles de teste ({slug}_tiles.db) e as linhas de
 * index.db que os casos de borda exigem. Usa better-sqlite3 e sharp direto, sem
 * importar nada de src/ no topo, pela mesma razao de test-db.js: o import de
 * src/ dispara a cadeia config.js -> connection.js antes da hora.
 *
 * OS TILES SAO WEBP DE VERDADE, gerados por sharp, e nao bytes inventados. Um
 * Buffer falso passaria no teste de bytes iguais e esconderia dois defeitos que
 * so aparecem em imagem real: o tile de borda tem dimensao MENOR (a piramide
 * recorta em vez de completar), e o cliente so desenha se o corpo for um WebP
 * decodificavel.
 *
 * A GEOMETRIA VEM ESCRITA A MAO, nivel a nivel, e nao de montarEscada. A fixture
 * e a referencia FIXA contra a qual a rota e conferida. Se ela chamasse o mesmo
 * modulo que a rota chama, uma mudanca de arredondamento moveria os dois juntos
 * e o teste concordaria com o defeito.
 *
 * A ESCADA DESCE ATE UM TILE desde 2026-08-18. Antes ela parava em 2048, e o
 * primeiro quadro vinha do `preview_webp`. Agora o nivel mais grosso E o
 * preview, entao toda piramide daqui ganhou niveis embaixo e a NUMERACAO
 * EMPURROU: o que era level 0 virou level 2 ou 3. O contrato de level 0 ser o
 * mais grosso nao mudou.
 *
 * As quatro piramides cobrem quatro perguntas diferentes:
 *
 *   TILED   2560x1280, tile 512,  razao 2    4 niveis, a grade normal com buraco
 *   DELETED 1024x512,  tile 512,  razao 2    2 niveis, sob lapide de exclusao
 *   RAZAO   5376x2688, tile 1024, razao 1,6  5 niveis, a escada fina
 *   LEGADO  3072x1536, tile 512,  SEM coluna 4 niveis, o arquivo ja no disco
 *
 * O numero de colunas NAO e 2^nivel em nenhuma delas: em TILED a escada da
 * 1, 2, 3 e 5 colunas, e um teste que peca x=3 no nivel 2 (200) e x=3 no nivel 1
 * (400) reprova qualquer reuso da matematica XYZ.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import sharp from 'sharp';
import { SEEDS } from './test-db.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const TILES_SCHEMA_PATH = resolve(__dirname, '..', '..', 'src', 'db', 'tiles-schema.sql');

/**
 * O DDL de tile_pyramids ANTES da coluna `razao`, escrito verbatim.
 *
 * POR QUE UM LITERAL, e nao o arquivo de src/. Este e o formato do
 * museu_cms_tiles.db que ja existe no disco, com 76 fotos e 12160 tiles
 * gravados. Ele nao vai ser regerado so por causa de uma coluna nova, entao a
 * rota TEM de continuar servindo por ele. Se esta fixture lesse o DDL de src/,
 * ela seguiria o schema novo e a regressao que ela guarda desapareceria no dia
 * seguinte, sem ninguem notar.
 *
 * A tabela `tiles` nao mudou, e por isso sai identica a do arquivo de src/.
 * @constant {string}
 */
const DDL_ANTES_DA_RAZAO = `
CREATE TABLE IF NOT EXISTS tiles (
    photo_id  TEXT NOT NULL,
    level     INTEGER NOT NULL,
    x         INTEGER NOT NULL,
    y         INTEGER NOT NULL,
    webp      BLOB NOT NULL,
    PRIMARY KEY (photo_id, level, x, y)
);

CREATE TABLE IF NOT EXISTS tile_pyramids (
    photo_id    TEXT PRIMARY KEY,
    tile_size   INTEGER NOT NULL,
    max_level   INTEGER NOT NULL,
    width       INTEGER NOT NULL,
    height      INTEGER NOT NULL,
    quality     INTEGER NOT NULL,
    tile_count  INTEGER NOT NULL,
    total_bytes INTEGER NOT NULL,
    built_at    TEXT NOT NULL
);
`;

// ============================================================================
// CONSTANTES (exportadas para as asercoes dos testes)
// ============================================================================

export const TILE_SEEDS = {
  TILE_SIZE: 512,
  QUALITY: 80,
  BUILT_AT: '2026-08-14T10:00:00',

  /** A escada classica, que e o que toda piramide anterior a coluna carrega. */
  RAZAO_CLASSICA: 2,

  // O arquivo e NOVO e separado do {slug}.db das imagens.
  TILES_DB_FILENAME: `${SEEDS.PROJECT_SLUG}_tiles.db`,

  // Foto com piramide completa, menos um buraco proposital.
  //
  // A escada desce 1280, 640 e 320, e para em 320 porque 320 cabe no tile de
  // 512. Sao 4 niveis, com 1, 2, 3 e 5 colunas: o mesmo x=3 e 400 no nivel 2 e
  // 200 no nivel 3, que e o que reprova qualquer teto do tipo 2**level.
  TILED_PHOTO_ID: SEEDS.PHOTO_1_ID,
  TILED_WIDTH: 2560,
  TILED_HEIGHT: 1280,
  TILED_MAX_LEVEL: 3,
  TILED_LEVELS: [
    { width: 320, height: 160 },
    { width: 640, height: 320 },
    { width: 1280, height: 640 },
    { width: 2560, height: 1280 },
  ],
  // O buraco existe para provar que tile ausente da tabela responde 404, e nao
  // 200 com corpo vazio nem 500. Fica num nivel/coluna que nenhum outro teste usa.
  //
  // ELE ANDOU JUNTO COM A ESCADA. Era (0,1,1), no nivel de 1280x640; esse nivel
  // agora e o 2. Deixa-lo no nivel 0, que hoje tem 1 coluna e 1 linha, poria o
  // buraco FORA da grade, e o 404 do teste viraria um 400 sem ninguem notar.
  TILED_HOLE: { level: 2, x: 1, y: 1 },

  // Foto COM piramide e COM lapide de exclusao. E a armadilha da implementacao
  // ingenua: os tiles dela existem no banco e um handler que so consulta
  // `tiles` os serve com 200.
  //
  // Ela e o formato mais curto do acervo: 1024 desce um degrau para 512, que ja
  // cabe no tile. Sao 2 niveis, e nao 1, desde que a escada passou a descer ate
  // o tile.
  DELETED_PHOTO_ID: '00000000-0000-4000-a000-000000000040',
  DELETED_WIDTH: 1024,
  DELETED_HEIGHT: 512,
  DELETED_MAX_LEVEL: 1,
  DELETED_LEVELS: [
    { width: 512, height: 256 },
    { width: 1024, height: 512 },
  ],

  // A PIRAMIDE DA ESCADA FINA. Mesmo projeto, mesmo arquivo de tiles, razao 1,6
  // gravada na coluna.
  //
  // A geometria e escolhida para DISCRIMINAR, e nao por acaso. Em 5376 de
  // largura, com tile de 1024, a razao 1,6 desce quatro degraus e da 5 niveis
  // (821, 1313, 2100, 3360, 5376); a razao 2 desce tres e da 4 (672, 1344, 2688,
  // 5376). Uma rota que ignore a coluna e monte a escada com 2 publica 4 niveis,
  // e o nivel 3 dela e o nativo, de 6 colunas, contra as 4 colunas do nivel 3
  // real. Entao (level 3, x 4) separa as duas leituras: 200 na errada, 400 na
  // certa. E o nivel 4 so existe na certa.
  //
  // O SEPARADOR MUDOU DE NIVEL com a escada nova. Ele era (level 2, x 4), e o
  // nivel 2 hoje tem 3 colunas nas DUAS leituras: o teste antigo continuaria
  // verde sem separar nada.
  //
  // O tile_size e 1024, e nao 512, por duas razoes. Ele derruba a geracao de
  // 120 tiles para 35 (contado, nao estimado), e prova que a rota le
  // piramide.tile_size em vez do 512 que todas as outras fixtures usam.
  RAZAO_PHOTO_ID: '00000000-0000-4000-a000-000000000060',
  RAZAO_VALOR: 1.6,
  RAZAO_WIDTH: 5376,
  RAZAO_HEIGHT: 2688,
  RAZAO_TILE_SIZE: 1024,
  RAZAO_MAX_LEVEL: 4,
  RAZAO_LEVELS: [
    { width: 821, height: 410 },
    { width: 1313, height: 656 },
    { width: 2100, height: 1050 },
    { width: 3360, height: 1680 },
    { width: 5376, height: 2688 },
  ],

  // A PIRAMIDE DO ARQUIVO VELHO, num projeto proprio, cujo {slug}_tiles.db nasce
  // do DDL anterior a coluna `razao`. Ela responde a pergunta operacional: o
  // acervo ja gerado continua servindo depois da migracao?
  //
  // 3072 tambem discrimina. Sem coluna a escada tem de sair com razao 2, que
  // desce 1536, 768 e 384 e da 4 niveis. Ler razao 1,6 desceria 1920, 1200, 750
  // e 469, e daria 5. Entao o nivel 4 e 400 na leitura certa e 200 na errada.
  //
  // O SEPARADOR MUDOU. Ele era x=3 no nivel 0, quando o nivel 0 media 1536x768
  // (3 colunas) contra 1920x960 (4 colunas) da leitura errada. Hoje o nivel 0
  // cabe num tile nas duas leituras, e tem 1 coluna nas duas: aquele x=3 segue
  // dando 400, e nao separa mais nada.
  LEGACY_PROJECT_ID: '00000000-0000-4000-a000-000000000003',
  LEGACY_PROJECT_SLUG: 'legado',
  LEGACY_PHOTO_ID: '00000000-0000-4000-a000-000000000070',
  LEGACY_WIDTH: 3072,
  LEGACY_HEIGHT: 1536,
  LEGACY_MAX_LEVEL: 3,
  LEGACY_LEVELS: [
    { width: 384, height: 192 },
    { width: 768, height: 384 },
    { width: 1536, height: 768 },
    { width: 3072, height: 1536 },
  ],

  // Foto viva de um projeto cujo {slug}_tiles.db nao existe no disco.
  NO_DB_PROJECT_ID: '00000000-0000-4000-a000-000000000002',
  NO_DB_PROJECT_SLUG: 'sem-tiles',
  NO_DB_PHOTO_ID: '00000000-0000-4000-a000-000000000050',

  // Foto que existe, tem imagem, e nao tem linha em tile_pyramids.
  NO_PYRAMID_PHOTO_ID: SEEDS.PHOTO_2_ID,

  MISSING_PHOTO_ID: '00000000-0000-0000-0000-000000000000',
};

/** Nome do banco de tiles do projeto legado. */
TILE_SEEDS.LEGACY_TILES_DB_FILENAME = `${TILE_SEEDS.LEGACY_PROJECT_SLUG}_tiles.db`;

/**
 * Chave de um tile no mapa devolvido por createTilesFixture.
 * @param {number} level - Nivel, 0 e o mais grosso
 * @param {number} x - Coluna, origem na esquerda
 * @param {number} y - Linha, origem no topo
 * @returns {string} Chave "level/x/y"
 */
export function chaveTile(level, x, y) {
  return `${level}/${x}/${y}`;
}

// ============================================================================
// SETUP
// ============================================================================

/**
 * Cria os bancos de tiles e as linhas extras de index.db sobre um dataDir que
 * createTestData() ja montou.
 *
 * @param {string} dataDir - Diretorio devolvido por createTestData
 * @returns {Promise<object>} Os BLOBs gravados e os totais, para o teste
 *   comparar byte a byte com o que a rota devolve.
 */
export async function createTilesFixture(dataDir) {
  if (!existsSync(TILES_SCHEMA_PATH)) {
    throw new Error(
      `src/db/tiles-schema.sql nao existe: sem o DDL a fixture nao tem o que criar. `
      + `O contrato de tiles 360 define a tabela tiles e a tabela tile_pyramids.`,
    );
  }
  const ddl = readFileSync(TILES_SCHEMA_PATH, 'utf-8');

  const dbPath = join(dataDir, 'projects', TILE_SEEDS.TILES_DB_FILENAME);
  const db = new Database(dbPath);
  // page_size ANTES de qualquer tabela: depois disso o valor so muda com VACUUM.
  db.pragma('page_size = 65536');
  db.pragma('journal_mode = WAL');
  db.exec(ddl);

  // A COLUNA E EXIGIDA, e a falta dela reprova aqui, alto e claro. A escada e
  // determinada por (width, height, tileSize, razao), entao uma piramide gravada
  // sem a razao nao pode ser reconstruida: o sintoma seria tile faltando na
  // tela, nunca um erro. Um fallback silencioso nesta fixture esconderia
  // exatamente isso.
  const colunas = db.pragma('table_info(tile_pyramids)').map(c => c.name);
  if (!colunas.includes('razao')) {
    throw new Error(
      'src/db/tiles-schema.sql nao tem a coluna `razao` em tile_pyramids. '
      + `Colunas encontradas: ${colunas.join(', ')}.`,
    );
  }

  const insertTile = db.prepare(
    'INSERT INTO tiles (photo_id, level, x, y, webp) VALUES (?, ?, ?, ?, ?)',
  );
  const insertPyramid = db.prepare(`
    INSERT INTO tile_pyramids (photo_id, tile_size, max_level, width, height,
                               quality, tile_count, total_bytes, built_at, razao)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const tiles = await gerarPiramide(
    TILE_SEEDS.TILED_LEVELS, TILE_SEEDS.TILE_SIZE, TILE_SEEDS.TILED_HOLE,
  );
  gravar(insertTile, TILE_SEEDS.TILED_PHOTO_ID, tiles);
  const totalBytes = somaBytes(tiles);
  insertPyramid.run(
    TILE_SEEDS.TILED_PHOTO_ID, TILE_SEEDS.TILE_SIZE, TILE_SEEDS.TILED_MAX_LEVEL,
    TILE_SEEDS.TILED_WIDTH, TILE_SEEDS.TILED_HEIGHT, TILE_SEEDS.QUALITY,
    tiles.size, totalBytes, TILE_SEEDS.BUILT_AT, TILE_SEEDS.RAZAO_CLASSICA,
  );

  const deletedTiles = await gerarPiramide(
    TILE_SEEDS.DELETED_LEVELS, TILE_SEEDS.TILE_SIZE, null,
  );
  gravar(insertTile, TILE_SEEDS.DELETED_PHOTO_ID, deletedTiles);
  insertPyramid.run(
    TILE_SEEDS.DELETED_PHOTO_ID, TILE_SEEDS.TILE_SIZE, TILE_SEEDS.DELETED_MAX_LEVEL,
    TILE_SEEDS.DELETED_WIDTH, TILE_SEEDS.DELETED_HEIGHT, TILE_SEEDS.QUALITY,
    deletedTiles.size, somaBytes(deletedTiles), TILE_SEEDS.BUILT_AT,
    TILE_SEEDS.RAZAO_CLASSICA,
  );

  const razaoTiles = await gerarPiramide(
    TILE_SEEDS.RAZAO_LEVELS, TILE_SEEDS.RAZAO_TILE_SIZE, null,
  );
  gravar(insertTile, TILE_SEEDS.RAZAO_PHOTO_ID, razaoTiles);
  const razaoTotalBytes = somaBytes(razaoTiles);
  insertPyramid.run(
    TILE_SEEDS.RAZAO_PHOTO_ID, TILE_SEEDS.RAZAO_TILE_SIZE, TILE_SEEDS.RAZAO_MAX_LEVEL,
    TILE_SEEDS.RAZAO_WIDTH, TILE_SEEDS.RAZAO_HEIGHT, TILE_SEEDS.QUALITY,
    razaoTiles.size, razaoTotalBytes, TILE_SEEDS.BUILT_AT, TILE_SEEDS.RAZAO_VALOR,
  );

  db.close();

  const legacy = await criarBancoLegado(dataDir);
  seedIndexExtras(dataDir);

  return {
    tiles,
    tileCount: tiles.size,
    totalBytes,
    deletedTiles,
    razaoTiles,
    razaoTotalBytes,
    legacyTiles: legacy.tiles,
    legacyTotalBytes: legacy.totalBytes,
  };
}

/**
 * Cria o {slug}_tiles.db do projeto legado, com o DDL anterior a coluna `razao`.
 *
 * @param {string} dataDir - Diretorio de dados de teste
 * @returns {Promise<{tiles: Map<string, Buffer>, totalBytes: number}>}
 */
async function criarBancoLegado(dataDir) {
  const dbPath = join(dataDir, 'projects', TILE_SEEDS.LEGACY_TILES_DB_FILENAME);
  const db = new Database(dbPath);
  db.pragma('page_size = 65536');
  db.pragma('journal_mode = WAL');
  db.exec(DDL_ANTES_DA_RAZAO);

  const tiles = await gerarPiramide(
    TILE_SEEDS.LEGACY_LEVELS, TILE_SEEDS.TILE_SIZE, null,
  );
  gravar(
    db.prepare('INSERT INTO tiles (photo_id, level, x, y, webp) VALUES (?, ?, ?, ?, ?)'),
    TILE_SEEDS.LEGACY_PHOTO_ID, tiles,
  );

  const totalBytes = somaBytes(tiles);
  // O INSERT nao cita `razao` porque a coluna NAO EXISTE aqui. Este e o ponto
  // inteiro da fixture legada.
  db.prepare(`
    INSERT INTO tile_pyramids (photo_id, tile_size, max_level, width, height,
                               quality, tile_count, total_bytes, built_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    TILE_SEEDS.LEGACY_PHOTO_ID, TILE_SEEDS.TILE_SIZE, TILE_SEEDS.LEGACY_MAX_LEVEL,
    TILE_SEEDS.LEGACY_WIDTH, TILE_SEEDS.LEGACY_HEIGHT, TILE_SEEDS.QUALITY,
    tiles.size, totalBytes, TILE_SEEDS.BUILT_AT,
  );

  db.close();
  return { tiles, totalBytes };
}

// ============================================================================
// GERACAO DOS TILES
// ============================================================================

/**
 * Gera os WebP de uma piramide inteira, com a borda RECORTADA.
 *
 * A cor sai de (level, x, y) para que dois tiles nunca tenham o mesmo corpo:
 * assim o teste prova que a rota devolveu O tile pedido, e nao um vizinho. Um
 * corpo constante deixaria passar troca de x por y.
 *
 * @param {Array<{width:number,height:number}>} niveis - Do mais grosso ao nativo
 * @param {number} tileSize - Lado do tile em pixels
 * @param {{level:number,x:number,y:number}|null} buraco - Tile a NAO gerar
 * @returns {Promise<Map<string, Buffer>>} Mapa "level/x/y" -> WebP
 */
async function gerarPiramide(niveis, tileSize, buraco) {
  const mapa = new Map();

  for (let level = 0; level < niveis.length; level++) {
    const { width: larguraNivel, height: alturaNivel } = niveis[level];
    const cols = Math.ceil(larguraNivel / tileSize);
    const rows = Math.ceil(alturaNivel / tileSize);

    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        if (buraco && buraco.level === level && buraco.x === x && buraco.y === y) continue;

        // Borda recortada: o ultimo tile mede o resto, nunca o lado cheio.
        const larguraTile = Math.min(tileSize, larguraNivel - x * tileSize);
        const alturaTile = Math.min(tileSize, alturaNivel - y * tileSize);

        const webp = await sharp({
          create: {
            width: larguraTile,
            height: alturaTile,
            channels: 3,
            background: { r: 40 + level * 50, g: 30 + x * 30, b: 20 + y * 40 },
          },
        }).webp({ quality: TILE_SEEDS.QUALITY }).toBuffer();

        mapa.set(chaveTile(level, x, y), webp);
      }
    }
  }

  return mapa;
}

/**
 * Grava um mapa de tiles numa foto.
 * @param {object} stmt - Prepared statement de INSERT
 * @param {string} photoId - UUID da foto
 * @param {Map<string, Buffer>} mapa - Mapa "level/x/y" -> WebP
 */
function gravar(stmt, photoId, mapa) {
  for (const [chave, webp] of mapa) {
    const [level, x, y] = chave.split('/').map(Number);
    stmt.run(photoId, level, x, y, webp);
  }
}

/**
 * Soma os bytes de um mapa de tiles. E o token de geracao do ETag, entao o
 * valor tem de sair dos BLOBs REALMENTE gravados, nunca de uma estimativa.
 * @param {Map<string, Buffer>} mapa - Mapa de tiles
 * @returns {number} Total em bytes
 */
function somaBytes(mapa) {
  let total = 0;
  for (const webp of mapa.values()) total += webp.length;
  return total;
}

// ============================================================================
// LINHAS EXTRAS EM index.db
// ============================================================================

/**
 * Acrescenta ao index.db as fotos e projetos que test-db.js nao semeia: a foto
 * excluida, a foto da escada fina, o projeto legado e o projeto sem banco de
 * tiles.
 * @param {string} dataDir - Diretorio de dados de teste
 */
function seedIndexExtras(dataDir) {
  const db = new Database(join(dataDir, 'index.db'));

  const insertPhoto = db.prepare(`
    INSERT INTO photos (id, project_id, original_name, display_name, sequence_number,
                        lat, lon, ele, heading, camera_height, mesh_rotation_y, floor_level,
                        full_size_bytes, preview_size_bytes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertProject = db.prepare(`
    INSERT INTO projects (id, slug, name, description, capture_date, location,
                          center_lat, center_lon, entry_photo_id, photo_count, db_filename)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  /**
   * Insere uma foto com os valores de calibracao da PHOTO_1.
   * @param {string} id - UUID da foto
   * @param {string} projectId - UUID do projeto
   * @param {string} nome - Nome do arquivo original
   * @param {string} display - display_name
   * @param {number} ordem - sequence_number
   */
  const foto = (id, projectId, nome, display, ordem) => insertPhoto.run(
    id, projectId, nome, display, ordem,
    SEEDS.PHOTO_1_LAT, SEEDS.PHOTO_1_LON, SEEDS.PHOTO_1_ELE,
    SEEDS.PHOTO_1_HEADING, SEEDS.PHOTO_1_CAMERA_HEIGHT,
    SEEDS.PHOTO_1_MESH_ROTATION_Y, 1,
    SEEDS.FULL_BLOB.length, SEEDS.PREVIEW_BLOB.length,
  );

  // Foto do mesmo projeto, com tiles gravados, e apagada por soft-delete.
  foto(TILE_SEEDS.DELETED_PHOTO_ID, SEEDS.PROJECT_ID, 'IMG_004.jpg', 'Photo 004', 4);
  db.prepare('INSERT INTO deleted_photos (photo_id) VALUES (?)')
    .run(TILE_SEEDS.DELETED_PHOTO_ID);

  // Foto do mesmo projeto, com a piramide de razao 1,6.
  foto(TILE_SEEDS.RAZAO_PHOTO_ID, SEEDS.PROJECT_ID, 'IMG_006.jpg', 'Photo 006', 6);

  // Projeto sem {slug}_tiles.db no disco: e o estado de 28 dos 29 projetos
  // enquanto a piramide nao roda no acervo inteiro.
  insertProject.run(
    TILE_SEEDS.NO_DB_PROJECT_ID, TILE_SEEDS.NO_DB_PROJECT_SLUG, 'Projeto sem tiles',
    'Projeto cujo banco de tiles nao foi gerado', '2024-02-20', 'Test Location',
    SEEDS.PHOTO_1_LAT, SEEDS.PHOTO_1_LON,
    TILE_SEEDS.NO_DB_PHOTO_ID, 1, `${TILE_SEEDS.NO_DB_PROJECT_SLUG}.db`,
  );
  foto(TILE_SEEDS.NO_DB_PHOTO_ID, TILE_SEEDS.NO_DB_PROJECT_ID, 'IMG_101.jpg', 'Photo 101', 1);

  // Projeto cujo banco de tiles nasceu antes da coluna `razao`.
  insertProject.run(
    TILE_SEEDS.LEGACY_PROJECT_ID, TILE_SEEDS.LEGACY_PROJECT_SLUG, 'Projeto legado',
    'Projeto com piramide anterior a coluna razao', '2024-03-10', 'Test Location',
    SEEDS.PHOTO_1_LAT, SEEDS.PHOTO_1_LON,
    TILE_SEEDS.LEGACY_PHOTO_ID, 1, `${TILE_SEEDS.LEGACY_PROJECT_SLUG}.db`,
  );
  foto(TILE_SEEDS.LEGACY_PHOTO_ID, TILE_SEEDS.LEGACY_PROJECT_ID, 'IMG_201.jpg', 'Photo 201', 1);

  db.close();
}
