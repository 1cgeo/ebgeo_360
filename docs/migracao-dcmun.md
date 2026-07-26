# Migração DCMun (Depósito Central de Munição)

Runbook do lote de 2026-07, fonte `D:\dados_ebgeo\DCMUN_StreetView`. Segue o
ciclo do lote anterior: **pré-flight → backup → migrate → pós-flight → PMTiles**.

## A fonte

```
D:\dados_ebgeo\DCMUN_StreetView\DCMUN_StreetView\
├── 2 - Metadados Processados\   1275 *.json + fotos.geojson + fotos_linha.geojson
└── 3 - Frames_processados_mascara\  1235 *.jpg (5760×2880) + Thumbs.db
```

Diferente do lote anterior, metadados e imagens ficam em **pastas separadas** —
o que casa direto com `--metadata` / `--images`.

## Análise prévia (feita em 2026-07-26)

**Densidade coerente com o acervo.** NN mediana 17,1 m (p10 12,6 / p90 21,0),
contra 13,1 m de mediana entre os 27 projetos existentes (faixa 11,4–27,1 m).
Fica perto de `ponta_grossa_1` (15,4) e `sao_gabriel` (18,9). 117 fotos/km²,
bbox de 3,7 × 2,6 km.

**Grafo importado:** 2,03 targets/foto, distância mediana de target 18,9 m.

**Cruzamento com os geojson da fonte:** `fotos.geojson` (1249 pts) e
`fotos_linha.geojson` (163 linhas / 1437 vértices) batem com os JSONs, com
divergência máxima de coordenada **0,000 m** e nenhum JPG sem ponto. Nada do
problema que o `santiago` teve no lote anterior — servem para a camada de linha
do PMTiles.

`mesh_rotation_y = 60` uniforme nas 1275 (não o default 180 problemático — ver
`CLAUDE.md`, seção do marcador). Todas vão precisar de calibração no viewer.

## O que precisa de tratamento: 40 metadados órfãos

**1275 JSONs para 1235 JPGs.** O `migrate.js` insere a linha em `photos` na
Fase 6 e só descobre a imagem faltando na Fase 7 (`scripts/migrate.js:846` →
`_image_errors.csv`): as 40 virariam fotos no mapa e no grafo que dão 404 no
endpoint de imagem.

Os 22 targets que apontavam para elas são descartados sozinhos
(`migrate.js:751`, `if (!targetUuid) continue`) e **nenhuma foto fica ilhada**
por causa disso.

As 40 também explicam **todas** as 16 coincidências de 0,00 m que apareceram na
análise de densidade — em todo par de fotos sobrepostas, ao menos uma ponta não
tem JPG. Filtrando: NN mínima passa a 10,55 m e **zero** pares abaixo de 5 m.

**Por isso o `--metadata` aponta para uma pasta filtrada**, com os 1235 JSONs que
têm JPG. A lista das descartadas fica em `_descartados.txt` dentro dela.

### Recriar a pasta filtrada

```js
// para cada *.json de "2 - Metadados Processados":
//   copiar se existir "3 - Frames_processados_mascara/<camera.img>.jpg"
```
O `_descartados.txt` não atrapalha: `readAllMetadata` filtra por `.json`
(`migrate.js:165`), e `.geojson` não casa com esse filtro.

## Grafo fragmentado, mas religável

5 componentes fracamente conectados: **1039 / 90 / 89 / 13 / 4**. O maior cobre
84,1%.

Distância mínima de cada ilha ao componente principal: **23,5 / 27,6 / 34,4 /
34,5 m**. O raio adaptativo da Fase 5 é `medianNN × multiplier` = 17,12 × 5 =
**86 m**, folgado o bastante para religar as quatro. O pós-flight confere que
sobrou **1 componente só**.

## Foto de entrada

`MULTICAPTURA_0000_000154` (-22,674333 / -43,719806) — cabeça da maior cadeia
`next:true` (150 fotos) **dentro do componente de 1039**. Essa restrição é a
armadilha nº 8 do lote anterior: a heurística ingênua de "primeira cabeça de
cadeia" caiu num componente de 14 fotos no `faxinal`.

Fases 3a+3b alcançam 1039/1235 já na importação; as 196 restantes entram pela
Fase 3c (órfãs, ordenadas por lat/lon) e são religadas pela Fase 5.

## Entrada no `PROJECTS`

Já adicionada e **ativa** em `scripts/migrate.js`. Centro = centroide das 1235.

```js
{ name: 'Depósito Central de Munição', slug: 'dcmun',
  description: 'Imagens panorâmicas do Depósito Central de Munição',
  capture_date: '2026-06-23', location: 'Paracambi, RJ',
  lat: -22.660976, lon: -43.714590,
  entryPhoto: 'MULTICAPTURA_0000_000154' }
```

`capture_date` é a data de **processamento** dos metadados — as imagens não têm
EXIF e os JSONs não trazem data. Ajustar se a data real da captura aparecer.

Todas as outras entradas seguem comentadas, então a Fase 2 atribui as 1235 ao
`dcmun` (centro mais próximo entre os projetos ativos, limite de 50 km).

## Rodar

Pré-flight já executado: os 1235 JPGs decodificam (100%, todos 5760×2880) e os
1275 JSONs parseiam.

Backup em `data/_backups/pre_dcmun_20260726/index.db` — 27 projetos / 90.433
fotos / 571.802 targets, `integrity_check` ok.

```bash
node scripts/migrate.js \
  --metadata "<pasta filtrada>" \
  --images   "D:/dados_ebgeo/DCMUN_StreetView/DCMUN_StreetView/3 - Frames_processados_mascara" \
  --output   "C:/Users/diniz/OneDrive/Desktop/Desenvolvimento/ebgeo_360/data" \
  --workers 4
```

Caminhos na forma `D:/...`, nunca `/d/...` — o MSYS confunde o `path.resolve` do
node e vira `C:\d\...` (armadilha nº 4 do lote anterior).

**Rodar uma vez só.** Os UUIDs são randômicos (`randomUUID`), então re-executar
duplica o projeto. Para refazer, apagar antes as linhas do slug em `photos`,
`targets`, `projects` e `photos_rowid`/`photos_rtree`, ou restaurar o backup.

## Esperado ao final

| | valor |
|---|---|
| `projects` | 28 (27 + dcmun) |
| `photos` | 91.668 (90.433 + 1.235) |
| `dcmun.db` | ~1 GB (fonte: 1,95 GB de JPG, média 1,62 MB) |
| componentes do grafo | 1 |

## PMTiles (feito em 2026-07-26)

Backup dos anteriores em `data/_backups/pmtiles_20260726/`.

**Ponto** — `npm run generate-pmtiles`: 91.668 pontos, 28 projetos. Foi preciso
corrigir `scripts/generate-pmtiles.js` antes: a imagem `tippecanoe:latest` não
define `ENTRYPOINT` (`Cmd = /bin/bash`), e o script montava o `docker run` sem
nomear o binário, então o runc tentava executar `-o` como programa.

**Linha** — 3.355 feições, origens `legado, santa_cruz, santiago, sao_gabriel,
saica, faxinal, dcmun`. Duas armadilhas:

1. O runbook antigo manda decodificar com `-Z12 -z12`, mas o `fotos_linha.pmtiles`
   atual tem **maxzoom 11** — no zoom errado o decode devolve só o cabeçalho.
   Conferir o maxzoom real antes (`tilestats` no campo `json` do decode).
2. `-zg` escolheu maxzoom **10** para a entrada nova (antes era 11), o que
   reduziria o detalhe. Encodar com `-z11` explícito.

Só o `legado` passa pelo round-trip de decode (é o único sem geojson de origem
neste PC); os 5 do lote anterior vêm de `data/_source_backup/` e o dcmun da
fonte. O decode devolve 2.479 feições legadas com duplicação de borda de tile;
a dedup só descarta quando **propriedades e geometria** são idênticas (1.745),
o que é invisível no render — deduplicar só por geometria colapsaria fragmentos
legítimos.

## Pendência: thumbnail do catálogo

`data/thumbnails/` tem 22 arquivos para 28 projetos. Faltam `dcmun` e os 5 do
lote anterior (`santa_cruz`, `santiago`, `sao_gabriel`, `saica`, `faxinal`).
`GET /api/v1/projects` emite `previewThumbnail` sempre (`src/routes/projects.js`),
exista o arquivo ou não, então o catálogo do ebgeo_web pede uma imagem que dá 404
nesses 6. Os existentes têm tamanhos irregulares (1864×945, 1798×1041, 408×306),
o que sugere recorte manual.
