/**
 * @module routes/health
 * @description Health check endpoint.
 */

import { getIndexDb } from '../db/connection.js';

export default async function healthRoutes(fastify) {
  fastify.get('/health', async (_request, reply) => {
    try {
      const db = getIndexDb();
      const row = db.prepare('SELECT count(*) as cnt FROM projects').get();
      return {
        status: 'ok',
        projects: row.cnt,
      };
    } catch (err) {
      reply.code(503);
      return { status: 'error', message: err.message };
    }
  });
}
