/**
 * @module routes/tiles
 * @description Camadas de mapa do acervo: tiles vetoriais de ponto e o tracado.
 *
 * POR QUE ESTE MODULO EXISTE. Ate aqui o mapa do EBGeo lia dois arquivos
 * PMTiles servidos pelo Martin, e o ebgeo_360 servia so metadado e imagem. Isso
 * partia a verdade em dois: o `index.db` mudava a cada calibracao, e o mapa so
 * enxergava a mudanca depois de alguem rodar o tippecanoe e redeployar 11 MB.
 * Servindo daqui, a camada e o banco, sem passo intermediario e sem defasagem.
 *
 * PONTOS SAO TILE, LINHAS SAO GEOJSON, e a razao e medida, nao estetica:
 *   - as 99.040 fotos dao 35,7 MB de GeoJSON (5,9 MB comprimido), grande demais
 *     para uma resposta so;
 *   - os 3.236 tracados dao 1,9 MB (0,3 MB comprimido), MENOS que os 712 KB do
 *     fotos_linha.pmtiles, e ainda por cima sem a perda da simplificacao.
 *
 * SEM INDICE EM MEMORIA. A forma obvia seria montar um indice geojson-vt do
 * acervo inteiro no arranque. Medi: o indice custa 374,6 MB e leva o RSS a 579
 * MB, acima do teto de 512 MB do container. Aqui cada tile nasce da consulta ao
 * rtree pela bbox dele. O tile mediano sai em 3,2 ms e o pior (5.846 pontos, em
 * Uruguaiana) em 37,7 ms.
 */

import geojsonvt from 'geojson-vt';
import vtpbf from 'vt-pbf';
import { getPhotosInBbox, getAllTracks, getBboxDoAcervo } from '../db/queries.js';
import {
  setMetadataCacheHeaders,
  setMutableMetadataCacheHeaders,
  computeMetadataETag,
} from '../middleware/cache.js';

/**
 * Nome da camada dentro do tile vetorial.
 *
 * TEM de continuar sendo 'fotos': e o valor de `pointsSourceLayer` no cliente e
 * o `source-layer` de toda camada do minimapa. Renomear aqui apaga os pontos do
 * mapa sem erro nenhum no console.
 * @constant {string}
 */
const CAMADA = 'fotos';

/**
 * Faixa de zoom servida.
 *
 * O TETO segue o `fotos.pmtiles`, que o tippecanoe gerava com zoom maximo 12. O
 * minimapa vai ate 17,9 e sobrepassa a partir dai, exatamente como ja fazia.
 *
 * O PISO e o `minZoom` do minimapa. Abaixo dele o MapLibre nao pede tile nenhum,
 * o que e a defesa contra um pedido em z0 querer as 99.040 fotos num tile so.
 * Quem precisa de foto abaixo de z11 e o mapa principal, ao clicar numa linha, e
 * esse caminho passou a usar /photos/nearest em vez do conteudo do tile.
 * @constant {number}
 */
const ZOOM_MIN = 11;
const ZOOM_MAX = 12;

/**
 * Resolucao interna do tile e folga de borda, ambas em unidades do tile.
 *
 * A folga de 80 e a do tippecanoe (5 pixels de 256), e nao o padrao 64 do
 * geojson-vt: com ela o tile leva os mesmos vizinhos de borda que o PMTiles
 * levava, e um simbolo que cruza a divisa nao pisca ao trocar de tile.
 * @constant {number}
 */
const EXTENSAO = 4096;
const FOLGA = 80;

export default async function tileRoutes(fastify) {
  // GET /api/v1/tiles/fotos.json — TileJSON da camada de pontos
  //
  // O EBGEO NAO LE ESTE DOCUMENTO. Ele declara os tiles direto na fonte do
  // MapLibre (`tiles: [...]` em vez de `url:`), e a razao esta na LIMITACAO
  // abaixo. O TileJSON fica de pe para consumidor externo (QGIS e afins).
  //
  // LIMITACAO: a URL que este documento publica sai da deducao do pedido, e a
  // deducao nao alcanca PREFIXO. Atras de um proxy que monta o servico num
  // caminho (`location /ebgeo_360/ { proxy_pass .../api/v1/; }`), o pedido chega
  // aqui como `/api/v1/tiles/fotos.json`, ja sem o prefixo: esquema e host
  // viajam em cabecalho, o pedaco do caminho nao viaja em lugar nenhum. Entao a
  // URL publicada aponta para a raiz do host e da 404 do lado de fora.
  //
  // Nao ha conserto sem configuracao, porque a informacao que falta nao esta no
  // pedido. Quem consome daqui e esta atras de um proxy assim precisa montar a
  // URL do tile por conta propria, como o EBGeo faz.
  fastify.get('/api/v1/tiles/fotos.json', async (request, reply) => {
    const caixa = getBboxDoAcervo();

    setMetadataCacheHeaders(reply);
    return {
      tilejson: '3.0.0',
      name: CAMADA,
      scheme: 'xyz',
      // URL ABSOLUTA, montada a partir do pedido. O MapLibre resolve URL
      // relativa contra o documento, e nao contra o TileJSON, entao uma relativa
      // aqui quebraria assim que o EBGeo e o 360 ficassem em hosts diferentes.
      tiles: [`${baseDaApi(request)}/api/v1/tiles/fotos/{z}/{x}/{y}.pbf`],
      minzoom: ZOOM_MIN,
      maxzoom: ZOOM_MAX,
      ...(caixa ? { bounds: [caixa.oeste, caixa.sul, caixa.leste, caixa.norte] } : {}),
      vector_layers: [{
        id: CAMADA,
        minzoom: ZOOM_MIN,
        maxzoom: ZOOM_MAX,
        fields: {
          photo_uuid: 'String', nome_img: 'String', display_name: 'String',
          project: 'String', heading: 'Number', ele: 'Number', seq: 'Number',
          floor_level: 'Number', floor_label: 'String',
        },
      }],
    };
  });

  // GET /api/v1/tiles/fotos/:z/:x/:y.pbf — um tile vetorial de pontos
  //
  // A extensao vem no ultimo segmento em vez de virar sufixo de rota: e um
  // parametro so, sem depender de como o roteador trata sufixo estatico.
  fastify.get('/api/v1/tiles/:camada/:z/:x/:y', async (request, reply) => {
    const { camada } = request.params;
    if (camada !== CAMADA) {
      reply.code(404);
      return { error: 'Layer not found' };
    }

    const z = Number(request.params.z);
    const x = Number(request.params.x);
    const y = Number(String(request.params.y).replace(/\.(pbf|mvt)$/, ''));

    // A VALIDACAO E O FREIO, nao um detalhe de higiene: sem o teto de zoom, um
    // pedido em z0 traria as 99.040 fotos para dentro de um unico tile.
    const limite = 2 ** z;
    const valido = Number.isInteger(z) && Number.isInteger(x) && Number.isInteger(y)
      && z >= ZOOM_MIN && z <= ZOOM_MAX
      && x >= 0 && x < limite && y >= 0 && y < limite;
    if (!valido) {
      reply.code(400);
      return { error: `Tile out of range (zoom ${ZOOM_MIN}-${ZOOM_MAX})` };
    }

    const [oeste, sul, leste, norte] = limitesDoTile(z, x, y);
    const folgaLon = ((leste - oeste) * FOLGA) / EXTENSAO;
    const folgaLat = ((norte - sul) * FOLGA) / EXTENSAO;

    const linhas = getPhotosInBbox(
      oeste - folgaLon, leste + folgaLon, sul - folgaLat, norte + folgaLat,
    );

    // 204 e o "tile vazio" que o MapLibre entende. Um 404 aqui encheria o
    // console de erro em todo tile de oceano.
    if (!linhas.length) {
      reply.code(204);
      return null;
    }

    const colecao = {
      type: 'FeatureCollection',
      features: linhas.map(p => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
        properties: {
          // Os dois identificadores, na mesma forma que o PMTiles emitia.
          photo_uuid: p.id,
          nome_img: p.original_name,
          display_name: p.display_name,
          project: p.project_slug,
          heading: p.heading,
          ele: p.ele,
          seq: p.sequence_number,
          // O filtro de andar do minimapa roda sobre este atributo.
          floor_level: p.floor_level,
          floor_label: p.floor_label,
        },
      })),
    };

    // `tolerance: 0` porque ponto nao se simplifica, e `indexMaxPoints: 0` para
    // o geojson-vt nao repartir o tile sozinho: quem manda no recorte e a
    // consulta que ja foi feita pela bbox.
    const tile = geojsonvt(colecao, {
      maxZoom: z, indexMaxZoom: z, indexMaxPoints: 0,
      tolerance: 0, extent: EXTENSAO, buffer: FOLGA,
    }).getTile(z, x, y);

    if (!tile || !tile.features.length) {
      reply.code(204);
      return null;
    }

    // Revalidacao em vez de prazo: a calibracao muda os angulos durante a
    // sessao de revisao, e um tile guardado por uma hora mostraria o rumo velho.
    reply.header('Cache-Control', 'public, no-cache');
    reply.type('application/vnd.mapbox-vector-tile');
    return vtpbf.fromGeojsonVt({ [CAMADA]: tile }, { version: 2, extent: EXTENSAO });
  });

  // GET /api/v1/tracks — todo o tracado do acervo, em GeoJSON
  //
  // Uma resposta so, sem tile: sao 0,3 MB comprimidos. O atributo `origem`
  // repete o do fotos_linha.pmtiles, entao filtro por projeto no cliente segue
  // valendo sem mudanca.
  //
  // COM ETag, e nao so `no-cache`: sem validador, revalidar significa baixar os
  // 0,3 MB inteiros a cada abertura do mapa. O tracado quase nunca muda, entao a
  // resposta honesta e 304. A assinatura sai de duas contagens, sem ler os
  // vertices, e muda se qualquer traco entrar, sair ou for reimportado.
  fastify.get('/api/v1/tracks', async (request, reply) => {
    const tracos = getAllTracks();
    const assinatura = `${tracos.length}|${tracos.reduce((s, t) => s + t.coords.length, 0)}`;
    const etag = computeMetadataETag(assinatura);

    const seNaoCasar = request.headers['if-none-match'];
    if (seNaoCasar && seNaoCasar.replace(/"/g, '') === etag) {
      setMutableMetadataCacheHeaders(reply, etag);
      reply.code(304);
      return null;
    }

    setMutableMetadataCacheHeaders(reply, etag);
    return {
      type: 'FeatureCollection',
      features: tracos.map(t => ({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: t.coords },
        properties: { origem: t.origem },
      })),
    };
  });
}

/**
 * Monta a base publica da API a partir do pedido, honrando o proxy reverso.
 *
 * A PORTA PADRAO SAI FORA, e isso e o conserto de um defeito de producao, nao
 * cosmetica. O nginx da frente repassa `$host:$server_port`, entao o `Host` que
 * chega aqui carrega a porta 80 da escuta INTERNA, enquanto o
 * `x-forwarded-proto` diz https. Juntar os dois emitia
 * `https://ebgeo.1cgeo.eb.mil.br:80/...`: o navegador abria TLS contra a porta
 * 80, o nginx respondia em texto claro e o MapLibre so via
 * "AJAXError: Failed to fetch (0)". Porta 80 e 443 nunca precisam aparecer numa
 * URL publica, entao descarta-las conserta o caso sem depender de adivinhar
 * qual proxy esta na frente. Porta fora do padrao continua na URL, porque ai
 * ela e mesmo a porta publica.
 *
 * @param {Object} request - Fastify request
 * @returns {string} Base sem barra final, ex.: "http://127.0.0.1:8081"
 */
function baseDaApi(request) {
  const esquema = primeiroValor(request.headers['x-forwarded-proto']) || request.protocol;
  const host = primeiroValor(request.headers['x-forwarded-host'])
    || primeiroValor(request.headers.host);
  return `${esquema}://${semPortaPadrao(host)}`;
}

/**
 * Toma o primeiro item de um cabecalho que dois proxies em serie empilharam.
 *
 * `x-forwarded-proto: https, http` significa que o CLIENTE falou https e o
 * salto interno seguinte falou http. Quem vale para montar URL publica e o
 * primeiro.
 * @param {string|undefined} cabecalho - Valor cru do cabecalho
 * @returns {string} Primeiro valor, sem espaco em volta
 */
function primeiroValor(cabecalho) {
  return String(cabecalho || '').split(',')[0].trim();
}

/**
 * Remove a porta 80 ou 443 do host, preservando host IPv6 entre colchetes.
 * @param {string} host - Host, com ou sem porta
 * @returns {string} Host sem a porta padrao
 */
function semPortaPadrao(host) {
  return host.replace(/:(80|443)$/, '');
}

/**
 * Converte um tile XYZ nos seus limites geograficos.
 * @param {number} z - Zoom
 * @param {number} x - Coluna
 * @param {number} y - Linha
 * @returns {[number, number, number, number]} [oeste, sul, leste, norte] em graus
 */
function limitesDoTile(z, x, y) {
  const n = 2 ** z;
  const lon = i => (i / n) * 360 - 180;
  // Inversa da projecao de Mercator: a linha y do tile nao e linear em latitude.
  const lat = j => (Math.atan(Math.sinh(Math.PI * (1 - (2 * j) / n))) * 180) / Math.PI;
  return [lon(x), lat(y + 1), lon(x + 1), lat(y)];
}
