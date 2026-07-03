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
import fastifyCompress from '@fastify/compress';
import config from './config.js';
import { getIndexDb, closeAll } from './db/connection.js';
import healthRoutes from './routes/health.js';
import projectRoutes from './routes/projects.js';
import photoRoutes from './routes/photos.js';
import calibrationRoutes from './routes/calibration.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

// Limite de corpo de requisição: payloads de calibração são pequenos
// (poucos números/booleans), então 16 KB é folgado e endurece contra abuso.
const BODY_LIMIT_BYTES = 16 * 1024;

const fastify = Fastify({
  logger: {
    level: config.logLevel,
  },
  bodyLimit: BODY_LIMIT_BYTES,
});

// Error handler global — padroniza o envelope { error: "..." } do contrato da API.
// Erros de validação/runtime caem aqui e são normalizados para { error }.
fastify.setErrorHandler((err, request, reply) => {
  const statusCode = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
  if (statusCode >= 500) {
    request.log.error(err);
    // Não vaza detalhes internos no corpo de erros 500.
    return reply.code(statusCode).send({ error: 'Internal Server Error' });
  }
  request.log.warn(err);
  return reply.code(statusCode).send({ error: err.message });
});

// 404 uniforme — rotas inexistentes também retornam { error }.
fastify.setNotFoundHandler((request, reply) => {
  reply.code(404).send({ error: 'Not Found' });
});

// Compressão HTTP — apenas para respostas compressíveis (text/*, application/json).
// Imagens WebP (image/webp) NÃO são recomprimidas: o customTypes restringe os
// content-types elegíveis para compressão, deixando image/* de fora. O regex
// casa com o content-type completo (inclui parâmetros como "; charset=utf-8").
await fastify.register(fastifyCompress, {
  global: true,
  customTypes: /^(?:text\/|application\/(?:json|javascript|xml|.*\+json|.*\+xml))/,
});

// CORS
await fastify.register(cors, { origin: config.corsOrigin });

// Static files — calibration interface
// prefix sem barra final + redirect: true faz o @fastify/static registrar um
// redirect 301 de /calibration para /calibration/ (senão cai no 404 handler).
await fastify.register(fastifyStatic, {
  root: resolve(__dirname, '..', 'public', 'calibration'),
  prefix: '/calibration',
  decorateReply: false,
  redirect: true,
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

// Graceful shutdown — idempotente e com timeout de segurança.
// Tempo máximo (ms) para fastify.close() antes de forçar a saída.
const SHUTDOWN_TIMEOUT_MS = 10000;
let isShuttingDown = false;

const shutdown = async (exitCode = 0) => {
  // Guarda de reentrância: ignora sinais/erros subsequentes durante o shutdown.
  if (isShuttingDown) return;
  isShuttingDown = true;

  fastify.log.info('Shutting down...');

  // Timeout de segurança: se fastify.close() pendurar (stream de imagem em voo,
  // conexões keep-alive), força a saída em vez de depender do grace do orquestrador.
  const forceExit = setTimeout(() => {
    fastify.log.error('Shutdown timeout exceeded, forcing exit');
    closeAll();
    process.exit(exitCode || 1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();

  try {
    await fastify.close();
  } catch (err) {
    fastify.log.error(err, 'Error closing server');
  } finally {
    clearTimeout(forceExit);
    closeAll();
    process.exit(exitCode);
  }
};

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('uncaughtException', (err) => {
  fastify.log.error(err, 'Uncaught exception');
  // Fecha o servidor e drena via shutdown (que já tem timeout de segurança),
  // em vez de cortar sockets em voo abruptamente.
  shutdown(1);
});
process.on('unhandledRejection', (reason) => {
  // Normaliza reason para Error antes de logar (rejeições podem não ser Error).
  const err = reason instanceof Error ? reason : new Error(String(reason));
  fastify.log.error(err, 'Unhandled rejection');
  shutdown(1);
});

// Start
try {
  await fastify.listen({ port: config.port, host: config.host });
  fastify.log.info(`Street View service listening on ${config.host}:${config.port}`);
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
