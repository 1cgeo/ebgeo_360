/**
 * @module tests/helpers/build-app
 * @description Builds a Fastify instance with all routes registered for testing.
 * Uses fastify.inject() pattern — no network listener is started.
 *
 * IMPORTANT: process.env.DATA_DIR must be set BEFORE this module is imported,
 * because the import chain triggers config.js → connection.js singleton init.
 */

import Fastify from 'fastify';
import healthRoutes from '../../src/routes/health.js';
import projectRoutes from '../../src/routes/projects.js';
import photoRoutes from '../../src/routes/photos.js';
import calibrationRoutes from '../../src/routes/calibration.js';

/**
 * Creates a Fastify app with all routes registered (no listener).
 * @returns {Promise<import('fastify').FastifyInstance>}
 */
export async function buildApp() {
  const app = Fastify({ logger: false });

  await app.register(healthRoutes);
  await app.register(projectRoutes);
  await app.register(photoRoutes);
  await app.register(calibrationRoutes);

  return app;
}
