/**
 * @module routes/health
 * @description Health check endpoint.
 */

import { getProjectCount } from '../db/queries.js';

export default async function healthRoutes(fastify) {
  fastify.get('/health', async (_request, reply) => {
    try {
      // Usa o prepared statement cacheado de queries.js em vez de re-preparar
      // o COUNT(*) a cada probe (mantem o padrao "prepare once").
      const projects = getProjectCount();
      return {
        status: 'ok',
        projects,
      };
    } catch (err) {
      reply.code(503);
      return { status: 'error', message: err.message };
    }
  });
}
