# CLAUDE.md - EBGeo360 Service Guide

## Project Overview

EBGeo360 — 360 image microservice for the EBGeo system (Sistema de Informacao Geografica do Exercito Brasileiro). Serves panoramic photo metadata, 360-degree images (WebP), a navigation graph between photos, and a web-based calibration interface. Consumed by the parent EBGeo web app at `../ebgeo_web`.

**Version**: 1.0.0

## Tech Stack

- **Runtime**: Node.js 22 (Alpine in Docker)
- **Framework**: Fastify 5.x
- **Database**: SQLite via better-sqlite3 (synchronous API)
- **Image Processing**: Sharp 0.33.x (WebP conversion during migration)
- **Calibration UI**: Three.js (360 viewer), MapLibre GL JS (minimap), vanilla JS
- **Container**: Docker with 512 MB memory limit

## Commands

```bash
npm start              # Start server (node src/server.js)
npm run dev            # Dev server with auto-restart (--watch)
npm run migrate        # Import JSON metadata + JPG images into SQLite
npm run generate-pmtiles  # Generate PMTiles for map markers
npm run verify         # Validate database integrity
npm run estimate-slope-roll  # Estimate mesh_rotation_z from elevation data
npm test               # Run tests (node:test built-in)
npm run lint           # ESLint (--max-warnings 0)
npm run lint:fix       # ESLint auto-fix
npm run knip           # Dead code / unused dependency detection
```

## Project Structure

```
src/
├── server.js              # Fastify entry point (port 8081)
├── config.js              # Environment-driven configuration
├── db/
│   ├── connection.js      # SQLite connection manager (singleton, lazy-loaded)
│   ├── schema.sql         # index.db schema (metadata, no BLOBs)
│   ├── project-schema.sql # Per-project DB schema (BLOBs, 64KB page size)
│   └── queries.js         # Prepared statements and query wrappers
├── routes/
│   ├── health.js          # GET /health
│   ├── projects.js        # GET /api/v1/projects, GET /api/v1/projects/:slug
│   ├── photos.js          # GET /api/v1/photos/:uuid, GET .../image, GET .../by-name/:name
│   └── calibration.js     # Calibration write endpoints (rotation, height, scale, overrides, review, batch)
└── middleware/
    └── cache.js           # Cache-Control headers + ETag computation

scripts/
├── migrate.js             # JSON+JPG → SQLite migration (7-phase)
├── generate-pmtiles.js    # PMTiles generation for mapping
├── estimate-slope-roll.js # Estimate mesh_rotation_z from elevation between consecutive photos
└── verify.js              # Data validation

public/calibration/        # Calibration web interface
├── index.html
└── js/                    # Modules: app, viewer, navigator, renderer, projector, calibration-panel, preview-viewer, api, state, minimap, hit-tester, constants

tests/
├── unit/                  # cache.test.js
├── integration/           # health, projects, photos, calibration, queries
└── helpers/               # build-app.js (Fastify builder), test-db.js (seed data)
```

## Database Architecture

**Two-database model** separating metadata from BLOBs:

### index.db (Central metadata)
- **projects** — slug, name, location, center coordinates, entry photo ID, photo count
- **photos** — coordinates, heading, camera_height, mesh_rotation_y/x/z, distance_scale, calibration_reviewed, sequence number
- **photos_rtree** — R-tree spatial index for geographic queries
- **targets** — Navigation graph (source→target with distance, bearing, override bearing/distance/height, hidden flag)

### {slug}.db (Per-project images)
- **images** — photo_id → full_webp BLOB + preview_webp BLOB
- Created with `PRAGMA page_size = 65536` for optimal BLOB streaming

### SQLite Optimizations
- WAL mode on all connections
- 64 MB cache for index.db, 32 MB per project DB
- Prepared statements created once and reused (`queries.js`)
- Project DBs opened readonly, lazy-loaded on first request

### Schema Migrations
`connection.js` applies migrations on startup for existing databases:
- Adds `calibration_reviewed`, `mesh_rotation_x`, `mesh_rotation_z`, `distance_scale`, `marker_scale` columns to `photos`
- Renames `override_heading`/`override_pitch` → `override_bearing`/`override_distance` in `targets`
- Clamps old `override_pitch < 0.5` values to `5m` default
- Adds `hidden` column to `targets` (default 0)
- Adds `override_height` column to `targets` (default NULL)

## API Endpoints

### Read (GET)
| Endpoint | Description | Cache |
|----------|-------------|-------|
| `/health` | Service status + project count | None |
| `/api/v1/projects` | List all projects | 1h |
| `/api/v1/projects/:slug` | Single project details | 1h |
| `/api/v1/photos/:uuid` | Photo metadata + targets (hidden targets filtered unless `?include_hidden=true`) | no-cache (revalidate) |
| `/api/v1/photos/:uuid/image?quality=full\|preview` | WebP image stream | 1yr immutable + ETag |
| `/api/v1/photos/by-name/:originalName` | Backward compat lookup | 1h |

### Write (Calibration)
| Endpoint | Description |
|----------|-------------|
| `PUT /api/v1/photos/:uuid/calibration` | Update mesh_rotation_y (0–360) |
| `PUT /api/v1/photos/:uuid/height` | Update camera_height (0.1–20 m) |
| `PUT /api/v1/photos/:uuid/rotation-x` | Update mesh_rotation_x (−30–30) |
| `PUT /api/v1/photos/:uuid/rotation-z` | Update mesh_rotation_z (−30–30) |
| `PUT /api/v1/photos/:uuid/distance-scale` | Update distance_scale (0.1–5.0) |
| `PUT /api/v1/photos/:uuid/marker-scale` | Update marker_scale (0.1–5.0) |
| `PUT /api/v1/photos/:uuid/reviewed` | Mark photo reviewed/unreviewed |
| `PUT /api/v1/targets/:sourceId/:targetId/override` | Set bearing (0–360°) / distance (0.5–500 m) / height (−10–10 m) overrides |
| `DELETE /api/v1/targets/:sourceId/:targetId/override` | Clear overrides |
| `PUT /api/v1/targets/:sourceId/:targetId/visibility` | Set target hidden state (hidden: bool) |
| `GET /api/v1/photos/:uuid/nearby?radius=100` | Find nearby unconnected photos within radius |
| `POST /api/v1/targets` | Create new target connection (source_id, target_id) |
| `DELETE /api/v1/targets/:sourceId/:targetId` | Delete manually-created target (is_original=0 only) |
| `GET /api/v1/projects/:slug/photos` | List photos with review status |
| `POST /api/v1/projects/:slug/reset-reviewed` | Reset all photos to unreviewed |
| `PUT /api/v1/projects/:slug/batch-calibration` | Batch update calibration fields for all photos |

### Photo Metadata Response Shape
```json
{
  "camera": {
    "id": "uuid", "img": "uuid",
    "display_name": "IMG_0001",
    "lon": -55.79, "lat": -29.78, "ele": 100.5,
    "heading": 180.0, "height": 2.5,
    "mesh_rotation_y": 180.0, "mesh_rotation_x": 0.0, "mesh_rotation_z": 0.0,
    "distance_scale": 1.0, "marker_scale": 1.0, "floor_level": 1,
    "calibration_reviewed": false
  },
  "projectSlug": "alegrete",
  "captureDate": "2024-01-15",
  "targets": [{
    "id": "uuid", "img": "uuid",
    "lon": -55.79, "lat": -29.78, "ele": 100.0,
    "display_name": "IMG_0002",
    "next": true, "distance": 12.5, "bearing": 45.0,
    "override_bearing": null, "override_distance": null, "override_height": null,
    "hidden": false, "is_original": true
  }]
}
```

## Configuration

Environment variables (with defaults):

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 8081 | HTTP server port |
| `HOST` | 0.0.0.0 | Bind address |
| `STREETVIEW_DATA_DIR` | ./data | Root data dir (index.db + projects/) |
| `LOG_LEVEL` | info | Fastify logger level |
| `CORS_ORIGIN` | * | CORS allowed origins |

## Integration with EBGeo Web

The parent app (`../ebgeo_web`) integrates via REST API calls:

- **`src/js/street_view_tool/`** — 360 viewer UI, navigation, markers (Three.js)
- **`src/js/street_view_tool/streetview-api.service.js`** — API client
- **`src/js/store/streetview360.operations.js`** — CRUD for orientations/markers
- **`src/js/features_tab/streetview360-section.component.js`** — Feature list section
- **`src/js/street_view_tool/streetview_markers.js`** — Clustered map markers (PMTiles)

Events: `STREETVIEW_360_OPENED`, `STREETVIEW_360_CLOSED`, `STREETVIEW_360_PHOTO_CHANGED`, `ORIENTATION_360_SAVED`, `ORIENTATION_360_CLEARED`, `MARKER_360_CLICKED`, `MARKERS_360_CHANGED`

## Architecture Patterns

### Route Pattern
Each route module exports an async function registered as a Fastify plugin:
```javascript
export default async function myRoutes(fastify) {
  fastify.get('/api/v1/...', async (request, reply) => { ... });
}
```

### Query Pattern
All database queries use prepared statements via `db/queries.js`:
```javascript
import { getPhotoById, getTargetsBySourceId } from '../db/queries.js';
const photo = getPhotoById(uuid);       // Returns row or undefined
const targets = getTargetsBySourceId(uuid); // Returns array
```

### Connection Pattern
Singleton connections with lazy initialization:
```javascript
import { getIndexDb, getProjectDb } from './db/connection.js';
const db = getIndexDb();                    // Always same instance
const imgDb = getProjectDb('alegrete.db');  // Cached per filename
```

## Key Conventions

### Code Style
- ES Modules (ESM) throughout (`"type": "module"`)
- JSDoc on all modules and public functions
- Module header: `@module`, `@description`
- Section separators not used (compact codebase)

### Naming
- Files: kebab-case (`project-schema.sql`, `cache.js`)
- Functions: camelCase (`getPhotoById`, `setImageCacheHeaders`)
- DB columns: snake_case (`mesh_rotation_y`, `override_bearing`)
- API response: camelCase for new fields, snake_case preserved for backward compat (`mesh_rotation_y`)

### Error Handling
- 400 for validation errors (with `{ error: "message" }`)
- 404 for not found
- 503 for health check failures
- 500 for unexpected write failures

### Testing
- Node.js built-in `node:test` (no external framework)
- Integration tests use `tests/helpers/build-app.js` (Fastify without listener)
- Test data seeded via `tests/helpers/test-db.js`

### SQL Injection Prevention
- All queries use prepared statements with `?` placeholders
- Column names validated against whitelist in `getImageBlob()`

## Calibration Parameters

| Parameter | Column | Range | Default | Description |
|-----------|--------|-------|---------|-------------|
| Heading (Y) | `mesh_rotation_y` | 0–360 | 180 | Yaw correction applied to panorama sphere |
| Pitch (X) | `mesh_rotation_x` | −30–30 | 0 | Pitch tilt correction |
| Roll (Z) | `mesh_rotation_z` | −30–30 | 0 | Roll tilt correction (auto-estimated from slope) |
| Camera height | `camera_height` | 0.1–20 | 2.5 | Height above ground in meters |
| Distance scale | `distance_scale` | 0.1–5.0 | 1.0 | Multiplier for target distances |
| Marker scale | `marker_scale` | 0.1–5.0 | 1.0 | Multiplier for navigation marker visual size |
| Override bearing | `override_bearing` | 0–360 | NULL | Manual target bearing (degrees, 0=North) |
| Override distance | `override_distance` | 0.5–500 | NULL | Manual target ground distance (meters) |
| Override height | `override_height` | −10–10 | NULL | Manual target vertical offset (meters, positive = above ground) |
| Hidden | `hidden` | 0/1 | 0 | Whether target is hidden from navigation (per source→target pair) |
| Reviewed | `calibration_reviewed` | 0/1 | 0 | Whether calibration has been reviewed |

### Three.js Rotation Order
The panorama sphere uses Euler order `ZXY` — matrix `Rz·Rx·Ry` — meaning Y (heading) is applied first to pixels, then X (pitch), then Z (roll) in the corrected frame. Both `viewer.js` (calibration) and `street_view_viewer.js` (ebgeo_web) must use the same order.

### Elevation Delta in Projection
When both camera and target have `ele` data, the elevation difference `ΔE = target.ele - camera.ele` offsets the target marker vertically: `y = -cameraHeight + ΔE`. This affects marker Y position, flatten ratio, and slant distance for marker sizing. Clamped to ±2m (`MAX_ELEVATION_DELTA`) to protect against GPS noise. When either `ele` is null, `ΔE = 0` (flat ground fallback).

### Slope Roll Estimation
`scripts/estimate-slope-roll.js` estimates `mesh_rotation_z` (roll) from elevation data between a photo and its `next` target: `θ = atan2(ΔE, distance)`. Slopes beyond `--max-angle` (default 15°, recommended 10°) are **discarded** as GPS noise (set to 0), not clamped. Supports `--dry-run`, `--clear`, `--project <slug>`, `--max-angle <N>`.

### Target Override Projection
Override markers use a **ground-plane model**: bearing + ground distance + height are projected onto `y = -cameraHeight + overrideHeight` plane, NOT spherical coordinates. Both `navigator.js` (calibration) and `navigation/navigator.js` (ebgeo_web) use `projectFromOverride()` for this. Override markers do **not** use GPS elevation delta — the height is manually controlled via a slider in the calibration UI. When `override_height` is NULL/0, the marker sits on the ground plane exactly where the user clicked.

## Calibration UI Architecture

The calibration interface (`public/calibration/`) is a vanilla JS SPA with module-level state pattern:

### Module Dependency Graph
```
app.js (orchestrator)
├── viewer.js          Three.js panorama sphere (renders 360 image)
├── navigator.js       Canvas 2D overlay: projects targets + nearby to screen, handles clicks
│   ├── projector.js   Lon/lat → meters → screen coordinate math
│   ├── renderer.js    Canvas 2D drawing: markers, ground cursor, grid, nearby markers
│   └── hit-tester.js  Point-in-circle hit testing for marker clicks
├── calibration-panel.js  Sidebar panel: sliders, target list, save/discard, review workflow
├── preview-viewer.js  Mini Three.js viewer: shows target/nearby photo 360 preview
├── minimap.js         MapLibre GL minimap: camera position, targets, nearby photos
├── state.js           Centralized state + onChange listeners (notify pattern)
├── api.js             REST API client (fetch wrappers)
└── constants.js       NAV_CONSTANTS shared between projector/renderer
```

### Panel Structure (top to bottom)
1. Review nav — project progress bar, prev/next photo buttons
2. Photo section — display name + reviewed badge (no coords/UUID)
3. Grid toggle — perspective grid on/off
4. Save/Discard buttons — enabled when dirty
5. Review actions — mark reviewed, reviewed → next
6. **Collapsible**: Parametros de Calibração — 6 sliders (rotation_y/x/z, height, distance/marker_scale)
7. **Collapsible**: Aplicar ao Projeto — batch update buttons
8. **Collapsible**: Targets (N) — clickable target list with override/hidden badges
9. Override editor — bearing/distance/height sliders, set-from-click, hide/show, delete (when target selected)
10. **Collapsible**: Fotos Proximas (N) — nearby unconnected photos with Preview toggle
11. Fotos do Projeto — full photo list with review status

### Collapsible Sections
- State persisted in `localStorage` key `cal-panel-collapsed`
- `renderCollapsibleSection(key, title, contentHtml, options)` helper with chevron toggle
- `options.headerExtra` for inline buttons (e.g. Preview toggle) that don't trigger collapse

### Nearby Photos Preview Mode
- Toggle button in "Fotos Proximas" section header enables/disables preview mode
- When enabled: green markers appear on the canvas at nearby photo positions (full-size, `MARKER_WORLD_RADIUS`)
- Clicking a nearby marker (canvas or list) opens `preview-viewer.js` with "Adicionar Conexao" button
- "Adicionar Conexao" calls `createTarget()` API then `refreshTargetsAndNearby()` (no full page reload)
- `refreshTargetsAndNearby()` re-fetches metadata and updates targets/nearby via `state.refreshTargets()` preserving calibration edits

### State Update Pattern
- `loadPhoto()` — full reset: all calibration edits, overrides, hidden state, nearby
- `refreshTargets()` — partial reset: only targets/overrides/hidden, preserves calibration edits (used after add/delete target)
- `onChange(fn)` — subscribe to state changes; panel re-renders on every notify
- Slider drag uses `silent=true` to skip panel re-render during drag, notify on release

## Data Pipeline

Migration (`scripts/migrate.js`) processes source data in 7 phases:
1. Read JSON metadata files from `METADATA/*.json`
2. Read JPG images from `IMG/*.jpg`
3. Assign photos to nearest project center by distance
4. Generate navigation graph (50m radius, 15-degree angular separation)
5. Convert images to WebP (full + preview sizes)
6. Write to SQLite databases (index.db + per-project DBs)
7. Verify data integrity

## Deployment

```bash
# Docker
docker-compose up -d
# Available at http://localhost:8081
# Calibration UI at http://localhost:8081/calibration/

# Local development
npm run dev
```

## Projects

15 military sites in southern Brazil:
Alegrete, Parque Osorio, Uruguaiana, 3o RCMec, CIST, 27o GAC, CI Guarnicao Ijui, EASA, 29o GACap, CI Cruz Alta, SantAna do Livramento, Tubarao, Blumenau, CI General Calazans, Ponta Grossa
