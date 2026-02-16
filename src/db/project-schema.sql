-- ============================================================
-- {slug}.db — Per-project image storage (BLOBs)
-- Must be created with: PRAGMA page_size = 65536;
-- ============================================================

CREATE TABLE IF NOT EXISTS images (
    photo_id        TEXT PRIMARY KEY,
    full_webp       BLOB NOT NULL,
    preview_webp    BLOB NOT NULL
);
