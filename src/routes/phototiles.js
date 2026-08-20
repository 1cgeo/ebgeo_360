/**
 * @module routes/phototiles
 * @description Piramide de tiles de uma panoramica: o descritor e o tile.
 *
 * POR QUE ESTA ROTA EXISTE. Hoje o visualizador baixa a panoramica inteira em um
 * unico WebP (p50 534 KB, p90 1136 KB, max 4027 KB). Atras do nginx com HTTP/2,
 * medido em producao, 24 objetos de 11 a 21 KB em paralelo chegam em 43 ms,
 * enquanto um full de 2,51 MB leva 375 ms. Servir o pedaco que esta na tela
 * troca uma transferencia grande por uma rajada de pequenas.
 *
 * O QUE ESTE MODULO NAO FAZ. Nao substitui /photos/:uuid/image. Projeto sem
 * piramide gerada responde 404 aqui e continua servindo o full normalmente, que
 * e o estado de 28 dos 29 projetos enquanto o piloto cobre so o museu_cms.
 *
 * CONVENCOES DA NUMERACAO (o cliente depende delas):
 *   - `level` 0 e o MAIS GROSSO, e maxLevel e a resolucao nativa.
 *   - a escada divide a largura pela RAZAO GRAVADA enquanto ela passar de 2048.
 *     A razao nao e mais fixa em 2: com 2 a escada de 7680 da 1920/3840/7680, e
 *     a largura util das telas cai entre 4264 e 6119, ou seja dentro do vao. O
 *     descritor publica a razao para a escada poder ser reproduzida fora daqui.
 *   - origem no canto superior esquerdo da equirretangular. Nunca TMS.
 *   - a borda e RECORTADA: a ultima coluna e a ultima linha podem medir menos
 *     que tile_size, e o cliente toma a largura do proprio bitmap.
 *   - a URL do tile leva `?v=<total_bytes>`, o token de geracao. Ele existe
 *     porque o tile e servido com `immutable` de um ano: sem o token, regerar a
 *     piramide mudava a escada e nao mudava a URL. Ver o `template` abaixo.
 *
 * A GEOMETRIA NAO SE CALCULA AQUI. Ela sai de pyramid-math.js, o mesmo modulo do
 * gerador e do cliente. Ver montarEscada para o porque.
 */

import { escadaGravada } from '../../public/calibration/js/pyramid-math.js';
import {
  getPhotoById,
  getProjectByPhotoId,
  isPhotoDeleted,
} from '../db/queries.js';
import {
  getTilePyramid,
  getTileBlob,
  tilesDbFilenameFor,
} from '../db/tiles-queries.js';
import {
  setImageCacheHeaders,
  setMutableMetadataCacheHeaders,
  computeImageETag,
  computeMetadataETag,
} from '../middleware/cache.js';

/**
 * Versao do formato do descritor. Sobe quando um campo muda de significado, para
 * o cliente antigo poder recusar em vez de desenhar errado.
 * @constant {number}
 */
const SCHEMA_VERSION = 1;

/**
 * Nivel mais grosso servido. Fixo em 0 por definicao da numeracao.
 * @constant {number}
 */
const MIN_LEVEL = 0;

/**
 * Teto de tiles em voo, do contrato de tiles 360.
 *
 * O NUMERO E OUTRO, e nao o 8 de /image, porque a carga e outra. La cada request
 * materializa um full de 1 a 5 MB, e algumas dezenas deles ameacam o teto de
 * 512 MB do container. Aqui o tile pesa dezenas de KB (medido: ~20 KB), entao 64
 * em voo somam ~4 MB, folgado. O limite existe assim mesmo: sem teto, uma rajada
 * de robo abre buffers sem limite nenhum.
 *
 * 64 tambem e o numero que NAO enfileira a rajada normal do cliente, de 24 tiles
 * no frustum. Um semaforo de 8 aqui serializaria essa rajada em tres ondas, e
 * seria dano ativo justo no que o piloto quer medir.
 * @constant {number}
 */
const MAX_INFLIGHT_TILE_REQUESTS = 64;

let _inflightTiles = 0;
const _tileWaitQueue = [];

/**
 * Adquire uma vaga no limitador de concorrencia de tiles.
 * Resolve na hora se houver vaga; caso contrario, enfileira.
 * @returns {Promise<void>}
 */
function acquireTileSlot() {
  if (_inflightTiles < MAX_INFLIGHT_TILE_REQUESTS) {
    _inflightTiles++;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    _tileWaitQueue.push(resolve);
  });
}

/**
 * Libera uma vaga do limitador, promovendo o proximo da fila se houver.
 */
function releaseTileSlot() {
  const next = _tileWaitQueue.shift();
  if (next) {
    // Mantem _inflightTiles constante: a vaga passa direto ao proximo.
    next();
  } else {
    _inflightTiles--;
  }
}

/**
 * Converte um segmento de URL em inteiro nao negativo.
 *
 * O teste e sobre o TEXTO, e nao sobre o Number. `Number('')` da 0, e sem este
 * cuidado um pedido terminado em "/.webp" serviria calado o tile 0.
 *
 * @param {string} texto - Segmento cru da URL
 * @returns {number|null} O inteiro, ou null se o texto nao for um
 */
function inteiroNaoNegativo(texto) {
  return /^\d+$/.test(String(texto)) ? Number(texto) : null;
}

/**
 * Escada de niveis de uma piramide gravada.
 *
 * A CONTA NAO MORA AQUI. A rota tinha a sua propria, `width / 2**(max-level)`,
 * que so coincide com as metades sucessivas do gerador quando nao ha
 * arredondamento: em 8194 de largura o nativo daria 1024x512 (2x1 tiles) contra
 * os 1025x513 (3x2) realmente gravados, e o descritor prometeria uma grade
 * inexistente enquanto o cliente levava 400 num tile que existe.
 *
 * `cols`/`rows` saem por `ceil` la dentro, o que produz a borda recortada: em
 * 7680x3840 o nivel 2 tem 15 colunas e 8 linhas, e a ultima linha mede 256 px.
 *
 * A RAZAO VEM DO BANCO, e nao do padrao do modulo. Ela e o quarto termo que
 * determina a grade: reconstruir com 2 uma piramide gravada com 1,6 devolveria
 * outra lista de niveis, e o cliente pediria tile que nunca foi gravado. Como o
 * defeito seria tile faltando e nao erro, o valor tem de vir da linha.
 *
 * @param {object} piramide - Linha de tile_pyramids
 * @returns {Array<{level:number,width:number,height:number,cols:number,rows:number}>}
 */
function escadaDaPiramide(piramide) {
  // Pelo `max_level` GRAVADO, e nao pela regra de parada de hoje. Ver
  // `escadaGravada` em pyramid-math.js: recalcular pela regra corrente
  // reinterpreta em silencio todo acervo escrito sob a regra anterior, e ja
  // custou 98.854 fotos servindo descritor que mentia.
  return escadaGravada(
    piramide.width, piramide.height, piramide.tile_size, piramide.razao, piramide.max_level,
  );
}

export default async function photoTileRoutes(fastify) {
  // GET /api/v1/photos/:uuid/tiles.json: o descritor da piramide
  //
  // ROTA PROPRIA, e nao um campo em /photos/:uuid. Aquela resposta e no-cache
  // com ETag da calibracao: cada edicao de angulo reenviaria a piramide junto.
  // O round-trip a mais nao custa latencia porque o cliente dispara os dois em
  // paralelo, e o preview ja desenha sem esperar por este documento.
  fastify.get('/api/v1/photos/:uuid/tiles.json', async (request, reply) => {
    const { uuid } = request.params;

    const photo = getPhotoById(uuid);
    if (!photo || isPhotoDeleted(uuid)) {
      reply.code(404);
      return { error: 'Photo not found' };
    }

    const project = getProjectByPhotoId(uuid);
    if (!project) {
      reply.code(404);
      return { error: 'Photo not found' };
    }

    // Projeto sem banco de tiles cai aqui, e o 404 e a resposta CERTA, nao uma
    // falha: o cliente que recebe 404 desenha o full de sempre.
    const piramide = getTilePyramid(tilesDbFilenameFor(project.db_filename), uuid);
    if (!piramide) {
      reply.code(404);
      return { error: 'Tile not found' };
    }

    // A assinatura cobre tudo que muda a escada ou os bytes: reconstruir a
    // piramide com outro quality troca o validador e o cliente rebusca.
    //
    // `razao` fica de FORA da lista, e nao por esquecimento. Ela so muda por uma
    // regeracao, e o gerador grava razao e built_at na MESMA linha da mesma
    // transacao: nao ha caminho que troque a escada sem mover o built_at que ja
    // esta aqui. Repetir a razao na assinatura nao acrescentaria deteccao.
    const signature = [
      piramide.photo_id, piramide.width, piramide.height, piramide.tile_size,
      piramide.max_level, piramide.quality, piramide.total_bytes, piramide.built_at,
    ].join('|');
    const etag = computeMetadataETag(signature);

    const ifNoneMatch = request.headers['if-none-match'];
    if (ifNoneMatch && ifNoneMatch.replace(/"/g, '') === etag) {
      setMutableMetadataCacheHeaders(reply, etag);
      reply.code(304);
      return;
    }

    // no-cache com validador, nunca immutable: uma reconstrucao muda a escada, e
    // com immutable o cliente passaria um ano pedindo um nivel que morreu.
    setMutableMetadataCacheHeaders(reply, etag);

    // A escada manda no que o descritor publica, INCLUSIVE no maxLevel. Publicar
    // o max_level gravado ao lado de uma escada calculada reabriria a divergencia
    // que pyramid-math.js fechou: os dois numeros tem de sair da mesma conta.
    const levels = escadaDaPiramide(piramide);
    const maxLevel = levels[levels.length - 1].level;

    return {
      schemaVersion: SCHEMA_VERSION,
      photoId: piramide.photo_id,
      projectSlug: project.slug,
      // A extensao do template, e nao o MIME: o MIME esta no cabecalho do tile.
      format: 'webp',
      encoder: { quality: piramide.quality },
      tileSize: piramide.tile_size,
      // A razao anda COLADA no tileSize porque os dois, com width e height,
      // determinam a grade inteira. O cliente daqui nao precisa dela: ele le a
      // lista `levels` pronta. Ela existe porque o descritor e a unidade
      // portavel que o sv360 copia, e escada sem razao nao se reproduz.
      razao: piramide.razao,
      width: piramide.width,
      height: piramide.height,
      origin: 'top-left',
      edge: 'crop',
      // A equirretangular fecha em 360 graus, entao QUEM repete a coluna e o
      // cliente. O servidor recusa x >= cols, senao os mesmos pixels teriam duas
      // URLs e o cache guardaria cada tile duas vezes.
      wrapX: true,
      minLevel: MIN_LEVEL,
      maxLevel,
      // Os dois resolvem RELATIVO a URL deste documento, que termina em
      // "tiles.json" e sai na resolucao. URL absoluta esta proibida: atras do
      // `location /ebgeo_360/` o servico nao enxerga o prefixo publico e
      // publicaria um caminho que da 404 do lado de fora.
      base: 'image?quality=preview',
      // O TOKEN DE GERACAO VAI NA URL, e nao so no ETag. O tile sai com
      // `immutable` de um ano (middleware/cache.js), entao o navegador que ja
      // visitou a foto nao pergunta mais nada ao servidor. Regerar a piramide
      // com outra razao troca a ESCADA inteira e nao mudava um caractere de
      // "tiles/{level}/{x}/{y}.webp": o cliente compunha tiles da escada velha
      // dentro da grade nova, sem um erro no console. Nao e hipotese: o
      // museu_cms saiu com razao 2 e foi regerado com 1,6.
      //
      // O TOKEN E `total_bytes`, o MESMO que ja valida o ETag do tile. Um token
      // so mantem URL e validador sempre de acordo: a regeracao que muda bytes
      // move os dois juntos, e a que devolve bytes identicos segura os dois, em
      // vez de mandar o acervo inteiro descer de novo. Ele nao e mais fraco que
      // o ETag de hoje, porque e o mesmo numero.
      //
      // `built_at` FOI DESCARTADO. Ele muda a cada rodada mesmo quando os tiles
      // saem iguais, o que joga fora o cache de graca, e o ISO do gerador leva
      // ':' e '.' para dentro da query. `total_bytes` e INTEGER NOT NULL, entao
      // ele entra na URL como digito puro, sem escape nenhum.
      template: `tiles/{level}/{x}/{y}.webp?v=${piramide.total_bytes}`,
      // Redundante de proposito. Sem esta lista o cliente repetiria o ceil, e um
      // arredondamento divergente viraria tile faltando em vez de erro visivel.
      levels,
    };
  });

  // GET /api/v1/photos/:uuid/tiles/:level/:x/:y: um tile da piramide
  //
  // COM SEMAFORO PROPRIO, de 64 (ver MAX_INFLIGHT_TILE_REQUESTS), e nao com o de
  // 8 da rota de imagem. A vaga cobre o BLOB: pega-se antes de ler e solta-se
  // quando a resposta fecha, que e o tempo em que o buffer vive no heap.
  //
  // SEM Accept-Ranges e sem 206, pela razao de tamanho: Range serve para retomar
  // um download de megabytes, nao para um objeto que cabe em um pacote.
  //
  // O `?v=` DO TEMPLATE CHEGA AQUI, e esta rota o IGNORA de proposito. Ele nao e
  // um parametro: e o token de geracao que separa a URL do tile velho da do
  // novo, e quem o consome e o CACHE, nunca o handler. Por isso a rota segue sem
  // schema de query. Um `querystring` no schema faria o Fastify validar contra
  // ele, e `additionalProperties: false` responderia 400 no tile inteiro por
  // causa do proprio token que o descritor publicou. Sem schema o Fastify so
  // decodifica a query em request.query e passa adiante.
  //
  // E NAO SE COMPARA o token com a piramide de agora. No instante da regeracao o
  // cliente ainda segura o descritor velho: recusar o token velho pintaria a
  // parede de buraco em vez de servir o tile bom. A resposta certa e sempre o
  // tile de hoje, com o ETag de hoje.
  fastify.get('/api/v1/photos/:uuid/tiles/:level/:x/:y', async (request, reply) => {
    const { uuid } = request.params;

    // A sintaxe do pedido se valida antes de tocar no banco. O ".webp" vem
    // colado no ultimo segmento, como o ".pbf" em tiles.js.
    const level = inteiroNaoNegativo(request.params.level);
    const x = inteiroNaoNegativo(request.params.x);
    const y = inteiroNaoNegativo(String(request.params.y).replace(/\.webp$/, ''));
    if (level === null || x === null || y === null) {
      reply.code(400);
      return { error: 'Tile out of range' };
    }

    const photo = getPhotoById(uuid);
    if (!photo || isPhotoDeleted(uuid)) {
      reply.code(404);
      return { error: 'Photo not found' };
    }

    const project = getProjectByPhotoId(uuid);
    if (!project) {
      reply.code(404);
      return { error: 'Photo not found' };
    }

    const dbFilename = tilesDbFilenameFor(project.db_filename);
    const piramide = getTilePyramid(dbFilename, uuid);
    if (!piramide) {
      reply.code(404);
      return { error: 'Tile not found' };
    }

    // Fora da grade e 400, nao 404: o pedido esta errado, e responder "nao
    // achei" convidaria o cliente a tentar de novo com a mesma coordenada. A
    // faixa valida sai da MESMA escada que o descritor publicou, entao o que o
    // cliente leu la nunca vira 400 aqui.
    const grade = escadaDaPiramide(piramide)[level] ?? null;
    if (!grade || x >= grade.cols || y >= grade.rows) {
      reply.code(400);
      return { error: 'Tile out of range' };
    }

    // O token de geracao e total_bytes da piramide, e nao o tamanho do full:
    // reconstruir os tiles com outro quality nao muda o full, e o immutable de
    // um ano misturaria tile velho e novo DENTRO da mesma panoramica.
    const etag = computeImageETag(uuid, `t${level}-${x}-${y}`, piramide.total_bytes);

    // O 304 curto-circuita antes de ler o BLOB. A linha de tile_pyramids ja
    // esta em maos e custa um seek; o que se evita aqui e o tile.
    const ifNoneMatch = request.headers['if-none-match'];
    if (ifNoneMatch && ifNoneMatch.replace(/"/g, '') === etag) {
      setImageCacheHeaders(reply, etag);
      reply.code(304);
      return;
    }

    // So aqui a vaga do semaforo: o caminho do 304 acima nao carrega BLOB nenhum
    // e enfileira-lo seria custo sem contrapartida.
    await acquireTileSlot();
    let liberada = false;
    const liberarVaga = () => {
      if (liberada) return;
      liberada = true;
      releaseTileSlot();
    };

    let tile;
    try {
      tile = getTileBlob(dbFilename, uuid, level, x, y);
    } catch (err) {
      liberarVaga();
      throw err;
    }
    if (!tile) {
      // Coordenada dentro da grade mas sem linha na tabela: piramide incompleta.
      liberarVaga();
      reply.code(404);
      return { error: 'Tile not found' };
    }

    setImageCacheHeaders(reply, etag);
    reply.header('Content-Type', 'image/webp');
    reply.header('Content-Length', tile.length);

    // A vaga so volta quando a resposta FECHA, e nao aqui: o buffer vive ate o
    // ultimo byte sair, e soltar antes faria o teto de 64 medir o que nao e.
    // 'close' fecha os dois casos, o envio completo e o cliente que desistiu.
    reply.raw.on('close', liberarVaga);
    reply.raw.on('error', liberarVaga);
    // Cliente que desistiu ANTES desta linha ja emitiu o 'close', e um listener
    // atrasado nunca dispara: sem esta guarda a vaga sumiria para sempre, e o
    // teto de 64 iria minguando a cada aborto.
    if (reply.raw.destroyed) liberarVaga();
    return reply.send(tile);
  });
}
