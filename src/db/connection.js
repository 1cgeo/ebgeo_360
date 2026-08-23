/**
 * @module db/connection
 * @description Manages SQLite connections to index.db and per-project image databases.
 * Uses better-sqlite3 synchronous API for optimal read performance.
 */

import Database from 'better-sqlite3';
import { readFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import config from '../config.js';
import { resetStatements } from './queries.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

// Singleton connections
let indexDb = null;
const projectDbs = new Map();

/**
 * Opens and initializes the central index database.
 * @returns {Database} The index database connection.
 */
export function getIndexDb() {
  if (indexDb) return indexDb;

  if (!existsSync(config.dataDir)) {
    mkdirSync(config.dataDir, { recursive: true });
  }

  indexDb = new Database(config.indexDbPath);
  indexDb.pragma('journal_mode = WAL');
  indexDb.pragma('synchronous = NORMAL');
  indexDb.pragma('cache_size = -64000'); // 64 MB cache
  indexDb.pragma('busy_timeout = 5000'); // espera ate 5s em vez de falhar com SQLITE_BUSY

  // Initialize schema
  const schema = readFileSync(resolve(__dirname, 'schema.sql'), 'utf-8');
  indexDb.exec(schema);

  // Aplica todas as migracoes de startup numa unica transacao (atomicidade)
  indexDb.transaction(() => {
    // Migrate: add columns if missing (for existing DBs)
    const cols = indexDb.pragma('table_info(photos)');
    if (!cols.some(c => c.name === 'calibration_reviewed')) {
      indexDb.exec('ALTER TABLE photos ADD COLUMN calibration_reviewed INTEGER DEFAULT 0');
    }
    if (!cols.some(c => c.name === 'calibration_source')) {
      indexDb.exec('ALTER TABLE photos ADD COLUMN calibration_source TEXT');
    }
    if (!cols.some(c => c.name === 'mesh_rotation_x')) {
      indexDb.exec('ALTER TABLE photos ADD COLUMN mesh_rotation_x REAL DEFAULT 0');
    }
    if (!cols.some(c => c.name === 'mesh_rotation_z')) {
      indexDb.exec('ALTER TABLE photos ADD COLUMN mesh_rotation_z REAL DEFAULT 0');
    }
    if (!cols.some(c => c.name === 'distance_scale')) {
      indexDb.exec('ALTER TABLE photos ADD COLUMN distance_scale REAL DEFAULT 1.0');
    }
    if (!cols.some(c => c.name === 'marker_scale')) {
      indexDb.exec('ALTER TABLE photos ADD COLUMN marker_scale REAL DEFAULT 1.0');
    }

    // Migrate: rename override columns in targets table
    const targetCols = indexDb.pragma('table_info(targets)');
    if (targetCols.some(c => c.name === 'override_heading') && !targetCols.some(c => c.name === 'override_bearing')) {
      indexDb.exec('ALTER TABLE targets RENAME COLUMN override_heading TO override_bearing');
      indexDb.exec('ALTER TABLE targets RENAME COLUMN override_pitch TO override_distance');
      // O UPDATE que reescrevia override_distance < 0.5 para 5 saiu daqui.
      // Ele existia para consertar um valor que alimentava o desenho; hoje o
      // override e inerte e serve como REGISTRO de quais fotos estao mal
      // posicionadas, entao reescreve-lo a cada partida adulterava a unica
      // coisa que esses campos ainda valem.
    }

    // Migrate: add hidden column to targets table
    const targetCols2 = indexDb.pragma('table_info(targets)');
    if (!targetCols2.some(c => c.name === 'hidden')) {
      indexDb.exec('ALTER TABLE targets ADD COLUMN hidden INTEGER DEFAULT 0');
    }

    // Migrate: add override_height column to targets table
    const targetCols3 = indexDb.pragma('table_info(targets)');
    if (!targetCols3.some(c => c.name === 'override_height')) {
      indexDb.exec('ALTER TABLE targets ADD COLUMN override_height REAL');
    }

    // deleted_photos e os indices idx_targets_target/idx_targets_source_order
    // vivem no schema.sql, que roda incondicionalmente acima (com IF NOT EXISTS),
    // entao ja existem aqui: recria-los era redundancia. O filtro por photo_id
    // em deleted_photos e servido pelo indice automatico da PRIMARY KEY.

    // Migrate: faixa de coleta (ver capture_runs em schema.sql).
    //
    // A tabela em si ja veio do schema.sql com IF NOT EXISTS; o que falta num
    // banco anterior sao as colunas de photos. As tres entram vazias: quem as
    // preenche e `npm run derive-runs`, que le o identificador de sessao do
    // original_name. Um banco com as colunas nulas continua funcionando — a
    // interface trata "sem faixa" como o modo antigo.
    const photoCols = indexDb.pragma('table_info(photos)');
    if (!photoCols.some(c => c.name === 'run_id')) {
      indexDb.exec('ALTER TABLE photos ADD COLUMN run_id TEXT REFERENCES capture_runs(id)');
    }
    if (!photoCols.some(c => c.name === 'run_position')) {
      indexDb.exec('ALTER TABLE photos ADD COLUMN run_position INTEGER');
    }
    if (!photoCols.some(c => c.name === 'captured_at')) {
      indexDb.exec('ALTER TABLE photos ADD COLUMN captured_at TEXT');
    }
    // Migrate: rotulo do andar (ver floor_label em schema.sql). O floor_level
    // ja existia; o rotulo e novo. Entra NULO, e so a migracao de um projeto
    // com andares o preenche — num projeto externo ele fica nulo para sempre,
    // que e o correto: nao ha andar para nomear.
    if (!photoCols.some(c => c.name === 'floor_label')) {
      indexDb.exec('ALTER TABLE photos ADD COLUMN floor_label TEXT');
    }
    // Depois dos ALTER, nunca antes: num banco anterior as colunas so passam a
    // existir nas linhas acima.
    indexDb.exec('CREATE INDEX IF NOT EXISTS idx_photos_run ON photos(run_id, run_position)');
    // Consulta espacial por andar (nearbyPhotos). Sem ele o filtro de andar
    // vira varredura no conjunto que o rtree devolveu.
    indexDb.exec('CREATE INDEX IF NOT EXISTS idx_photos_floor ON photos(project_id, floor_level)');
  })();

  return indexDb;
}

/**
 * Teto do `mmap_size`, em bytes.
 *
 * POR QUE ELE MUDOU DE 256 MB PARA CA. Aquele numero foi dimensionado para o
 * `{slug}.db` de imagem. O banco de PIRAMIDE passou dele: os arquivos de
 * producao vao de 0,5 a 21 GB, e 256 MB cobrem entre 1,2% e 51% do arquivo.
 *
 * Medido duas vezes, por caminhos independentes, no `faxinal_tiles.db` de
 * 1124 MiB: com o mmap cobrindo o arquivo o seek cai de 29,3 para 19,0
 * microssegundos, ou 54,7% mais rapido. No `aman_tiles.db` de 703 MiB o ganho
 * foi de 55,6%. E a unica variante que sai da regua de ruido.
 *
 * O TETO EXISTE PORQUE O MAPA E ESPACO DE ENDERECAMENTO, e o servico abre uma
 * conexao por projeto. Em Linux as paginas mapeadas sao cache de arquivo,
 * recuperaveis sob pressao, e nao inflam o RSS: medido no proprio container,
 * com cgroup de 512 MB e tres projetos quentes, o processo ficou em 34,5 MiB.
 * Ainda assim o teto fica, para que um acervo com dezenas de bancos de 21 GB
 * nao peca um mapa sem limite.
 * @constant {number}
 */
const MMAP_TETO_BYTES = parseInt(process.env.SQLITE_MMAP_MAX || String(2 * 1024 * 1024 * 1024), 10);

/**
 * O `mmap_size` que um arquivo merece: o proprio tamanho dele, ate o teto.
 *
 * Mapear alem do fim do arquivo nao ajuda em nada, e mapear muito aquem deixa a
 * leitura cair em `read()` justamente nos bancos grandes, que sao os que doem.
 * @param {string} caminho - Caminho do arquivo SQLite
 * @returns {number} Bytes a pedir em `PRAGMA mmap_size`
 */
export function mmapPara(caminho) {
  const info = statSync(caminho, { throwIfNoEntry: false });
  if (!info) return MMAP_TETO_BYTES;
  return Math.min(info.size, MMAP_TETO_BYTES);
}

/**
 * Opens a per-project image database (lazy, cached).
 * @param {string} dbFilename - The database filename (e.g., "alegrete.db").
 * @returns {Database} The project database connection.
 */
export function getProjectDb(dbFilename) {
  if (projectDbs.has(dbFilename)) {
    return projectDbs.get(dbFilename);
  }

  const dbPath = join(config.projectsDbDir, dbFilename);
  if (!existsSync(dbPath)) {
    return null;
  }

  const db = new Database(dbPath, { readonly: true });
  // journal_mode=WAL nao se aplica em conexao readonly (no-op): o modo ja vem
  // persistido do arquivo (definido em createProjectDb). Reforcamos query_only.
  db.pragma('query_only = true');
  // CACHE PEQUENO DE PROPOSITO. Os 32 MB anteriores eram inertes: medido no
  // banco de tiles, 2 MB rendem o mesmo que 128 MB, porque a chave primaria
  // deixa os tiles de um frustum adjacentes e a rajada toca poucas paginas.
  // O que decide e o mmap, logo abaixo.
  db.pragma('cache_size = -2000');
  db.pragma('busy_timeout = 5000'); // espera ate 5s em vez de falhar com SQLITE_BUSY
  db.pragma(`mmap_size = ${mmapPara(dbPath)}`);

  projectDbs.set(dbFilename, db);
  return db;
}

/**
 * Creates a new per-project image database with optimized page size.
 * Used during migration only.
 * @param {string} dbFilename - The database filename.
 * @returns {Database} The new project database connection.
 */
export function createProjectDb(dbFilename) {
  if (!existsSync(config.projectsDbDir)) {
    mkdirSync(config.projectsDbDir, { recursive: true });
  }

  const dbPath = join(config.projectsDbDir, dbFilename);
  const db = new Database(dbPath);

  // 64 KB page size optimizes BLOB reads via sqlite3_blob_open
  db.pragma('page_size = 65536');
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('mmap_size = 268435456'); // 256 MB: le BLOBs via memory-map, reduz syscalls read()

  // Initialize schema
  const schema = readFileSync(resolve(__dirname, 'project-schema.sql'), 'utf-8');
  db.exec(schema);

  projectDbs.set(dbFilename, db);
  return db;
}

/**
 * Closes all database connections. Call on graceful shutdown.
 */
export function closeAll() {
  // Invalida o cache de prepared statements antes de fechar a conexao:
  // os statements em _stmts apontam para indexDb e ficariam invalidos.
  resetStatements();

  if (indexDb) {
    indexDb.close();
    indexDb = null;
  }
  for (const [name, db] of projectDbs) {
    db.close();
    projectDbs.delete(name);
  }
}
