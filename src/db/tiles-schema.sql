CREATE TABLE IF NOT EXISTS tiles (
    photo_id  TEXT NOT NULL,
    level     INTEGER NOT NULL,
    x         INTEGER NOT NULL,
    y         INTEGER NOT NULL,
    webp      BLOB NOT NULL,
    PRIMARY KEY (photo_id, level, x, y)
);

-- `razao` fecha o contrato da escada. A grade sai de (width, height, tile_size,
-- razao), entao quem reconstruir a escada com outra razao produz outras colunas
-- e outras linhas. O sintoma seria tile faltando, nunca erro, e por isso a razao
-- se GRAVA em vez de se assumir.
--
-- Ela vem POR ULTIMO de proposito, depois de built_at. Um banco anterior recebe
-- a coluna por ALTER TABLE ADD COLUMN, que so acrescenta no fim: com a mesma
-- ordem aqui, o arquivo migrado e o arquivo novo tem as colunas na mesma
-- posicao, e um SELECT * devolve a mesma coisa nos dois.
--
-- DEFAULT 2 e o valor certo para o legado: as piramides que existem hoje foram
-- geradas com a escada classica de metades sucessivas.
CREATE TABLE IF NOT EXISTS tile_pyramids (
    photo_id    TEXT PRIMARY KEY,
    tile_size   INTEGER NOT NULL,
    max_level   INTEGER NOT NULL,
    width       INTEGER NOT NULL,
    height      INTEGER NOT NULL,
    quality     INTEGER NOT NULL,
    tile_count  INTEGER NOT NULL,
    total_bytes INTEGER NOT NULL,
    built_at    TEXT NOT NULL,
    razao       REAL NOT NULL DEFAULT 2
);
