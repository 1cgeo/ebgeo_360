/**
 * @module routes/photos
 * @description Photo metadata and image serving endpoints.
 * Images are streamed from per-project SQLite databases.
 */

import { Readable } from 'node:stream';
import {
  getPhotoById,
  getPhotoByOriginalName,
  getTargetsBySourceId,
  getVisibleTargetsBySourceId,
  getProjectByPhotoId,
  getImageBlob,
  isPhotoDeleted,
} from '../db/queries.js';
import {
  setImageCacheHeaders,
  setMetadataCacheHeaders,
  setMutableMetadataCacheHeaders,
  computeImageETag,
  computeMetadataETag,
} from '../middleware/cache.js';

// Limitador simples de concorrencia para a rota de imagem. Cada request de imagem
// materializa o BLOB WebP inteiro no heap (1-5 MB no caso full); sob o limite de
// 512 MB do container, muitos buffers multi-MB simultaneos pressionam RSS/GC e
// podem causar OOM. O semaforo enfileira o excedente, garantindo no maximo
// MAX_INFLIGHT_IMAGE_REQUESTS buffers vivos ao mesmo tempo. O caminho 304 (cache
// hit) NAO passa pelo semaforo, pois nao carrega o BLOB.
const MAX_INFLIGHT_IMAGE_REQUESTS = 8;
let _inflightImages = 0;
const _imageWaitQueue = [];

/**
 * Adquire uma vaga no limitador de concorrencia de imagens.
 * Resolve imediatamente se houver vaga; caso contrario, enfileira.
 * @returns {Promise<void>}
 */
function acquireImageSlot() {
  if (_inflightImages < MAX_INFLIGHT_IMAGE_REQUESTS) {
    _inflightImages++;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    _imageWaitQueue.push(resolve);
  });
}

/**
 * Libera uma vaga do limitador, promovendo o proximo da fila se houver.
 */
function releaseImageSlot() {
  const next = _imageWaitQueue.shift();
  if (next) {
    // Mantem _inflightImages constante: a vaga e repassada diretamente.
    next();
  } else {
    _inflightImages--;
  }
}

export default async function photoRoutes(fastify) {
  // GET /api/v1/photos/:uuid — photo metadata (same shape as legacy JSON)
  fastify.get('/api/v1/photos/:uuid', async (request, reply) => {
    const { uuid } = request.params;
    const photo = getPhotoById(uuid);

    if (!photo || isPhotoDeleted(uuid)) {
      reply.code(404);
      return { error: 'Photo not found' };
    }

    const includeHidden = request.query.include_hidden === 'true';
    const targets = includeHidden
      ? getTargetsBySourceId(uuid)
      : getVisibleTargetsBySourceId(uuid);
    const project = getProjectByPhotoId(uuid);

    // Valida cache via ETag barato: assinatura compacta da calibracao da foto +
    // targets. Com no-cache + validador, o cliente revalida mas o servidor evita
    // re-serializar/transferir o corpo quando nada mudou (304).
    const signature = [
      uuid,
      includeHidden ? 'h' : 'v',
      photo.mesh_rotation_y, photo.mesh_rotation_x, photo.mesh_rotation_z,
      photo.camera_height, photo.distance_scale, photo.marker_scale,
      photo.calibration_reviewed,
      ...targets.map(t => [
        t.target_id, t.distance_m, t.bearing_deg, t.is_next,
        t.override_bearing, t.override_distance, t.override_height, t.hidden,
      ].join(',')),
    ].join('|');
    const etag = computeMetadataETag(signature);

    const ifNoneMatch = request.headers['if-none-match'];
    if (ifNoneMatch && ifNoneMatch.replace(/"/g, '') === etag) {
      setMutableMetadataCacheHeaders(reply, etag);
      reply.code(304);
      return;
    }

    setMutableMetadataCacheHeaders(reply, etag);

    return {
      camera: {
        id: photo.id,
        img: photo.id,
        display_name: photo.display_name,
        lon: photo.lon,
        lat: photo.lat,
        ele: photo.ele,
        heading: photo.heading,
        height: photo.camera_height,
        mesh_rotation_y: photo.mesh_rotation_y,
        mesh_rotation_x: photo.mesh_rotation_x,
        mesh_rotation_z: photo.mesh_rotation_z,
        distance_scale: photo.distance_scale,
        marker_scale: photo.marker_scale,
        floor_level: photo.floor_level,
        calibration_reviewed: Boolean(photo.calibration_reviewed),
      },
      projectSlug: project?.slug ?? null,
      captureDate: project?.capture_date ?? null,
      targets: targets.map(t => ({
        id: t.target_id,
        img: t.target_id,
        lon: t.lon,
        lat: t.lat,
        ele: t.ele,
        display_name: t.display_name,
        icon: t.is_next ? 'next' : undefined,
        next: Boolean(t.is_next),
        is_original: Boolean(t.is_original),
        distance: t.distance_m,
        bearing: t.bearing_deg,
        override_bearing: t.override_bearing ?? null,
        override_distance: t.override_distance ?? null,
        override_height: t.override_height ?? null,
        ...(includeHidden ? { hidden: Boolean(t.hidden) } : {}),
      })),
    };
  });

  // GET /api/v1/photos/:uuid/image?quality=full|preview — serve image from SQLite BLOB
  fastify.get('/api/v1/photos/:uuid/image', async (request, reply) => {
    const { uuid } = request.params;
    const quality = request.query.quality === 'preview' ? 'preview' : 'full';
    const column = quality === 'preview' ? 'preview_webp' : 'full_webp';

    // Resolve a foto uma unica vez: photoById ja traz project_id e os tamanhos
    // em bytes (full_size_bytes/preview_size_bytes). getProjectByPhotoId fornece
    // o db_filename necessario para abrir o BLOB no caminho 200.
    const photo = getPhotoById(uuid);
    if (!photo || isPhotoDeleted(uuid)) {
      reply.code(404);
      return { error: 'Photo not found' };
    }

    // ETag derivado de (uuid + quality + tamanho) — imagens sao imutaveis apos a
    // ingestao, entao isso identifica unicamente o conteudo SEM ler o BLOB.
    const sizeBytes = quality === 'preview' ? photo.preview_size_bytes : photo.full_size_bytes;
    const etag = computeImageETag(uuid, quality, sizeBytes);

    // Short-circuit do 304 ANTES de tocar no BLOB: o caminho de cache-hit fica O(1).
    const ifNoneMatch = request.headers['if-none-match'];
    if (ifNoneMatch && ifNoneMatch.replace(/"/g, '') === etag) {
      setImageCacheHeaders(reply, etag);
      reply.header('Accept-Ranges', 'bytes');
      reply.code(304);
      return;
    }

    const project = getProjectByPhotoId(uuid);
    if (!project) {
      reply.code(404);
      return { error: 'Photo not found' };
    }

    // So aqui carregamos o BLOB (caminho 200/206 real). Limitamos a concorrencia
    // para evitar muitos buffers multi-MB simultaneos sob o limite de memoria.
    // releaseOnce garante uma unica liberacao da vaga, independente do caminho.
    await acquireImageSlot();
    let released = false;
    const releaseOnce = () => {
      if (released) return;
      released = true;
      releaseImageSlot();
    };

    let imageBuffer;
    try {
      imageBuffer = getImageBlob(project.db_filename, uuid, column);
    } catch (err) {
      releaseOnce();
      throw err;
    }
    if (!imageBuffer) {
      releaseOnce();
      reply.code(404);
      return { error: 'Image not found' };
    }

    // Suporte a Range requests: responde 206 com Content-Range quando o cliente
    // pede um intervalo de bytes valido (retomada de download / partial fetch).
    const range = parseRange(request.headers['range'], imageBuffer.length);
    if (range === false) {
      // Range presente mas insatisfazivel: 416 com Content-Range total.
      releaseOnce();
      reply.code(416);
      reply.header('Content-Range', `bytes */${imageBuffer.length}`);
      reply.header('Accept-Ranges', 'bytes');
      return { error: 'Requested Range Not Satisfiable' };
    }

    setImageCacheHeaders(reply, etag);
    reply.header('Content-Type', 'image/webp');
    reply.header('Accept-Ranges', 'bytes');

    const payload = range
      ? imageBuffer.subarray(range.start, range.end + 1)
      : imageBuffer;

    if (range) {
      reply.code(206);
      reply.header('Content-Range', `bytes ${range.start}-${range.end}/${imageBuffer.length}`);
    }
    reply.header('Content-Length', payload.length);

    // Libera a vaga do semaforo quando o envio terminar (close) ou falhar (error).
    const stream = Readable.from(payload);
    stream.on('close', releaseOnce);
    stream.on('error', releaseOnce);
    return reply.send(stream);
  });

  // GET /api/v1/photos/by-name/:originalName — backward compat lookup
  fastify.get('/api/v1/photos/by-name/:originalName', async (request, reply) => {
    const { originalName } = request.params;
    const photo = getPhotoByOriginalName(originalName);

    if (!photo) {
      reply.code(404);
      return { error: 'Photo not found' };
    }

    setMetadataCacheHeaders(reply);
    return {
      id: photo.id,
      originalName: photo.original_name,
      displayName: photo.display_name,
    };
  });

  // HEAD /api/v1/photos/:uuid is auto-generated by Fastify (exposeHeadRoutes: true)
  // for the GET route above, returning 200 for existing photos and 404 for missing ones.
}

/**
 * Faz o parse de um header Range simples ("bytes=start-end") para imagens.
 * Suporta apenas um unico intervalo (o caso pratico de retomada/partial fetch).
 * @param {string|undefined} header - Valor do header Range
 * @param {number} size - Tamanho total do conteudo em bytes
 * @returns {{start:number,end:number}|null|false} Intervalo valido,
 *   null se nao houver Range, ou false se o Range for insatisfazivel.
 */
function parseRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null; // formato nao suportado: serve o conteudo inteiro (200)

  const hasStart = match[1] !== '';
  const hasEnd = match[2] !== '';
  if (!hasStart && !hasEnd) return false;

  let start;
  let end;
  if (!hasStart) {
    // Sufixo: ultimos N bytes.
    const suffix = parseInt(match[2], 10);
    if (suffix === 0) return false;
    start = Math.max(size - suffix, 0);
    end = size - 1;
  } else {
    start = parseInt(match[1], 10);
    end = hasEnd ? parseInt(match[2], 10) : size - 1;
    if (end >= size) end = size - 1;
  }

  if (start > end || start >= size || start < 0) return false;
  return { start, end };
}
