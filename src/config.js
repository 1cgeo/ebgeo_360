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

  // Logging
  logLevel: process.env.LOG_LEVEL || 'info',

  // CORS
  corsOrigin: process.env.CORS_ORIGIN || '*',

  // Cache control for immutable images (1 year)
  imageCacheMaxAge: 31536000,
};

export default config;
