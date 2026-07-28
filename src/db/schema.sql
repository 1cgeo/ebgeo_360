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
    -- Como o angulo desta foto foi obtido. NULL quando nao houve medida SOBRE
    -- ela: o angulo veio do bloco da faixa ou de interpolacao entre vizinhas.
    --   'sol'    o Sol foi detectado NESTA foto e entrou no ajuste
    --   'imu'    sem sol utilizavel, refinada pela rajada do giroscopio
    --   'manual' o revisor escreveu o angulo, por foto, faixa ou projeto
    -- 'manual' sobrescreve os outros dois: toda escrita de angulo pela API o
    -- grava (queries.js), porque mao humana derruba a origem automatica.
    -- A distincao importa na revisao: foto sem medida propria e a que mais
    -- merece o olho, porque nada nela foi conferido contra o mundo.
    calibration_source      TEXT,
    -- Faixa de coleta (sessao de gravacao) a que a foto pertence, e sua posicao
    -- dentro dela. Ver capture_runs. Bancos anteriores recebem estas colunas
    -- pelo bloco de migracoes do connection.js.
    run_id                  TEXT REFERENCES capture_runs(id),
    run_position            INTEGER,
    -- Hora de captura vinda do time_img da fonte. E o que da ordem confiavel
    -- DENTRO da faixa: ordenar pelo numero do quadro do nome funciona bem no
    -- corpo da distribuicao (passo p50 14,3 m / p90 18,0 m em santana) mas
    -- quebra na cauda (p99 de 192 m e saltos de 2,3 km no AMAN).
    captured_at             TEXT,
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
    -- is_original = 1: veio da captura (importada), protegida contra remocao.
    -- is_original = 0: qualquer outra (grafo importado ou conexao criada pelo
    -- operador). Nao ha um terceiro estado: o grafo entra pronto pela migracao
    -- e nada o regenera dentro do sistema, entao nao ha recalculo de que
    -- proteger uma conexao manual. Ambas as de is_original=0 sao removiveis.
    is_original      INTEGER DEFAULT 1,
    override_bearing  REAL,   -- NULL = use calculated projection; bearing degrees 0-360 (0=North)
    override_distance REAL,   -- NULL = use calculated projection; ground distance in meters
    override_height   REAL,   -- NULL = 0 (ground level); vertical offset in meters (positive = above camera)
    hidden           INTEGER DEFAULT 0,
    PRIMARY KEY (source_id, target_id)
);

CREATE TABLE IF NOT EXISTS deleted_photos (
    photo_id    TEXT PRIMARY KEY REFERENCES photos(id),
    deleted_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Tracado da captura, uma LineString por linha.
--
-- E a MESMA linha que vai para o fotos_linha.pmtiles, so que aqui atribuida a
-- um projeto. Guardar no banco tira a dependencia do PMTiles para qualquer
-- consumidor que precise do tracado de um projeto so (o modo mapa da
-- calibracao), e inverte a direcao da geracao: o PMTiles passa a sair daqui,
-- em vez de ser decodificado e remesclado a cada importacao.
--
-- `coords` e um JSON [[lon,lat],...]. SQLite nao tem tipo geometrico e o
-- consumo e sempre "devolva a linha inteira deste projeto" — nunca uma consulta
-- espacial sobre os vertices —, entao um blob JSON serve e evita uma tabela de
-- vertices com milhoes de linhas.
CREATE TABLE IF NOT EXISTS project_tracks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id  TEXT NOT NULL REFERENCES projects(id),
    coords      TEXT NOT NULL,
    source      TEXT NOT NULL DEFAULT 'geojson'
);

CREATE INDEX IF NOT EXISTS idx_project_tracks_project ON project_tracks(project_id);

-- Faixa de coleta = uma SESSAO DE GRAVACAO: uma corrida continua do veiculo,
-- do momento em que o operador iniciou a captura ate parar.
--
-- E a granularidade em que a calibracao e constante, porque e a granularidade
-- em que a montagem da camera nao muda. Medido no faxinal, o unico projeto com
-- calibracao real vinda de quaternion: o desvio de mesh_rotation_y DENTRO da
-- faixa e 0,60 grau, o desvio das MEDIAS entre faixas e 8,40 (amplitude 316,4 a
-- 344,0). Por isso "aplicar ao projeto" e grosso demais: um valor unico erra
-- ~20 graus nas faixas do outro extremo.
--
-- A fronteira vem do identificador de sessao que o proprio equipamento gravou
-- no nome do arquivo, NAO de um corte por intervalo de tempo. As fotos sao
-- disparadas por distancia (passo mediano 13,5 m), entao um veiculo parado num
-- semaforo produz um intervalo longo sem deslocamento nenhum, e um corte
-- temporal partiria a faixa ao meio no sinal vermelho.
--
-- `session_key` e namespaced por origem para nao colidir em projetos que mistu-
-- ram os dois padroes de nome (blumenau, santiago, tubarao):
--   'mc:9468'                 -- MULTICAPTURA_9468_005109
--   'ts:2026-05-05T16:46:57'  -- PIC_20260427_090836_26_05_05_16_46_57_output_5
CREATE TABLE IF NOT EXISTS capture_runs (
    id                  TEXT PRIMARY KEY,
    project_id          TEXT NOT NULL REFERENCES projects(id),
    session_key         TEXT NOT NULL,
    label               TEXT NOT NULL,
    -- Inicio da sessao. So os nomes PIC_ carregam a hora; nos MULTICAPTURA fica
    -- NULL ate o time_img da fonte ser importado.
    started_at          TEXT,
    -- Posicao da faixa na lista do projeto, 1..N. Cronologica quando TODAS as
    -- faixas do projeto tem started_at; caso contrario por tamanho decrescente,
    -- porque os ids do MULTICAPTURA (9468, 4809, 0913) nao sao cronologicos.
    ordinal             INTEGER NOT NULL,
    photo_count         INTEGER NOT NULL DEFAULT 0,
    -- Registro do ultimo default aplicado, para a interface poder dizer "faixa
    -- calibrada em 337 graus". NAO e heranca: o batch escreve direto em photos,
    -- que continua sendo a unica verdade de calibracao.
    applied_rotation_y  REAL,
    applied_rotation_x  REAL,
    applied_rotation_z  REAL,
    UNIQUE(project_id, session_key)
);

CREATE INDEX IF NOT EXISTS idx_capture_runs_project ON capture_runs(project_id, ordinal);

CREATE INDEX IF NOT EXISTS idx_photos_project ON photos(project_id);
-- idx_photos_run (run_id, run_position) NAO fica aqui: schema.sql roda ANTES do
-- bloco de migracoes do connection.js, e num banco existente as colunas ainda
-- nao existiriam neste ponto. O indice e criado la, depois dos ALTER TABLE.
CREATE INDEX IF NOT EXISTS idx_photos_original ON photos(original_name);
CREATE INDEX IF NOT EXISTS idx_targets_source ON targets(source_id);
-- Indexa o ramo target_id do DELETE em soft-delete (evita full table scan no OR)
CREATE INDEX IF NOT EXISTS idx_targets_target ON targets(target_id);
-- Satisfaz o ORDER BY (is_next DESC, distance_m ASC) das queries de targets por source,
-- eliminando o uso de TEMP B-TREE para ordenacao
CREATE INDEX IF NOT EXISTS idx_targets_source_order
    ON targets(source_id, is_next DESC, distance_m ASC);
