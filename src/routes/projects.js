/**
 * @module routes/projects
 * @description Project listing endpoints — replaces config.streetViewMarkers.
 */

import { getAllProjects, getProjectBySlug } from '../db/queries.js';
import { setMetadataCacheHeaders } from '../middleware/cache.js';

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
    previewThumbnail: `/thumbnails/${row.slug}.webp`,
    photoCount: row.photo_count,
  };
}
