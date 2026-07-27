/**
 * @module routes/calibration
 * @description Write endpoints for the calibration interface.
 * Updates photo mesh_rotation y/x/z, review flag, target visibility, and
 * create/delete of target connections.
 */

import {
  getPhotoById,
  getTargetByPair,
  updatePhotoMeshRotationY,
  updatePhotoMeshRotationX,
  updatePhotoMeshRotationZ,
  updateTargetVisibility,
  insertTarget,
  deleteTarget,
  getNearbyPhotos,
  updateCalibrationReviewed,
  getPhotosByProjectSlug,
  getReviewStatsByProjectSlug,
  getReviewStatsAllProjects,
  getMapPhotosByProjectSlug,
  getTracksByProjectSlug,
  batchUpdateMeshRotationY,
  batchUpdateMeshRotationX,
  batchUpdateMeshRotationZ,
  batchResetReviewed,
  isPhotoDeleted,
  softDeletePhoto,
  getProjectByPhotoId,
  getProjectBySlug,
  getRunsByProjectSlug,
  getRunById,
  batchUpdateRunMeshRotation,
  updateRunApplied,
} from '../db/queries.js';
import { getIndexDb } from '../db/connection.js';

/**
 * Faixas validas de cada eixo, iguais as dos endpoints por foto.
 * @constant
 */
const LIMITES_ROTACAO = {
  mesh_rotation_y: [0, 360],
  mesh_rotation_x: [-30, 30],
  mesh_rotation_z: [-30, 30],
};

/**
 * Valida o corpo de um batch de calibracao (projeto ou faixa).
 *
 * Extraido porque os dois endpoints de batch aplicam exatamente as mesmas
 * regras: manter duas copias faria uma divergir da outra na primeira vez que um
 * limite mudasse.
 *
 * @param {Object} body - Corpo da requisicao
 * @returns {{error: string}|{values: Object}} Erro de validacao ou os campos
 *   presentes, ja validados.
 */
function validarBatchRotacoes(body) {
  const values = {};
  for (const [campo, [min, max]] of Object.entries(LIMITES_ROTACAO)) {
    const valor = body?.[campo];
    if (valor === undefined) continue;
    if (typeof valor !== 'number' || Number.isNaN(valor)) {
      return { error: `${campo} must be a number` };
    }
    if (valor < min || valor > max) {
      return { error: `${campo} must be between ${min} and ${max}` };
    }
    values[campo] = valor;
  }
  if (Object.keys(values).length === 0) {
    return { error: 'Must provide at least one calibration field' };
  }
  return { values };
}

export default async function calibrationRoutes(fastify) {
  // PUT /api/v1/photos/:uuid/calibration — update mesh_rotation_y
  fastify.put('/api/v1/photos/:uuid/calibration', async (request, reply) => {
    const { uuid } = request.params;
    const { mesh_rotation_y } = request.body || {};

    // Validate
    if (typeof mesh_rotation_y !== 'number' || Number.isNaN(mesh_rotation_y)) {
      reply.code(400);
      return { error: 'mesh_rotation_y must be a number' };
    }

    if (mesh_rotation_y < 0 || mesh_rotation_y > 360) {
      reply.code(400);
      return { error: 'mesh_rotation_y must be between 0 and 360' };
    }

    // Check photo exists
    const photo = getPhotoById(uuid);
    if (!photo) {
      reply.code(404);
      return { error: 'Photo not found' };
    }

    const result = updatePhotoMeshRotationY(uuid, mesh_rotation_y);
    if (result.changes === 0) {
      reply.code(500);
      return { error: 'Failed to update' };
    }

    return { ok: true, mesh_rotation_y };
  });

  // PUT /api/v1/photos/:uuid/rotation-x — update mesh_rotation_x
  fastify.put('/api/v1/photos/:uuid/rotation-x', async (request, reply) => {
    const { uuid } = request.params;
    const { mesh_rotation_x } = request.body || {};

    if (typeof mesh_rotation_x !== 'number' || Number.isNaN(mesh_rotation_x)) {
      reply.code(400);
      return { error: 'mesh_rotation_x must be a number' };
    }

    if (mesh_rotation_x < -30 || mesh_rotation_x > 30) {
      reply.code(400);
      return { error: 'mesh_rotation_x must be between -30 and 30' };
    }

    const photo = getPhotoById(uuid);
    if (!photo) {
      reply.code(404);
      return { error: 'Photo not found' };
    }

    const result = updatePhotoMeshRotationX(uuid, mesh_rotation_x);
    if (result.changes === 0) {
      reply.code(500);
      return { error: 'Failed to update' };
    }

    return { ok: true, mesh_rotation_x };
  });

  // PUT /api/v1/photos/:uuid/rotation-z — update mesh_rotation_z
  fastify.put('/api/v1/photos/:uuid/rotation-z', async (request, reply) => {
    const { uuid } = request.params;
    const { mesh_rotation_z } = request.body || {};

    if (typeof mesh_rotation_z !== 'number' || Number.isNaN(mesh_rotation_z)) {
      reply.code(400);
      return { error: 'mesh_rotation_z must be a number' };
    }

    if (mesh_rotation_z < -30 || mesh_rotation_z > 30) {
      reply.code(400);
      return { error: 'mesh_rotation_z must be between -30 and 30' };
    }

    const photo = getPhotoById(uuid);
    if (!photo) {
      reply.code(404);
      return { error: 'Photo not found' };
    }

    const result = updatePhotoMeshRotationZ(uuid, mesh_rotation_z);
    if (result.changes === 0) {
      reply.code(500);
      return { error: 'Failed to update' };
    }

    return { ok: true, mesh_rotation_z };
  });

  // PUT /api/v1/photos/:uuid/reviewed — mark photo as reviewed/unreviewed
  fastify.put('/api/v1/photos/:uuid/reviewed', async (request, reply) => {
    const { uuid } = request.params;
    const { reviewed } = request.body || {};

    if (typeof reviewed !== 'boolean') {
      reply.code(400);
      return { error: 'reviewed must be a boolean' };
    }

    const photo = getPhotoById(uuid);
    if (!photo) {
      reply.code(404);
      return { error: 'Photo not found' };
    }

    const result = updateCalibrationReviewed(uuid, reviewed);
    if (result.changes === 0) {
      reply.code(500);
      return { error: 'Failed to update' };
    }

    return { ok: true, reviewed };
  });

  // GET /api/v1/projects/review-stats — contadores de revisao de todos os projetos
  //
  // O seletor de projetos desenha uma barra de progresso por projeto e nada
  // mais. Antes ele obtinha esses dois numeros chamando /projects/:slug/photos
  // uma vez por projeto, o que trazia as 90 mil fotos do acervo (~11 MB de JSON)
  // para somar 27 pares de inteiros. Aqui e uma varredura agregada so.
  //
  // Rota estatica antes de /projects/:slug em projects.js: o find-my-way do
  // Fastify prefere o segmento literal ao parametrico, independente da ordem de
  // registro, entao 'review-stats' nunca cai no handler de :slug.
  fastify.get('/api/v1/projects/review-stats', async () => {
    const stats = {};
    for (const row of getReviewStatsAllProjects()) {
      stats[row.slug] = { total: row.total, reviewed: row.reviewed ?? 0 };
    }
    return { stats };
  });

  // GET /api/v1/projects/:slug/photos — list photos for a project (calibration workflow)
  fastify.get('/api/v1/projects/:slug/photos', async (request, reply) => {
    const { slug } = request.params;

    const photos = getPhotosByProjectSlug(slug);
    if (!photos.length) {
      reply.code(404);
      return { error: 'Project not found or has no photos' };
    }

    const stats = getReviewStatsByProjectSlug(slug);

    return {
      // runId/runPosition acompanham cada foto para o cliente montar a
      // navegacao por faixa em memoria, sem uma requisicao por faixa.
      photos: photos.map(p => ({
        id: p.id,
        displayName: p.display_name,
        sequenceNumber: p.sequence_number,
        reviewed: Boolean(p.calibration_reviewed),
        runId: p.run_id,
        runPosition: p.run_position,
      })),
      reviewStats: {
        total: stats.total,
        reviewed: stats.reviewed,
      },
    };
  });

  // GET /api/v1/projects/:slug/map — tudo que o modo mapa da calibracao desenha
  //
  // Um projeto so, sempre: o mapa serve para revisar UM levantamento, e juntar
  // projetos so encareceria o payload sem servir a ninguem.
  //
  // O tracado vem de `project_tracks` — a MESMA linha do fotos_linha.pmtiles,
  // so que guardada por projeto no banco (ver scripts/import-tracks.js). Servir
  // daqui evita expor o PMTiles, que e um arquivo unico com os 28 projetos
  // misturados e sem como separar os antigos, todos gravados como
  // `origem = 'legado'`.
  fastify.get('/api/v1/projects/:slug/map', async (request, reply) => {
    const { slug } = request.params;

    const rows = getMapPhotosByProjectSlug(slug);
    if (!rows.length) {
      reply.code(404);
      return { error: 'Project not found or has no photos' };
    }

    // Arrays curtos em vez de GeoJSON completo: um projeto grande tem ~17 mil
    // fotos, e repetir as chaves de Feature/geometry/properties em cada uma
    // multiplicaria o corpo da resposta. O cliente monta o GeoJSON.
    const photos = rows.map(p => ({
      id: p.id,
      name: p.display_name,
      seq: p.sequence_number,
      lon: p.lon,
      lat: p.lat,
      heading: p.heading,
      ry: p.mesh_rotation_y,
      rx: p.mesh_rotation_x,
      rz: p.mesh_rotation_z,
      reviewed: Boolean(p.calibration_reviewed),
    }));

    const track = getTracksByProjectSlug(slug);

    const lons = rows.map(p => p.lon);
    const lats = rows.map(p => p.lat);

    return {
      slug,
      photos,
      track,
      bounds: [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)],
      reviewStats: getReviewStatsByProjectSlug(slug),
    };
  });

  // POST /api/v1/projects/:slug/reset-reviewed — reset all photos to unreviewed
  fastify.post('/api/v1/projects/:slug/reset-reviewed', async (request, reply) => {
    const { slug } = request.params;

    const photos = getPhotosByProjectSlug(slug);
    if (!photos.length) {
      reply.code(404);
      return { error: 'Project not found or has no photos' };
    }

    const result = batchResetReviewed(slug);
    return { ok: true, photosReset: result.changes };
  });

  // PUT /api/v1/projects/:slug/batch-calibration — update calibration fields for all photos
  fastify.put('/api/v1/projects/:slug/batch-calibration', async (request, reply) => {
    const { slug } = request.params;

    const validacao = validarBatchRotacoes(request.body);
    if (validacao.error) {
      reply.code(400);
      return { error: validacao.error };
    }
    const {
      mesh_rotation_y, mesh_rotation_x, mesh_rotation_z,
    } = validacao.values;

    // Check project has photos
    const photos = getPhotosByProjectSlug(slug);
    if (!photos.length) {
      reply.code(404);
      return { error: 'Project not found or has no photos' };
    }

    const updated = {};

    // Aplica todos os UPDATEs em larga escala numa unica transacao: torna a
    // operacao atomica (sem estado parcial em caso de falha no meio) e muito
    // mais rapida que ate 6 commits isolados.
    getIndexDb().transaction(() => {
      if (mesh_rotation_y !== undefined) {
        const result = batchUpdateMeshRotationY(slug, mesh_rotation_y);
        updated.mesh_rotation_y = { value: mesh_rotation_y, photosUpdated: result.changes };
      }

      if (mesh_rotation_x !== undefined) {
        const result = batchUpdateMeshRotationX(slug, mesh_rotation_x);
        updated.mesh_rotation_x = { value: mesh_rotation_x, photosUpdated: result.changes };
      }

      if (mesh_rotation_z !== undefined) {
        const result = batchUpdateMeshRotationZ(slug, mesh_rotation_z);
        updated.mesh_rotation_z = { value: mesh_rotation_z, photosUpdated: result.changes };
      }

    })();

    return { ok: true, updated };
  });

  // GET /api/v1/projects/:slug/runs — faixas de coleta do projeto, com progresso
  //
  // Uma faixa e uma SESSAO DE GRAVACAO: uma corrida continua do veiculo. E a
  // granularidade em que a calibracao e constante — no faxinal, desvio de 0,60
  // grau dentro da faixa contra 8,40 entre as medias das faixas.
  //
  // Devolve lista vazia (nao 404) quando o projeto existe mas nunca passou pelo
  // `npm run derive-runs`: a interface trata "sem faixa" como o modo antigo, e
  // um 404 aqui faria o painel parecer quebrado num banco so nao derivado.
  fastify.get('/api/v1/projects/:slug/runs', async (request, reply) => {
    const { slug } = request.params;

    if (!getProjectBySlug(slug)) {
      reply.code(404);
      return { error: 'Project not found' };
    }

    const runs = getRunsByProjectSlug(slug).map(r => ({
      id: r.id,
      label: r.label,
      ordinal: r.ordinal,
      startedAt: r.started_at,
      total: r.total,
      reviewed: r.reviewed,
      applied: {
        mesh_rotation_y: r.applied_rotation_y,
        mesh_rotation_x: r.applied_rotation_x,
        mesh_rotation_z: r.applied_rotation_z,
      },
    }));

    return { runs };
  });

  // PUT /api/v1/runs/:runId/batch-calibration — aplica um default a uma faixa
  //
  // Escreve direto em `photos`, como o batch por projeto. `applied_rotation_*`
  // em capture_runs e so REGISTRO, para a interface poder dizer "faixa
  // calibrada em 337 graus" — nao ha heranca, e a verdade da calibracao
  // continua sendo unicamente a coluna da foto.
  fastify.put('/api/v1/runs/:runId/batch-calibration', async (request, reply) => {
    const { runId } = request.params;

    const validacao = validarBatchRotacoes(request.body);
    if (validacao.error) {
      reply.code(400);
      return { error: validacao.error };
    }
    const values = validacao.values;

    const run = getRunById(runId);
    if (!run) {
      reply.code(404);
      return { error: 'Capture run not found' };
    }

    const updated = {};
    getIndexDb().transaction(() => {
      for (const [campo, valor] of Object.entries(values)) {
        const axis = campo.slice(-1); // mesh_rotation_y -> 'y'
        const result = batchUpdateRunMeshRotation(axis, runId, valor);
        updated[campo] = { value: valor, photosUpdated: result.changes };
      }
      updateRunApplied(runId, {
        y: values.mesh_rotation_y ?? null,
        x: values.mesh_rotation_x ?? null,
        z: values.mesh_rotation_z ?? null,
      });
    })();

    return { ok: true, runId, label: run.label, updated };
  });

  // PUT /api/v1/targets/:sourceId/:targetId/visibility — hide/show a target
  fastify.put('/api/v1/targets/:sourceId/:targetId/visibility', async (request, reply) => {
    const { sourceId, targetId } = request.params;
    const { hidden } = request.body || {};

    if (typeof hidden !== 'boolean') {
      reply.code(400);
      return { error: 'hidden must be a boolean' };
    }

    const photo = getPhotoById(sourceId);
    if (!photo) {
      reply.code(404);
      return { error: 'Source photo not found' };
    }

    // Verifica existencia do target via lookup por PK (source_id, target_id),
    // evitando o JOIN + fetch de todas as linhas de getTargetsBySourceId.
    const targetExists = getTargetByPair(sourceId, targetId);
    if (!targetExists) {
      reply.code(404);
      return { error: 'Target not found for this source' };
    }

    const result = updateTargetVisibility(sourceId, targetId, hidden);
    if (result.changes === 0) {
      reply.code(500);
      return { error: 'Failed to update' };
    }

    return { ok: true, hidden };
  });

  // GET /api/v1/photos/:uuid/nearby — find nearby unconnected photos
  fastify.get('/api/v1/photos/:uuid/nearby', async (request, reply) => {
    const { uuid } = request.params;

    // Sanitiza radius: numerico finito, com clamp em [1, 1000] metros.
    // Evita bbox invertido (radius < 0 retornaria lista vazia silenciosa) e
    // varreduras gigantes (radius enorme percorreria todas as fotos do projeto).
    const parsedRadius = Number(request.query.radius);
    const radius = Number.isFinite(parsedRadius)
      ? Math.min(Math.max(parsedRadius, 1), 1000)
      : 100;

    const photo = getPhotoById(uuid);
    if (!photo) {
      reply.code(404);
      return { error: 'Photo not found' };
    }

    // Calculate bounding box from photo coords + radius
    const latOffset = radius / 111320;
    const lonOffset = radius / (111320 * Math.cos(photo.lat * Math.PI / 180));

    const minLon = photo.lon - lonOffset;
    const maxLon = photo.lon + lonOffset;
    const minLat = photo.lat - latOffset;
    const maxLat = photo.lat + latOffset;

    const nearby = getNearbyPhotos(uuid, minLon, maxLon, minLat, maxLat);

    // Calculate distance and bearing for each nearby photo
    const DEG_TO_RAD = Math.PI / 180;
    const R = 6_371_000;

    const photos = nearby.map(p => {
      const dLat = (p.lat - photo.lat) * DEG_TO_RAD;
      const dLon = (p.lon - photo.lon) * DEG_TO_RAD;
      const a = Math.sin(dLat / 2) ** 2
        + Math.cos(photo.lat * DEG_TO_RAD) * Math.cos(p.lat * DEG_TO_RAD)
        * Math.sin(dLon / 2) ** 2;
      const distance = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

      const y = Math.sin(dLon) * Math.cos(p.lat * DEG_TO_RAD);
      const x = Math.cos(photo.lat * DEG_TO_RAD) * Math.sin(p.lat * DEG_TO_RAD)
        - Math.sin(photo.lat * DEG_TO_RAD) * Math.cos(p.lat * DEG_TO_RAD) * Math.cos(dLon);
      const bearing = ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;

      return {
        id: p.id,
        displayName: p.display_name,
        lat: p.lat,
        lon: p.lon,
        ele: p.ele,
        distance: Math.round(distance * 100) / 100,
        bearing: Math.round(bearing * 100) / 100,
      };
    });

    // Sort by distance and filter to actual radius
    const filtered = photos
      .filter(p => p.distance <= radius)
      .sort((a, b) => a.distance - b.distance);

    return { photos: filtered };
  });

  // POST /api/v1/targets — create a new target connection
  fastify.post('/api/v1/targets', async (request, reply) => {
    const { source_id, target_id } = request.body || {};

    if (!source_id || !target_id) {
      reply.code(400);
      return { error: 'source_id and target_id are required' };
    }

    if (source_id === target_id) {
      reply.code(400);
      return { error: 'source_id and target_id must be different' };
    }

    const sourcePhoto = getPhotoById(source_id);
    if (!sourcePhoto) {
      reply.code(404);
      return { error: 'Source photo not found' };
    }

    const targetPhoto = getPhotoById(target_id);
    if (!targetPhoto) {
      reply.code(404);
      return { error: 'Target photo not found' };
    }

    if (sourcePhoto.project_id !== targetPhoto.project_id) {
      reply.code(400);
      return { error: 'Photos must be in the same project' };
    }

    // Check if forward connection already exists
    const existing = getTargetByPair(source_id, target_id);
    if (existing) {
      reply.code(409);
      return { error: 'Target connection already exists' };
    }

    // Calculate distance and bearing (forward: source → target)
    const DEG_TO_RAD = Math.PI / 180;
    const R = 6_371_000;
    const dLat = (targetPhoto.lat - sourcePhoto.lat) * DEG_TO_RAD;
    const dLon = (targetPhoto.lon - sourcePhoto.lon) * DEG_TO_RAD;
    const a = Math.sin(dLat / 2) ** 2
      + Math.cos(sourcePhoto.lat * DEG_TO_RAD) * Math.cos(targetPhoto.lat * DEG_TO_RAD)
      * Math.sin(dLon / 2) ** 2;
    const distanceM = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    const y = Math.sin(dLon) * Math.cos(targetPhoto.lat * DEG_TO_RAD);
    const x = Math.cos(sourcePhoto.lat * DEG_TO_RAD) * Math.sin(targetPhoto.lat * DEG_TO_RAD)
      - Math.sin(sourcePhoto.lat * DEG_TO_RAD) * Math.cos(targetPhoto.lat * DEG_TO_RAD) * Math.cos(dLon);
    const bearingDeg = ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;

    const roundedDistance = Math.round(distanceM * 100) / 100;
    const roundedBearing = Math.round(bearingDeg * 100) / 100;
    const reverseBearing = Math.round(((bearingDeg + 180) % 360) * 100) / 100;

    // Check if reverse connection already exists
    const existingReverse = getTargetByPair(target_id, source_id);

    // Insert both directions atomically
    const db = getIndexDb();
    let reverseCreated = false;
    db.transaction(() => {
      insertTarget(source_id, target_id, roundedDistance, roundedBearing);
      if (!existingReverse) {
        insertTarget(target_id, source_id, roundedDistance, reverseBearing);
        reverseCreated = true;
      }
    })();

    reply.code(201);
    return {
      ok: true,
      target: {
        source_id,
        target_id,
        distance_m: roundedDistance,
        bearing_deg: roundedBearing,
        is_next: false,
        is_original: false,
      },
      reverseCreated,
    };
  });

  // DELETE /api/v1/photos/:uuid — soft-delete a photo
  fastify.delete('/api/v1/photos/:uuid', async (request, reply) => {
    const { uuid } = request.params;

    const photo = getPhotoById(uuid);
    if (!photo) {
      reply.code(404);
      return { error: 'Photo not found' };
    }

    if (isPhotoDeleted(uuid)) {
      reply.code(404);
      return { error: 'Photo already deleted' };
    }

    const project = getProjectByPhotoId(uuid);

    try {
      const result = softDeletePhoto(uuid, photo.project_id);
      return {
        ok: true,
        deletedPhotoId: uuid,
        projectSlug: project?.slug ?? null,
        newPhotoCount: result.newPhotoCount,
        deletedTargets: result.deletedTargets,
      };
    } catch (err) {
      request.log.error(err, 'Failed to soft-delete photo');
      reply.code(500);
      return { error: 'Failed to delete photo' };
    }
  });

  // DELETE /api/v1/targets/:sourceId/:targetId — remove a manually-created target
  fastify.delete('/api/v1/targets/:sourceId/:targetId', async (request, reply) => {
    const { sourceId, targetId } = request.params;

    const existing = getTargetByPair(sourceId, targetId);
    if (!existing) {
      reply.code(404);
      return { error: 'Target not found' };
    }

    if (existing.is_original) {
      reply.code(400);
      return { error: 'Cannot delete original targets. Use visibility to hide them instead.' };
    }

    // Also delete reverse connection if it is manual (is_original=0)
    const reverse = getTargetByPair(targetId, sourceId);
    let reverseDeleted = false;

    const db = getIndexDb();
    db.transaction(() => {
      deleteTarget(sourceId, targetId);
      if (reverse && !reverse.is_original) {
        deleteTarget(targetId, sourceId);
        reverseDeleted = true;
      }
    })();

    return { ok: true, reverseDeleted };
  });
}
