/**
 * @module config
 * @description Service configuration with environment variable overrides.
 */

import { resolve } from 'node:path';

const config = {
  port: parseInt(process.env.PORT || '8081', 10),
  host: process.env.HOST || '0.0.0.0',

  // Data directory containing index.db and projects/*.db
  dataDir: resolve(process.env.STREETVIEW_DATA_DIR || './data'),

  // Path to the central index database (metadata only)
  get indexDbPath() {
    return resolve(this.dataDir, 'index.db');
  },

  // Directory containing per-project image databases
  get projectsDbDir() {
    return resolve(this.dataDir, 'projects');
  },

  // Directory containing static thumbnails
  get thumbnailsDir() {
    return resolve(this.dataDir, 'thumbnails');
  },

  // Base publica que corresponde ao /api/v1 deste servico, sem barra final.
  //
  // SO O SERVICO PRECISA DISSO, e so quando ele mesmo escreve uma URL: hoje, a
  // dos tiles dentro do TileJSON. Todo o resto do endereco quem escreve e o
  // cliente, que ja conhece o endereco publico.
  //
  // POR QUE NAO DA PARA DEDUZIR. Atras de um proxy que monta o servico num
  // prefixo, o caminho publico morre na reescrita. Com
  // `location /ebgeo_360/ { proxy_pass .../api/v1/; }`, o pedido que chega aqui
  // e `/api/v1/tiles/fotos.json`, e o `/ebgeo_360` nao viaja em cabecalho
  // nenhum. Esquema e host sobrevivem (`x-forwarded-proto`, `Host`), o prefixo
  // nao. Sem esta chave o TileJSON publicava `https://host/api/v1/tiles/...`,
  // que em producao e 404, e o MapLibre trata 404 de tile como tile vazio: o
  // mapa fica sem ponto e o console fica limpo.
  //
  // Vazio deduz do pedido, que e o certo para o desenvolvimento local e para
  // quem publica o servico na raiz.
  // Ex.: PUBLIC_API_BASE_URL=https://ebgeo.1cgeo.eb.mil.br/ebgeo_360
  get publicApiBaseUrl() {
    return (process.env.PUBLIC_API_BASE_URL || '').replace(/\/+$/, '');
  },

  // Logging
  logLevel: process.env.LOG_LEVEL || 'info',

  // CORS
  corsOrigin: process.env.CORS_ORIGIN || '*',

  // Cache control for immutable images (1 year)
  imageCacheMaxAge: 31536000,
};

export default config;
