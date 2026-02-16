-- ============================================================
-- index.db — Central metadata (no BLOBs)
-- ============================================================

CREATE TABLE IF NOT EXISTS projects (
    id              TEXT PRIMARY KEY,
    slug            TEXT NOT NULL UNIQUE,
    name            TEXT NOT NULL,
    description     TEXT,
    capture_date    TEXT,
    location        TEXT,
    center_lat      REAL NOT NULL,
    center_lon      REAL NOT NULL,
    entry_photo_id  TEXT,
    photo_count     INTEGER DEFAULT 0,
    db_filename     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS photos (
    id                      TEXT PRIMARY KEY,
    project_id              TEXT NOT NULL REFERENCES projects(id),
    original_name           TEXT NOT NULL,
    display_name            TEXT NOT NULL,
    sequence_number         INTEGER NOT NULL,
    lat                     REAL NOT NULL,
    lon                     REAL NOT NULL,
    ele                     REAL,
    heading                 REAL,
    camera_height           REAL,
    mesh_rotation_y         REAL DEFAULT 180,
    mesh_rotation_x         REAL DEFAULT 0,
    mesh_rotation_z         REAL DEFAULT 0,
    distance_scale          REAL DEFAULT 1.0,
    marker_scale            REAL DEFAULT 1.0,
    floor_level             INTEGER DEFAULT 1,
    full_size_bytes         INTEGER,
    preview_size_bytes      INTEGER,
    calibration_reviewed    INTEGER DEFAULT 0,
    UNIQUE(project_id, sequence_number)
);

CREATE VIRTUAL TABLE IF NOT EXISTS photos_rtree USING rtree(
    rowid_id,
    min_lon, max_lon,
    min_lat, max_lat
);

CREATE TABLE IF NOT EXISTS photos_rowid (
    rowid_id    INTEGER PRIMARY KEY AUTOINCREMENT,
    photo_id    TEXT NOT NULL UNIQUE REFERENCES photos(id)
);

CREATE TABLE IF NOT EXISTS targets (
    source_id        TEXT NOT NULL REFERENCES photos(id),
    target_id        TEXT NOT NULL REFERENCES photos(id),
    distance_m       REAL,
    bearing_deg      REAL,
    is_next          INTEGER DEFAULT 0,
    is_original      INTEGER DEFAULT 1,
    override_bearing  REAL,   -- NULL = use calculated projection; bearing degrees 0-360 (0=North)
    override_distance REAL,   -- NULL = use calculated projection; ground distance in meters
    hidden           INTEGER DEFAULT 0,
    PRIMARY KEY (source_id, target_id)
);

CREATE INDEX IF NOT EXISTS idx_photos_project ON photos(project_id);
CREATE INDEX IF NOT EXISTS idx_photos_original ON photos(original_name);
CREATE INDEX IF NOT EXISTS idx_targets_source ON targets(source_id);
