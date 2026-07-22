# CLAUDE.md - EBGeo360 Service Guide

## Project Overview

EBGeo360 — 360 image microservice for the EBGeo system (Sistema de Informacao Geografica do Exercito Brasileiro). Serves panoramic photo metadata, 360-degree images (WebP), a navigation graph between photos, and a web-based calibration interface. Consumed by the parent EBGeo web app at `../ebgeo_web`.

**Version**: 1.0.0

## Tech Stack

- **Runtime**: Node.js >= 22, run directly on the host (no container)
- **Framework**: Fastify 5.x
- **Database**: SQLite via better-sqlite3 12.x (synchronous API)
- **Image Processing**: Sharp 0.33.x (WebP conversion during migration)
- **Calibration UI**: Three.js (360 viewer), MapLibre GL JS (minimap), vanilla JS

### Native dependencies

`better-sqlite3` and `sharp` are native addons. Both ship prebuilt binaries, so a
plain `npm install` needs no C++ toolchain — but only if the version matches the
Node release in use. **`better-sqlite3` must stay at 12.x or newer**: 11.x has no
prebuilt binary for Node 24 (`No prebuilt binaries found (target=24.13.0 ...)`),
falls back to compiling from source, and fails on any Windows machine without the
Visual C++ Build Tools installed. If `npm install` ever starts invoking
`node-gyp rebuild`, that is the symptom — bump the dependency rather than
installing a compiler.

## Commands

```bash
npm start              # Start server (node --env-file=.env src/server.js)
npm run dev            # Dev server with auto-restart (--watch)
npm run migrate        # Import JSON metadata + JPG images into SQLite
npm run generate-pmtiles  # Generate PMTiles for map markers
npm run cleanup-wal    # Checkpoint/clean SQLite WAL files
npm test               # Run tests (node:test built-in)
npm run lint           # ESLint (--max-warnings 0); ignores public/ and docs/
npm run lint:calibration  # ESLint for public/calibration/ (browser globals, no-undef)
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
│   └── calibration.js     # Write endpoints (rotations, review, visibility, targets, batch)
└── middleware/
    └── cache.js           # Cache-Control headers + ETag computation

scripts/
├── migrate.js             # JSON+JPG → SQLite migration (7-phase)
├── generate-pmtiles.js    # PMTiles generation for mapping
├── cleanup-wal.js         # Checkpoint/clean SQLite WAL files
└── lib/
    └── orientation.js     # Quaternion pose -> viewer Euler angles (ZXY)

public/calibration/        # Calibration web interface
├── index.html
└── js/                    # Modules: app, viewer, navigator, renderer, projector, calibration-panel, preview-viewer, api, state, minimap, hit-tester, constants

tests/
├── unit/                  # cache, orientation (quaternion), calibration-horizon-marker
├── integration/           # health, projects, photos, calibration, queries
└── helpers/               # build-app.js (Fastify builder), test-db.js (seed data)
```

## Database Architecture

**Two-database model** separating metadata from BLOBs:

### index.db (Central metadata)
- **projects** — slug, name, location, center coordinates, entry photo ID, photo count
- **photos** — coordinates, heading, mesh_rotation_y/x/z, floor_level, calibration_reviewed, sequence number (plus the inert camera_height/distance_scale/marker_scale)
- **photos_rtree** — R-tree spatial index for geographic queries
- **targets** — Navigation graph (source→target with distance, bearing, hidden, is_original; plus the inert override_*)
- **deleted_photos** — soft-delete tombstones
- **photos_rowid** — stable rowid mapping for the R-tree

### {slug}.db (Per-project images)
- **images** — photo_id → full_webp BLOB + preview_webp BLOB
- Created with `PRAGMA page_size = 65536` for optimal BLOB streaming

### thumbnails/ (Static project thumbnails)
- `{slug}.webp` — One thumbnail per project, served via `/api/v1/thumbnails/{slug}.webp`
- Used by the catalog in ebgeo_web to display project preview images

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
- Creates `deleted_photos` and the `targets`/`deleted_photos` indexes

## API Endpoints

### Read (GET)
| Endpoint | Description | Cache |
|----------|-------------|-------|
| `/health` | Service status + project count | None |
| `/api/v1/projects` | List all projects (includes `previewThumbnail` URL) | 1h |
| `/api/v1/projects/:slug` | Single project details | 1h |
| `/api/v1/thumbnails/:slug.webp` | Static project thumbnail image (WebP) | Static |
| `/api/v1/photos/:uuid` | Photo metadata + targets (hidden targets filtered unless `?include_hidden=true`) | no-cache (revalidate) |
| `/api/v1/photos/:uuid/image?quality=full\|preview` | WebP image stream | 1yr immutable + ETag |
| `/api/v1/photos/by-name/:originalName` | Backward compat lookup | 1h |

### Write (Calibration)
| Endpoint | Description |
|----------|-------------|
| `PUT /api/v1/photos/:uuid/calibration` | Update mesh_rotation_y (0–360) |
| `PUT /api/v1/photos/:uuid/rotation-x` | Update mesh_rotation_x (−30–30) |
| `PUT /api/v1/photos/:uuid/rotation-z` | Update mesh_rotation_z (−30–30) |
| `PUT /api/v1/photos/:uuid/reviewed` | Mark photo reviewed/unreviewed |
| `PUT /api/v1/targets/:sourceId/:targetId/visibility` | Set target hidden state (hidden: bool) |
| `GET /api/v1/photos/:uuid/nearby?radius=100` | Find nearby unconnected photos within radius |
| `POST /api/v1/targets` | Create new target connection (source_id, target_id) |
| `DELETE /api/v1/targets/:sourceId/:targetId` | Delete a target (is_original=0 only) |
| `DELETE /api/v1/photos/:uuid` | Soft-delete a photo (tombstone in `deleted_photos`) |
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
| `STREETVIEW_DATA_DIR` | ./data | Root data dir (index.db + projects/ + thumbnails/) |
| `LOG_LEVEL` | info | Fastify logger level |
| `CORS_ORIGIN` | * | CORS allowed origins |

## Integration with EBGeo Web

The parent app (`../ebgeo_web`) integrates via REST API calls:

- **`src/js/street_view_tool/`** — 360 viewer UI, navigation, markers (Three.js)
- **`src/js/street_view_tool/streetview-api.service.js`** — API client
- **`src/js/store/streetview360.operations.js`** — CRUD for orientations/markers
- **`src/js/features_tab/streetview360-section.component.js`** — Feature list section
- **`src/js/street_view_tool/streetview_markers.js`** — Clustered map markers (PMTiles)
- **`src/js/catalog/catalog.service.js`** — Catalog aggregation (builds absolute thumbnail URLs from `serviceUrl` + `previewThumbnail`)

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

Only three values are still calibrated per photo, and all three calibrate the
IMAGE, not the marker:

| Parameter | Column | Range | Default | Description |
|-----------|--------|-------|---------|-------------|
| Heading (Y) | `mesh_rotation_y` | 0–360 | 180 | Yaw correction applied to panorama sphere |
| Pitch (X) | `mesh_rotation_x` | −30–30 | 0 | Pitch tilt correction |
| Roll (Z) | `mesh_rotation_z` | −30–30 | 0 | Roll tilt correction |

Two more per-target values are edited, and they are graph decisions rather than
calibration: `hidden` (0/1, this way is blocked by a wall) and the existence of
the connection itself. `calibration_reviewed` (0/1) tracks the review workflow.

### Columns that no longer affect anything

`camera_height`, `distance_scale`, `marker_scale`, `override_bearing`,
`override_distance` and `override_height` are **inert**. Nothing reads them to
draw, no slider edits them, and the save flow no longer writes them.

They are deliberately NOT dropped: the archive holds 519 overrides, 444 of them
in a single 77-photo project, and they are the record of which photos are badly
positioned. An inventory is in `docs/overrides-inventario.json`. The write
endpoints that used to set them (`/height`, `/distance-scale`, `/marker-scale`,
`PUT`/`DELETE .../override`) were REMOVED; the columns remain only as memory.

### Three.js Rotation Order
The panorama sphere uses Euler order `ZXY` — matrix `Rz·Rx·Ry` — meaning Y (heading) is applied first to pixels, then X (pitch), then Z (roll) in the corrected frame. Both `viewer.js` (calibration) and `street_view_viewer.js` (ebgeo_web) must use the same order.

### Marker Model (Relative)

The navigation marker takes exactly two things from lat/lon: which DIRECTION a
target lies in, and in what ORDER the targets sit along that direction. Nothing
else about the position reaches the screen.

- Targets whose bearings fall within `HORIZON_DIRECTION_BUCKET_DEG` of each other
  count as one direction, and form a queue ordered by distance.
- The first icon of a queue gets a fixed angular size, just below the corrected
  horizon. Each one behind it is `HORIZON_RANK_DECAY` of the size of the one in
  front, and RISES by a gap computed from the two radii.
- That gap is what guarantees no icon can bury another, which is what keeps every
  target clickable. There is no decluttering pass.
- Opacity also decays with rank, because the size floor stops the shrinking after
  three or four ranks.

The horizon here is the CORRECTED one: the sphere is levelled by
`mesh_rotation_x/z` before anything is drawn, so the camera's horizontal plane is
the image's true horizon. If a marker looks off the horizon in a photo, the mesh
calibration of that photo is what is wrong.

Entry points: `projector.projectOnHorizon()`, `projector.angularMarkerRadius()`,
`navigator.layoutDirections()`. This replaced a ground-plane model that simulated
the floor at the capture point; that model needed six hand-tuned values per photo
and is gone, along with `calculateFlattenRatio`, `calculateMarkerSize`,
`projectFromOverride`, the ground cursor and the ground grid.

**A wrong marker position is corrected by moving the PHOTO, never by nudging the
marker.** The photo-position editor does not exist yet.

### The navigation graph is imported, never recomputed in-system

The graph is prepared outside and imported once by `migrate.js`. Nothing inside
the running service regenerates targets, so there is no destructive recompute to
guard against, and the standalone `recalculate-targets.js` was deleted.

This is why there are only two target states, both on `is_original`:

- `is_original = 1`: came from the capture (imported). Protected from deletion:
  `deleteTarget` refuses these, and they are the bearing reference.
- `is_original = 0`: everything else — the imported spatial graph AND a
  connection the operator creates in the UI (`insertTarget`). Both are removable.

An earlier `is_manual` column existed only to save operator connections from
`recalculate-targets.js` wiping them. With that script gone, `is_manual` marked a
distinction nothing at runtime ever branched on, so it was removed. A wrong
marker position is corrected by moving the PHOTO, and a wall is handled by hiding
a target (`hidden = 1`); neither needs the flag.

### Slope Roll Estimation (Removed)
Estimating `mesh_rotation_z` from elevation data is deprecated and the standalone script has been removed — elevation is no longer used for projection (flat ground model). `mesh_rotation_z` is now set only via the calibration UI.

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
6. **Collapsible**: Parametros de Calibração — 3 sliders (rotation_y/x/z only; the height/distance_scale/marker_scale sliders were removed with the ground model)
7. **Collapsible**: Aplicar ao Projeto — batch update buttons
8. **Collapsible**: Targets (N) — clickable target list with hidden badges
9. Target actions (when selected) — Ocultar/Mostrar Target, Remover Conexao (only for is_original=0), Fechar. The old per-target override editor was removed.
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
- `loadPhoto()` — full reset: calibration edits, hidden state, nearby
- `refreshTargets()` — partial reset: only targets/hidden, preserves calibration edits (used after add/delete target)
- `onChange(fn)` — subscribe to state changes; panel re-renders on every notify
- Slider drag uses `silent=true` to skip panel re-render during drag, notify on release

## Data Pipeline

Migration (`scripts/migrate.js`) processes source data in 7 phases:
1. Read JSON metadata files from `METADATA/*.json`
2. Assign photos to nearest project center by distance
3. Compute sequence numbers per project
4. Generate UUIDs with randomUUID (NOT deterministic: re-running a project duplicates it, which is why the PROJECTS array in migrate.js ships commented out)
5. Adaptive spatial analysis — navigation graph (sector-based, per-project adaptive radius)
6. Populate metadata + targets in index.db
7. Process images into per-project databases (JPG → WebP conversion)

## Deployment

The service runs directly on Node, with no container.

```bash
npm install            # prebuilt native binaries, no compiler needed
cp .env.example .env   # then adjust if the defaults do not fit
npm start              # or `npm run dev` for auto-restart on change

# Available at http://localhost:8081
# Calibration UI at http://localhost:8081/calibration/
```

`npm start` reads `.env` via `node --env-file`, so **the file must exist** even
when every value is left at its default. `.env.example` is the catalogue of what
can be set; `.env` itself is gitignored.

Configuration is environment-driven and every variable has a default in
`src/config.js` (`PORT`, `HOST`, `STREETVIEW_DATA_DIR`, `LOG_LEVEL`,
`CORS_ORIGIN`). See `.env.example` for what each one does.