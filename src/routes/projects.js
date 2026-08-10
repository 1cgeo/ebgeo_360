/**
 * @module routes/projects
 * @description Project listing endpoints — replaces config.streetViewMarkers.
 */

import { getAllProjects, getProjectBySlug, getFloorsByProjectSlug } from '../db/queries.js';
import { setMetadataCacheHeaders } from '../middleware/cache.js';

/**
 * Segmento do path dos thumbnails estaticos, relativo a base da API.
 *
 * Fonte de verdade unica para o path dos thumbnails dentro deste modulo,
 * eliminando a string magica duplicada. O valor e retornado em
 * `previewThumbnail` relativo a base da API: o consumidor concatena com
 * `serviceUrl` (que ja termina em '/api/v1'), produzindo a URL completa servida
 * pela rota estatica registrada em server.js ('/api/v1/thumbnails/'). Por isso
 * o segmento NAO inclui o prefixo '/api/v1' (evita duplicacao na concatenacao).
 * @constant {string}
 */
const THUMBNAILS_SEGMENT = '/thumbnails';

export default async function projectRoutes(fastify) {
  // GET /api/v1/projects — list all projects
  fastify.get('/api/v1/projects', async (_request, reply) => {
    setMetadataCacheHeaders(reply);

    const rows = getAllProjects();
    const projects = rows.map(formatProject);

    return { projects };
  });

  // GET /api/v1/projects/:slug — single project details
  fastify.get('/api/v1/projects/:slug', async (request, reply) => {
    const { slug } = request.params;
    const row = getProjectBySlug(slug);

    if (!row) {
      reply.code(404);
      return { error: 'Project not found' };
    }

    setMetadataCacheHeaders(reply);
    return { project: formatProject(row) };
  });

  // GET /api/v1/projects/:slug/floors — andares do projeto, de cima para baixo.
  //
  // LISTA VAZIA E RESPOSTA VALIDA, nao erro: ela significa "projeto sem
  // andares", que e o caso dos 28 projetos externos do acervo. O cliente usa o
  // vazio para NAO desenhar o seletor. Devolver 404 aqui obrigaria todo
  // consumidor a tratar um erro que nao e erro.
  //
  // A planta vai em GeoJSON, e nao no JSON cru do banco, porque o unico
  // consumidor e uma camada de linha do MapLibre.
  fastify.get('/api/v1/projects/:slug/floors', async (request, reply) => {
    const { slug } = request.params;

    if (!getProjectBySlug(slug)) {
      reply.code(404);
      return { error: 'Project not found' };
    }

    setMetadataCacheHeaders(reply);
    return { floors: getFloorsByProjectSlug(slug).map(formatFloor) };
  });
}

/**
 * Shapes one floor row for the API, turning the stored line list into GeoJSON.
 * @param {Object} row - Row from getFloorsByProjectSlug
 * @returns {Object} Floor payload
 */
function formatFloor(row) {
  let plan = null;

  if (row.plan_coords) {
    let lines = null;
    try {
      lines = JSON.parse(row.plan_coords);
    } catch {
      // Planta ilegivel e um andar SEM planta, nunca uma rota quebrada: o
      // seletor e a navegacao seguem valendo sem o desenho de fundo.
      lines = null;
    }
    if (Array.isArray(lines) && lines.length > 0) {
      plan = {
        type: 'FeatureCollection',
        features: lines.map(coordinates => ({
          type: 'Feature',
          properties: { level: row.level },
          geometry: { type: 'LineString', coordinates },
        })),
      };
    }
  }

  return {
    level: row.level,
    label: row.label,
    photoCount: row.photo_count,
    plan,
  };
}

function formatProject(row) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    captureDate: row.capture_date,
    location: row.location,
    center: { lat: row.center_lat, lon: row.center_lon },
    entryPhotoId: row.entry_photo_id,
    // Derivado de `THUMBNAILS_SEGMENT` (fonte unica do path) — ver constante.
    previewThumbnail: `${THUMBNAILS_SEGMENT}/${row.slug}.webp`,
    photoCount: row.photo_count,
  };
}
