/**
 * @module tests/helpers/build-app
 * @description Builds a Fastify instance with all routes registered for testing.
 * Uses fastify.inject() pattern — no network listener is started.
 *
 * IMPORTANT: process.env.STREETVIEW_DATA_DIR must be set BEFORE this module is
 * imported, because the import chain triggers config.js → connection.js
 * singleton init.
 */

import { existsSync } from 'node:fs';
import Fastify from 'fastify';
import healthRoutes from '../../src/routes/health.js';
import projectRoutes from '../../src/routes/projects.js';
import photoRoutes from '../../src/routes/photos.js';
import calibrationRoutes from '../../src/routes/calibration.js';
import tileRoutes from '../../src/routes/tiles.js';

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
  await app.register(tileRoutes);

  // A rota de tiles da panoramica entra por import dinamico e guardado.
  //
  // POR QUE A GUARDA. No piloto o teste chegou ANTES da rota, e um import
  // estatico de um modulo inexistente derruba QUALQUER arquivo de teste que
  // construa o app, e nao so o de tiles. A guarda cobre exclusivamente o arquivo
  // ausente: existindo o modulo, erro de sintaxe ou de registro dentro dele
  // estoura normalmente. O phototiles.test.js confere a existencia do arquivo no
  // before(), entao a falta da rota reprova la, alto e claro.
  const rotaTiles = new URL('../../src/routes/phototiles.js', import.meta.url);
  if (existsSync(rotaTiles)) {
    const { default: photoTileRoutes } = await import(rotaTiles.href);
    await app.register(photoTileRoutes);
  }

  return app;
}
