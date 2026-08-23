/**
 * @module db/tiles-queries
 * @description Prepared statements do banco de piramide de um projeto
 * ({slug}_tiles.db). Le a descricao da piramide e o BLOB de um tile.
 *
 * POR QUE UM ARQUIVO SEPARADO DE queries.js. Aquele modulo fala com o index.db
 * (metadado) e com o {slug}.db (imagem inteira). A piramide mora num TERCEIRO
 * arquivo, {slug}_tiles.db, e por uma razao operacional: reconstruir os tiles de
 * um projeto nao pode reescrever os BLOBs de 2,5 MB de `images`, que nao mudaram.
 *
 * A PRIMEIRA abertura sai de getProjectDb, que ja abre readonly com query_only,
 * cache de 32 MB e mmap de 256 MB. Depois de uma TROCA do arquivo a conexao passa
 * a ser deste modulo, e o porque esta em `abrirConexao`.
 */

import Database from 'better-sqlite3';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import config from '../config.js';
import { getProjectDb, mmapPara } from './connection.js';
// A razao padrao vem de pyramid-math.js, o mesmo modulo do gerador e do cliente.
// Ela e o valor que o banco anterior a coluna `razao` carrega implicitamente.
import { RAZAO_PADRAO } from '../../public/calibration/js/pyramid-math.js';

/**
 * Cache de conexao e prepared statements por arquivo de tiles.
 * Map<dbFilename, { db, propria, mtimeMs, size, pyramid, tile }>
 *
 * Guardamos a CONEXAO junto do statement. closeAll() descarta as conexoes de
 * projeto, e um statement preparado numa conexao fechada estoura na chamada
 * seguinte; comparar a identidade da conexao refaz os statements sozinho, sem
 * depender de alguem lembrar de limpar este cache.
 */
const _tileStmts = new Map();

/**
 * Arquivos cuja conexao ja rotacionou, e por isso passou a ser NOSSA.
 * Ver `abrirConexao` para o motivo de nao voltar ao getProjectDb.
 */
const _rotacionados = new Set();

/**
 * Prazo entre duas conferencias de mtime do MESMO arquivo, em milissegundos.
 *
 * UM SEGUNDO, e nao zero, porque o stat custava mais que o dado. Ver o bloco em
 * `tileStmts` para a medida. E nao e maior porque a janela de tile velho depois
 * de uma troca de arquivo precisa caber no tempo em que ninguem repara.
 * @constant {number}
 */
const MS_ENTRE_CONFERENCIAS = 1000;

/**
 * Deriva o nome do banco de tiles a partir do banco de imagens do projeto.
 * "museu_cms.db" vira "museu_cms_tiles.db".
 * @param {string} projectDbFilename - Nome do arquivo em projects.db_filename
 * @returns {string} Nome do arquivo de tiles do mesmo projeto
 */
export function tilesDbFilenameFor(projectDbFilename) {
  return projectDbFilename.replace(/\.db$/, '_tiles.db');
}

/**
 * Abre a conexao de leitura do banco de tiles.
 *
 * NA PRIMEIRA VEZ a conexao vem do getProjectDb, e nao daqui, porque quem a abre
 * tambem tem de fecha-la: closeAll() percorre o cache de connection.js, e no
 * Windows um handle aberto ainda segura o arquivo, entao uma conexao orfa impede
 * ate apagar o diretorio (medido: rmSync devolve EPERM). Os testes apagam o
 * dataDir logo depois de closeAll().
 *
 * DEPOIS DE UMA ROTACAO a conexao e nossa. O cache de connection.js e privado e
 * nao tem despejo por arquivo, entao nao ha como pedir a ele uma conexao nova
 * para o mesmo nome. Quem abre passa a ser este modulo, e resetTileStatements()
 * fecha o que abrimos.
 *
 * @param {string} dbFilename - Nome do arquivo de tiles
 * @param {string} caminho - Caminho absoluto do arquivo
 * @returns {{db: object, propria: boolean}|null} Conexao, ou null se nao abrir
 */
function abrirConexao(dbFilename, caminho) {
  if (!_rotacionados.has(dbFilename)) {
    const db = getProjectDb(dbFilename);
    return db ? { db, propria: false } : null;
  }

  const db = new Database(caminho, { readonly: true });
  // Os mesmos pragmas de getProjectDb: a rotacao nao pode servir mais devagar
  // que a primeira abertura.
  db.pragma('query_only = true');
  db.pragma('cache_size = -2000');
  db.pragma('busy_timeout = 5000');
  db.pragma(`mmap_size = ${mmapPara(caminho)}`);
  return { db, propria: true };
}

/**
 * Devolve os statements do banco de tiles, ou null se o projeto nao tiver um.
 *
 * A CADA ACESSO conferimos mtime e tamanho do arquivo. O motivo e o `--force` do
 * gerador com o servico no ar: se a geracao TROCA o arquivo (grava ao lado e
 * substitui), a conexao viva continua presa ao arquivo antigo e o servico serve
 * tiles velhos com ETag velho, sob um immutable de um ano. A conferencia custa
 * um statSync por request, que o cache de metadado do sistema operacional serve
 * sem tocar no disco.
 *
 * O QUE ESTA CONFERENCIA NAO COBRE, medido: regeracao no PROPRIO arquivo nao
 * mexe no mtime do .db (o WAL absorve a escrita) e nao precisa, porque cada
 * statement roda numa transacao de leitura nova e ja enxerga o dado novo.
 *
 * O tamanho entra junto do mtime porque a granularidade do mtime chega a um
 * segundo em alguns sistemas de arquivos, e uma troca dentro do mesmo segundo
 * passaria batida.
 *
 * @param {string} dbFilename - Nome do arquivo de tiles ("museu_cms_tiles.db")
 * @returns {{pyramid: object, tile: object}|null}
 */
function tileStmts(dbFilename) {
  const caminho = join(config.projectsDbDir, dbFilename);

  // O STAT TEM PRAZO, e o prazo nasceu de uma medida. A conferencia rodava a
  // CADA acesso, e a rota chama este modulo duas vezes por tile: uma em
  // getTilePyramid e outra em getTileBlob. Medido nesta maquina, no banco de
  // 1124 MiB: o statSync custa 13,45 us e o seek do tile custa 18,99 us, entao
  // o par cobrava 142% do proprio dado. Numa rajada de 54 tiles isso da 1,45 ms
  // de stat contra 0,38 ms de leitura de verdade.
  //
  // O PRAZO NAO AFROUXA O CONTRATO. A conferencia existe para pegar a TROCA do
  // arquivo pelo gerador com o servico no ar (grava ao lado e substitui), e o
  // custo de perder essa troca por ate um segundo e um segundo de tile velho,
  // servido com ETag velho. A regeracao no PROPRIO arquivo continua coberta de
  // graca, porque cada statement roda em transacao de leitura nova.
  const cache = _tileStmts.get(dbFilename);
  const agora = Date.now();
  if (cache && cache.db.open && agora - cache.conferidoEm < MS_ENTRE_CONFERENCIAS) {
    return cache;
  }

  // Projeto sem piramide gerada nao tem arquivo. Este e o caminho normal para
  // quem ainda nao recebeu a piramide: o cliente que leva 404 desenha o full.
  const info = statSync(caminho, { throwIfNoEntry: false });
  if (!info) {
    descartar(dbFilename);
    return null;
  }

  if (cache && cache.db.open && cache.mtimeMs === info.mtimeMs && cache.size === info.size) {
    // O arquivo e o mesmo: renova o prazo em vez de refazer os statements.
    cache.conferidoEm = agora;
    return cache;
  }
  if (cache) {
    // Arquivo trocado: daqui para a frente a conexao e nossa.
    _rotacionados.add(dbFilename);
    descartar(dbFilename);
  }

  const aberta = abrirConexao(dbFilename, caminho);
  if (!aberta) return null;

  try {
    // BANCO ANTERIOR A COLUNA `razao`. Quem faz o ALTER TABLE e o gerador, que
    // abre o arquivo para escrita; ESTE modulo abre readonly com query_only, e
    // um ALTER daqui estouraria. Sem a coluna, o SELECT com `razao` daria "no
    // such column", o catch abaixo trataria o arquivo como projeto sem piramide,
    // e um acervo ja gerado pararia de servir por causa de uma coluna nova.
    //
    // Entao o proprio SELECT devolve RAZAO_PADRAO como literal. Nao e um chute:
    // toda piramide gravada antes desta coluna saiu da escada classica, que e
    // exatamente RAZAO_PADRAO.
    const temRazao = aberta.db
      .pragma('table_info(tile_pyramids)')
      .some(c => c.name === 'razao');
    const colunaRazao = temRazao ? 'razao' : `${RAZAO_PADRAO} AS razao`;

    const entry = {
      db: aberta.db,
      propria: aberta.propria,
      mtimeMs: info.mtimeMs,
      size: info.size,
      conferidoEm: agora,
      pyramid: aberta.db.prepare(`
        SELECT photo_id, tile_size, max_level, width, height,
               quality, tile_count, total_bytes, built_at, ${colunaRazao}
        FROM tile_pyramids
        WHERE photo_id = ?
      `),
      tile: aberta.db.prepare(`
        SELECT webp
        FROM tiles
        WHERE photo_id = ? AND level = ? AND x = ? AND y = ?
      `),
    };
    _tileStmts.set(dbFilename, entry);
    return entry;
  } catch {
    // Arquivo presente mas sem as tabelas (geracao interrompida, arquivo vazio).
    // Tratamos como "projeto sem piramide" em vez de deixar o erro subir: um
    // banco de tiles pela metade nao pode derrubar a rota de imagem do projeto.
    // A conexao propria fecha aqui mesmo, senao o handle vazaria a cada request.
    if (aberta.propria) aberta.db.close();
    return null;
  }
}

/**
 * Tira um arquivo do cache, fechando so a conexao que ABRIMOS.
 *
 * A conexao vinda do getProjectDb fica de pe de proposito: ela ainda mora no
 * cache de connection.js, e fecha-la ali deixaria um handle fechado no lugar,
 * que estoura na proxima chamada de quem pedir o mesmo arquivo. Quem a fecha e
 * closeAll().
 *
 * @param {string} dbFilename - Nome do arquivo de tiles
 */
function descartar(dbFilename) {
  const cache = _tileStmts.get(dbFilename);
  if (!cache) return;
  if (cache.propria && cache.db.open) cache.db.close();
  _tileStmts.delete(dbFilename);
}

/**
 * Le a descricao da piramide de uma foto.
 *
 * O campo `razao` vem SEMPRE preenchido, mesmo num banco que ainda nao recebeu
 * a coluna: ver `tileStmts`. Quem monta a escada nao precisa testar ausencia.
 *
 * @param {string} dbFilename - Nome do arquivo de tiles
 * @param {string} photoId - UUID da foto
 * @returns {object|null} Linha de tile_pyramids, ou null se nao houver
 */
export function getTilePyramid(dbFilename, photoId) {
  const stmts = tileStmts(dbFilename);
  if (!stmts) return null;
  return stmts.pyramid.get(photoId) ?? null;
}

/**
 * Le o BLOB WebP de um tile.
 *
 * Os quatro campos formam a PRIMARY KEY da tabela, entao a busca e um seek na
 * btree. Cabe ao chamador validar a faixa antes: ausencia aqui e 404, e nao 400.
 *
 * @param {string} dbFilename - Nome do arquivo de tiles
 * @param {string} photoId - UUID da foto
 * @param {number} level - Nivel da piramide (0 e o mais grosso)
 * @param {number} x - Coluna, origem na esquerda
 * @param {number} y - Linha, origem no topo
 * @returns {Buffer|null} Bytes do tile, ou null se nao existir
 */
export function getTileBlob(dbFilename, photoId, level, x, y) {
  const stmts = tileStmts(dbFilename);
  if (!stmts) return null;
  const row = stmts.tile.get(photoId, level, x, y);
  return row ? row.webp : null;
}

/**
 * Descarta os statements cacheados e fecha as conexoes que este modulo abriu.
 *
 * Chamado no desligamento, ao lado de closeAll(). As duas chamadas se completam:
 * closeAll() fecha o que connection.js abriu, e esta fecha o que a rotacao de
 * arquivo abriu aqui.
 */
export function resetTileStatements() {
  for (const dbFilename of Array.from(_tileStmts.keys())) {
    descartar(dbFilename);
  }
  _tileStmts.clear();
  // _rotacionados NAO se limpa. Um arquivo que ja trocou uma vez continua sendo
  // nosso: voltar ao getProjectDb devolveria a conexao presa ao arquivo antigo,
  // que e exatamente o defeito que a rotacao conserta.
}
