/**
 * @module server
 * @description Fastify server for the Street View 360 service.
 * Serves photo metadata and images from SQLite databases.
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import config from './config.js';
import { getIndexDb, closeAll } from './db/connection.js';
import healthRoutes from './routes/health.js';
import projectRoutes from './routes/projects.js';
import photoRoutes from './routes/photos.js';
import calibrationRoutes from './routes/calibration.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

const fastify = Fastify({
  logger: {
    level: config.logLevel,
  },
});

// CORS
await fastify.register(cors, { origin: config.corsOrigin });

// Static files — calibration interface
await fastify.register(fastifyStatic, {
  root: resolve(__dirname, '..', 'public', 'calibration'),
  prefix: '/calibration/',
  decorateReply: false,
});

// Static files — project thumbnails ({slug}.webp in /data/thumbnails/)
await fastify.register(fastifyStatic, {
  root: config.thumbnailsDir,
  prefix: '/api/v1/thumbnails/',
  decorateReply: false,
});

// Initialize database on startup
getIndexDb();

// Routes
await fastify.register(healthRoutes);
await fastify.register(projectRoutes);
await fastify.register(photoRoutes);
await fastify.register(calibrationRoutes);

// Graceful shutdown
const shutdown = async () => {
  fastify.log.info('Shutting down...');
  await fastify.close();
  closeAll();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', (err) => {
  fastify.log.error(err, 'Uncaught exception');
  closeAll();
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  fastify.log.error(err, 'Unhandled rejection');
  closeAll();
  process.exit(1);
});

// Start
try {
  await fastify.listen({ port: config.port, host: config.host });
  fastify.log.info(`Street View service listening on ${config.host}:${config.port}`);
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
