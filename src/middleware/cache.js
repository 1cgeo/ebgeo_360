/**
 * @module middleware/cache
 * @description Cache-Control and ETag middleware for Fastify.
 */

import { createHash } from 'node:crypto';
import config from '../config.js';

/**
 * Sets immutable cache headers for image responses.
 * Images never change once ingested, so we use long-lived cache.
 */
export function setImageCacheHeaders(reply, etag) {
  reply.header('Cache-Control', `public, max-age=${config.imageCacheMaxAge}, immutable`);
  if (etag) {
    reply.header('ETag', `"${etag}"`);
  }
}

/**
 * Sets short-lived cache for metadata responses (projects, by-name lookups).
 */
export function setMetadataCacheHeaders(reply) {
  reply.header('Cache-Control', 'public, max-age=3600');
}

/**
 * Sets revalidation cache for mutable metadata (photo calibration data).
 * Uses no-cache so the browser always revalidates with the server,
 * ensuring calibration changes (hidden targets, overrides) are reflected immediately.
 */
export function setMutableMetadataCacheHeaders(reply) {
  reply.header('Cache-Control', 'public, no-cache');
}

/**
 * Computes a short ETag from a Buffer (MD5 hex, first 16 chars).
 */
export function computeETag(buffer) {
  return createHash('md5').update(buffer).digest('hex').slice(0, 16);
}
