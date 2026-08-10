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
npm run generate-pmtiles  # Generate fotos.pmtiles + fotos_linha.pmtiles from index.db
npm run import-tracks     # Populate project_tracks (capture track) from geojson/PMTiles
npm run derive-runs       # Populate capture_runs (faixas de coleta) from original_name
                          #   --slug <slug> para um projeto so, --dry-run para so relatar
npm run import-captured-at -- --sources "<dir>[,<dir>]"  # photos.captured_at do time_img da fonte
                          #   --slug <slug>, --dry-run; rodar derive-runs depois
# Import photos that exist in fotos.geojson + images but have no metadata JSON:
node scripts/import-geojson-photos.js --slug <slug> --geojson <fotos.geojson> --images <dir>
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
│   ├── photos.js          # GET /api/v1/photos/:uuid, GET .../image, GET .../by-name/:name, GET .../nearest
│   ├── calibration.js     # Write endpoints (rotations, review, visibility, targets, batch)
│   └── tiles.js           # Camadas de mapa: tile vetorial de pontos + traçado em GeoJSON
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
├── integration/           # health, projects, photos, calibration, project-map, queries
└── helpers/               # build-app.js (Fastify builder), test-db.js (seed data)
```

## Database Architecture

**Two-database model** separating metadata from BLOBs:

### index.db (Central metadata)
- **projects** — slug, name, location, center coordinates, entry photo ID, photo count
- **photos** — coordinates, heading, mesh_rotation_y/x/z, floor_level, calibration_reviewed, calibration_source, captured_at, sequence number (plus the inert camera_height/distance_scale/marker_scale)
- **photos_rtree** — R-tree spatial index for geographic queries
- **targets** — Navigation graph (source→target with distance, bearing, hidden, is_original; plus the inert override_*)
- **deleted_photos** — soft-delete tombstones
- **photos_rowid** — stable rowid mapping for the R-tree
- **project_tracks** — capture track, one LineString per row (`coords` = JSON `[[lon,lat],…]`)

### Photos with an image but no metadata JSON

`migrate.js` walks the METADATA directory, so a photo that has a JPG and a point
in `fotos.geojson` but no `.json` is invisible to it — 578 of AMAN's 12.334 were
in that state. `scripts/import-geojson-photos.js` imports them from the geojson.

The interesting part is `heading`, without which the viewer cannot place markers.
It is recovered as **the bearing to the next photo in `time_img` order along the
track**. The direction matters: a LineString is not always drawn the way the
vehicle drove (209 of AMAN's 445 segments are reversed), and using the raw
segment direction puts 3% of headings 180° out. Measured against the 11.753
photos that do have a heading, the time-ordered bearing lands within 1.3° at the
median and 30° at p97.7, with no inverted cases.

The script is **re-runnable**, which matters when reading from an external drive:
the image step converts every photo of the project that has no BLOB, rather than
only the rows it just inserted. Inserting rows first and converting after — the
obvious order — silently strands photos if the drive drops mid-run, because the
next run sees them as already imported. Both this script and `migrate.js` retry
reads 8 times with backoff and wait up to 30 min for a disconnected drive to come
back.

### Faixa de coleta = uma sessão de gravação

`capture_runs` guarda as faixas de um projeto, e `photos.run_id`/`run_position`
prendem cada foto à sua. Uma faixa é uma **corrida contínua do veículo** — não a
`faixa_img` da fonte, que é outra coisa e outra granularidade (no AMAN: 143
`faixa_img` contra 8 sessões).

É a granularidade em que a calibração é constante, porque é a granularidade em
que a montagem da câmera não muda. Medido no faxinal, o único projeto com
calibração real vinda de quaternion: desvio de `mesh_rotation_y` de **0,60° dentro
da faixa** contra **8,40° entre as médias das faixas** (amplitude 316,4° a 344,0°).
Por isso "Aplicar ao Projeto" é grosso demais — um valor único erra ~20° nas
faixas do outro extremo.

**A fronteira vem do identificador de sessão gravado no `original_name`, não de
um corte por intervalo de tempo.** As fotos são disparadas por distância (passo
mediano 13,5 m), então um veículo parado num semáforo produz um intervalo
temporal longo sem deslocamento nenhum: um corte por gap partiria a faixa no
sinal vermelho, e o limiar teria de ser diferente para trânsito urbano e para
área militar. Dois padrões cobrem o acervo inteiro, com zero nomes não
reconhecidos em 90.433 fotos:

- `MULTICAPTURA_<sessão>_<quadro>` → `session_key` = `mc:9468`
- `PIC_<início da captura>_<costura>_output_<quadro>` → `ts:2026-04-27T09:08:36`

São **duas datas** no nome PIC_, e a **primeira** é o início da captura; a
segunda é a costura do lote. Isto já esteve invertido no código. O EXIF das
imagens do faxinal decidiu, em 5.672 fotos: `primeira data + quadro × 4 s` cai a
**2 s** da hora real, com 100% dentro de 5 s, enquanto a segunda data erra de
**8 a 9 dias**. Uma faixa gravada como `2026-05-05T14:47:14` foi capturada em
`2026-04-26T13:37:35`.

As duas são 1 para 1 (45 sessões por qualquer uma delas no faxinal), então o
AGRUPAMENTO saía certo mesmo com a data errada, e só o `started_at`, o rótulo e,
no saicã, a ordem das faixas é que saíam furados. Um agrupamento correto não
prova que a data está certa.

`npm run derive-runs` popula tudo, é re-executável e preserva o
`applied_rotation_*` de faixas que já existiam (reidentificadas pela
`session_key`). Ele **solta `photos.run_id` antes de apagar as faixas** — o
caminho inverso só quebra a chave estrangeira na segunda execução, quando
`run_id` já não é NULL. Resultado atual: 401 faixas para 90.428 fotos.

A ordem das faixas é cronológica quando **todas** têm `started_at`, e por tamanho
decrescente caso contrário — critério do projeto inteiro, porque uma lista meio
cronológica meio por tamanho não teria ordem nenhuma. O id do MULTICAPTURA (9468,
4809, 0913) é opaco e não carrega data, então a faixa cujo NOME não traz hora
herda o `started_at` da foto datada mais antiga dela mesma. Basta **uma** foto
datada por faixa, e não a faixa inteira. Isso tirou 12 projetos da ordem por
tamanho: hoje 22 são cronológicos e 6 não. Faltam `3pef` e `santiago` por uma
única faixa cada; `aman` por 16 de 24; `blumenau` e `tubarao` por 5; `dcmun` não
tem fonte de hora nenhuma.

`captured_at` vem de `npm run import-captured-at`, por três fontes, nesta ordem
de precedência: o `time_img` dos `fotos.geojson`, a coluna `time`/`time_img` dos
CSV do levantamento, e `--from-name`, que deduz do próprio nome nos arquivos
PIC_. Os JSON por foto **não** têm hora (só id, img, lon, lat, ele, heading).

Estado atual: **88.006 das 98.685 fotos vivas** (89,2%), de 2022-08-18 a
2026-05-02. Dessas, 65.791 vieram de fonte externa e 22.215 do nome. `ciatalaia`
e `cigmal` só chegam a 100% combinando geojson e vários CSV, e o `cigmal` não
tem geojson nenhum.

Ficam **10.679 sem hora, todas MULTICAPTURA**, porque só o padrão PIC_ carrega
hora no nome: `aman` 8.160, `dcmun` 1.235, `3pef` 1.146, `tubarao` 114,
`blumenau` 19 e `santiago` 5. São as mesmas 29 faixas que seguem sem
`started_at`. Para o `3pef` a hora existe no EXIF de
`FILTRADAS_ATLAS` (uma faixa, `mc:5573`), ainda não importada.

**O `captured_at` não melhora a ordem DENTRO da faixa, e isso foi medido.** Em
quatro projetos com cobertura total (santana, alegrete, uruguaiana e 1pef,
46.266 fotos) reordenar por hora move de 0,00% a 0,01% das fotos e deixa a
distribuição de passo idêntica até a casa decimal. A razão está no dado cru: o
número do quadro já é um contador de tempo (`MULTICAPTURA_0913_000037` →
1742330126, `_000041` → 1742330130, com os mesmos saltos). No faxinal, contra a
hora do EXIF, a ordem por quadro deu **0 inversões em 5.625 pares** consecutivos.
A cauda gorda do passo (p99 de 109 m no 1pef) é gap real de trajeto, que
reordenar não conserta. O que o `captured_at` compra é o `started_at` acima e a
data real da captura, que não existia em lugar nenhum do banco.

As duas horas usam o mesmo formato local `AAAA-MM-DDTHH:MM:SS`, sem fuso: o nome
PIC_ traz hora local e o importador converte o epoch da fonte para local (UTC-3,
constante desde que o Brasil acabou com o horário de verão em 2019). Fossem
formatos diferentes, a comparação de string que ordena as faixas misturaria
escalas.

### A navegação de revisão segue a faixa

`sequence_number` é uma **BFS do grafo de navegação** (`migrate.js:354`), não a
ordem de captura. Andar por ela trocava de faixa em **89,9%** das fotos
consecutivas no santana (faxinal 75%, uruguaiana 60,5%) — o operador reajustava o
mesmo parâmetro para frente e para trás o tempo todo.

`getNextPhotoId` anda dentro da faixa por `run_position` e só passa para a
próxima faixa com pendência quando a atual acaba. Medido no faxinal: **0% de
troca de faixa em 300 passos**, contra 40% na ordem antiga. `getPrevPhotoId`
deliberadamente **não** pula para a faixa anterior: voltar é um gesto de "revi
algo errado agora há pouco", e saltar de faixa tiraria o operador do contexto sem
ele pedir. Projeto sem faixas derivadas volta ao comportamento por
`sequence_number`.

`applied_rotation_*` em `capture_runs` é **registro, não herança**: o batch por
faixa escreve direto em `photos`, que continua sendo a única verdade da
calibração. A coluna existe para a interface poder dizer "faixa calibrada em
337°".

### The capture track lives in the database

`project_tracks` holds the same geometry as `fotos_linha.pmtiles`, but attributed
to a project. `scripts/import-tracks.js` populates it, preferring
`data/_source_backup/{slug}_fotos_linha.geojson` and falling back to decoding the
PMTiles for projects whose source geojson is not on this machine. Legacy PMTiles
features carry no project, so they are attributed by proximity: each vertex votes
for the project owning the nearest photo (worst vertex lands 28 m from a photo of
the chosen project; median 3.5 m).

`generate-pmtiles.js` then builds **both** layers from the database, so the
PMTiles is a derivative of the DB rather than its own lineage. The old workflow —
decode the PMTiles, merge the new batch's geojson, re-encode — pushed the
geometry through another simplification pass on every import.

Two flags matter when encoding the line and are easy to lose:

- `-z14`, never `-zg`. Tippecanoe quantises geometry to the finest tile; at the
  inherited `z11` a unit is ~5 m, at z14 it is ~0.55 m — well under the 13–19 m
  between consecutive photos.
- `--no-line-simplification`. Tippecanoe simplifies even at max zoom. Without
  this flag 305 of DCMun's 1437 source vertices ended up more than 1 m from any
  stored vertex: total length survived, curves became straight lines. With it,
  the worst deviation across DCMun/AMAN/Faxinal is **0.44 m**, which is just the
  z14 grid.

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
- Adds `calibration_reviewed`, `calibration_source`, `mesh_rotation_x`, `mesh_rotation_z`, `distance_scale`, `marker_scale` columns to `photos`
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
| `/api/v1/photos/nearest?lon=&lat=` | Photo closest to a coordinate, from the R-tree | no-cache (revalidate) |

### Map layers (tiles.js)

O mapa do EBGeo lia estas duas camadas de dois arquivos PMTiles servidos pelo
Martin. Agora saem daqui, direto do `index.db`: a camada é o banco, sem passo de
tippecanoe no meio e sem defasagem entre calibrar e ver.

| Endpoint | Description | Cache |
|----------|-------------|-------|
| `/api/v1/tiles/fotos.json` | TileJSON da camada de pontos (zoom 11–12, `bounds` do acervo) | 1h |
| `/api/v1/tiles/fotos/:z/:x/:y.pbf` | Tile vetorial de pontos, camada `fotos`; 204 quando vazio, 400 fora da faixa | no-cache (revalidate) |
| `/api/v1/tracks` | Todo o traçado do acervo em GeoJSON, atributo `origem` = slug | no-cache (revalidate) |

Três números que mandam no desenho, todos medidos sobre os 29 projetos:

- **Ponto é tile e linha é GeoJSON** porque as 99.040 fotos dão 35,7 MB de
  GeoJSON (5,9 MB comprimido) e os 3.236 traçados dão 1,9 MB (0,3 MB), menos que
  os 712 KB do `fotos_linha.pmtiles`.
- **Sem índice em memória.** Um índice geojson-vt do acervo inteiro custa 374,6
  MB e leva o RSS a 579 MB, acima do teto de 512 MB do container. Cada tile
  nasce da consulta ao R-tree: o mediano em 3,2 ms, o pior em 37,7 ms.
- **A faixa de zoom é o freio.** Sem o teto de 12 e o piso de 11, um pedido em
  z0 traria as 99.040 fotos num tile só. Quem precisa de foto abaixo de z11 é o
  clique na linha do mapa, e esse caminho usa `/photos/nearest`.

O `scripts/generate-pmtiles.js` continua funcionando, mas saiu do caminho de
produção: serve de saída de emergência e para consumidor externo que ainda queira
o arquivo.

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
| `GET /api/v1/projects/:slug/map` | Map mode payload: every photo with position, review state and the 3 angles, plus the capture track |
| `GET /api/v1/projects/:slug/runs` | Faixas de coleta com progresso de revisão (lista vazia se não derivado) |
| `PUT /api/v1/runs/:runId/batch-calibration` | Aplica os 3 ângulos a todas as fotos de uma faixa |
| `GET /api/v1/projects/review-stats` | Contadores de revisão de todos os projetos numa varredura |
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
    "calibration_reviewed": false,
    "calibration_source": "sol", "captured_at": "2025-10-07T09:04:19"
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

### De onde veio o ângulo: `calibration_source`

Diz o que produziu os três ângulos daquela foto, e a interface o desenha no
cabeçalho e em cada linha da lista.

| valor | significado |
|---|---|
| `sol` | o Sol foi detectado NESTA foto e entrou no ajuste |
| `imu` | sem sol utilizável, refinada pela rajada do giroscópio |
| `manual` | o revisor escreveu o ângulo, por foto, faixa ou projeto |
| nulo | nada foi medido nela: o ângulo veio do bloco da faixa |

**Toda escrita de ângulo pela API grava `manual`**, nos nove comandos de
`queries.js` (três eixos, vezes foto, faixa e projeto). Mão humana derruba a
origem automática, e o valor `manual` também protege a foto: a calibração
solar do vault a pula, mesmo sem `calibration_reviewed`.

Nulo NÃO é falha. Em 2026-07-28 ele cobria 54,4% do acervo (53.647 de 98.690),
contra 41,1% de `sol` e 4,6% de `imu`. É a foto que mais merece o olho na
revisão, porque nada nela passou por conferência contra o mundo. Por isso a etiqueta de
"sem medida" aparece só no cabeçalho da foto atual, e não na lista, onde ela
cairia na maioria das linhas.

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
├── project-map.js     MapLibre GL project map mode: whole project, click to preview/enter
├── state.js           Centralized state + onChange listeners (notify pattern)
├── api.js             REST API client (fetch wrappers)
└── constants.js       NAV_CONSTANTS shared between projector/renderer
```

### Project Map Mode

Toggled with `M` or the "Mapa do projeto" button in the panel; `Escape` also
closes it. Covers the viewer (the panel stays visible) and shows **one project**
— joining projects would only inflate the payload.

- Points are coloured by review state (green reviewed / amber pending) with the
  photo open in the viewer highlighted in blue.
- Clicking a point opens a card with the `preview` WebP, the review badge, the
  three angles (`mesh_rotation_y/x/z`) and an "Entrar na foto" button that goes
  through `navigateToPhoto` — so the dirty-state dialog still applies.
- Marking a photo reviewed repaints it on the map immediately
  (`setPhotoReviewedOnMap`); the payload is only re-fetched when the project
  changes.

The track is the **same line as `fotos_linha.pmtiles`**, stored per project in
`project_tracks` (see below). The PMTiles file itself is not usable here: it is
one file holding every project, and the 21 pre-2026 ones are all written as
`origem = 'legado'` with no way to tell them apart.

The track is drawn twice, with crossfaded opacity: **under** the points above
zoom 17.5, **over** them below 16.5. Below z17 the photo dots touch each other
(15 m apart is 6.8 px at z16, and the dot radius is already 5 px), so a line
underneath is completely hidden — which is exactly the scale where the survey
shape matters most.

MapLibre is only instantiated on first open, so a calibration session that never
opens the map pays no extra WebGL context.

### Panel Structure (top to bottom)
1. Review nav — project progress bar, prev/next photo buttons, "Mapa do projeto [M]"
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