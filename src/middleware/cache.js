/**
 * @module middleware/cache
 * @description Cache-Control e ETag para Fastify.
 */

import config from '../config.js';

/**
 * Calcula um hash FNV-1a de 32 bits (nao-criptografico, barato) sobre uma string,
 * retornado em hexadecimal de 8 caracteres. Usado para derivar validadores ETag
 * onde nao ha necessidade de resistencia a colisao adversarial.
 * @param {string} str - Texto de entrada
 * @returns {string} Hash hex (8 chars)
 */
function fnv1a(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    // Multiplicacao FNV (32 bits) via shifts para manter precisao inteira.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

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
 * Quando um ETag e fornecido, o cliente revalida via If-None-Match e o servidor
 * pode responder 304 sem re-transferir o corpo (o no-cache forca a revalidacao,
 * o validador a torna barata).
 * @param {object} reply - Fastify reply
 * @param {string} [etag] - Validador ETag opcional
 */
export function setMutableMetadataCacheHeaders(reply, etag) {
  reply.header('Cache-Control', 'public, no-cache');
  if (etag) {
    reply.header('ETag', `"${etag}"`);
  }
}

/**
 * Deriva um ETag para uma imagem imutavel SEM ler o BLOB.
 * As imagens nunca mudam apos a ingestao, entao (uuid + quality + tamanho em bytes)
 * identifica unicamente o conteudo. Evita carregar o BLOB e hashear todos os bytes
 * a cada requisicao (em especial no caminho 304).
 * @param {string} uuid - UUID da foto
 * @param {string} quality - Variante ('full' | 'preview')
 * @param {number} [sizeBytes] - Tamanho em bytes da variante (opcional)
 * @returns {string} ETag determinístico
 */
export function computeImageETag(uuid, quality, sizeBytes) {
  return `${uuid}-${quality}-${sizeBytes ?? 0}`;
}

/**
 * Deriva um ETag barato para metadados mutaveis a partir de campos ja carregados.
 * Hash nao-criptografico (FNV-1a) sobre uma assinatura compacta dos dados que
 * afetam a resposta (calibracao da foto + targets). Permite 304 quando nada mudou.
 * @param {string} signature - Assinatura estavel dos dados da resposta
 * @returns {string} ETag hex (8 chars)
 */
export function computeMetadataETag(signature) {
  return fnv1a(signature);
}

/**
 * Computes a short ETag from a Buffer using a fast non-cryptographic hash (FNV-1a).
 * Mantido para casos em que ainda e necessario hashear conteudo; o caminho de
 * imagem usa computeImageETag (sem tocar no BLOB).
 * @param {Buffer} buffer - Conteudo a hashear
 * @returns {string} ETag hex (8 chars)
 */
export function computeETag(buffer) {
  return fnv1a(buffer.toString('latin1'));
}
