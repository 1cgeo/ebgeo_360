# Migração da Missão Porto União (5º BE Cmb Bld, 5º RCC e CIMH)

Runbook do lote de 2026-08, 5.151 panorâmicas de viatura em três projetos. Segue
o ciclo dos lotes anteriores: **pré-flight → pasta preparada → backup → migrate →
pós-flight → hora e faixas → traçado → pirâmide → miniatura → calibração →
transplante para a produção**.

Rodado em 2026-09-21, no `data/` desta máquina, e levado à produção por
`transplantar-projeto.js`, projeto a projeto.

## A fonte

Uma pasta por OM, e dentro dela três subpastas:

```
<OM>_METADADOS/
├── N *.json               um por foto (camera + targets + datetime)
├── N *.jpg                panorâmica com o NADIR tapado, 7680x3840, sem EXIF
├── N *_original.jpg       a saída da câmera, com EXIF, mesmo formato
├── fotos.geojson          N pontos, com a geometria ajustada no QGIS
└── fotos_linha.geojson    as conexões desenhadas, LineString
<OM>_PROCESSADOS/          todas as costuradas (o METADADOS é a seleção)
<OM>_DADOS_BRUTOS/PIC_*/   origin_<disparo>_<lente>_*.jpg, gyro.mp4, pro.prj
```

Insta360 Pro2, série `IP2E30FN7S8MDX`, a mesma de Cascavel e da ExpoEx.

| projeto | fotos | captura | centro a | vizinha (mediana) |
|---|---|---|---|---|
| `5o_becmb` | 133 de 1.183 processadas | 2026-08-17, 11:24 a 12:04 | Porto União, SC | 12,1 m |
| `5o_rcc` | 81 de 567 | 2026-08-15, 14:51 a 15:06 | Rio Negro, PR | 13,2 m |
| `cimh` | 4.937 de 11.957 | 2026-08-12 a 14, 15 sessões | Três Barras, SC | 10,7 m |

O pareamento fecha exato nos três (JSON, `.jpg` e `_original.jpg`), nenhum alvo
aponta para foto ausente, nenhuma posição se repete, e nenhum dos 5.151 nomes
colide com as 101.038 fotos que já estavam no `index.db`. Os centros distam 49 km
(RCC para CIMH), 81 km e 129 km, e cada foto fica a menos de 17 km do próprio
centro, então o raio de 50 km não mistura projeto.

## A pasta preparada da CIMH

`data/_preparado/cimh/`. As outras duas entram como vieram. O registro do que
mudou fica FORA da pasta, em `data/_preparado/cimh_preparacao.json`, porque o
`migrate.js` lê todo `.json` da pasta de metadados.

1. **12 fotos com a coordenada de antes do ajuste no QGIS** (0,9 a 13,1 m), o
   mesmo defeito da ExpoEx. A geometria do `fotos.geojson` manda: ela cai no
   vértice do traçado em 4.937 de 4.937, contra 4.925 pela coordenada do JSON.
   Corrigidos a câmera das 12, os 45 alvos que apontam para elas e o heading de
   16 fotos, pelo DELTA do rumo ao `next` (o heading da entrega é o rumo ao
   `next`, 0,28° de mediana). A conferência reprova o estado anterior com
   13,05 m.
2. **52 fotos subexpostas, de 2424 a 2475 da sessão `PIC_20260812_145732`.** A
   exposição automática travou em 1/8192 s (ISO 100) das 16:18:29 às 16:20:40,
   em dia encoberto, contra 1/100 s na foto anterior; a 2475 é a saída
   (1/1727 s). O bruto das seis lentes também chegou escuro (62 a 65 níveis),
   então não há fonte melhor. Entram CLAREADAS só com o que a câmera gravou:
   média local onde há poucos níveis, ganho em luz linear tirado do EXIF (leva
   1/8192 s a cerca de 1/170 s), curva que levanta a sombra, e o tapa-nadir
   reaplicado com a `mascara_vtr_tubarao.png` do plugin, que reproduz a máscara
   entregue a 0,33 nível de diferença média. O chão fica cinza, sem cor
   inventada: decisão do chefe entre as duas versões.

Uma varredura de luminância nas 5.151 pegou as 52 e mais 8 da CIMH, todas de
contraluz com o sol no quadro, em que a câmera fechou o obturador de propósito e
a imagem é legível. Essas ficaram como vieram.

## Backup

`data/_backups/pre_portouniao_20260921/index.db`, pela API de backup do SQLite:
`integrity_check` ok, 36 projetos, 101.038 fotos, 635.988 alvos.

## A migração

```bash
node scripts/migrate.js --metadata data/_preparado/<slug> --images data/_preparado/<slug> \
  --output data --tracks data/_preparado/<slug>/fotos_linha.geojson
```

Antes, a ExpoEx foi comentada no `PROJECTS` (ela estava ativa e duplicaria).

Ensaio só de metadados, num diretório descartável, para medir o grafo depois da
Fase 5: a CIMH chega em 16 componentes, todos a 1,0 a 17,7 m de outro, e a guarda
do traçado costura para 2 (4.935 fotos e uma ilha de 2, a 10 m do resto). O
5o_becmb e o 5o_rcc ficam em 1. A diferença de 4 alvos originais da CIMH (8.798
no JSON, 8.794 no banco) são pares repetidos dentro do próprio JSON.

| projeto | tempo | erros de imagem | alvos (originais + espaciais) |
|---|---|---|---|
| `5o_becmb` | 85 s | 0 | 651 (268 + 383) |
| `5o_rcc` | 53 s | 0 | 432 (160 + 272) |
| `cimh` | 52 min | 0 | 30.177 (8.794 + 21.383) |

## Pós-flight

`node scripts/conferir-migracao.js --data data --antes <backup> --slug <slug>
--pasta <pasta preparada>`: projetos anteriores intocados (contagem e centro),
acréscimo exato de fotos, lat/lon/ele/heading/mesh_rotation_y contra o JSON em
todas, `sequence_number` sem furo, todo alvo do JSON no banco, e todo blob
decodificando em 7680x3840 e 512x256 com o tamanho gravado. Aprovado nos três
(5.151 fotos, 25.755 campos). Conferir o 5o_rcc contra a pasta do 5o_becmb
reprova com 135 falhas, que é o controle negativo.

## Hora, faixas e traçado

```bash
node scripts/import-captured-at.js --data data --sources data/_preparado/<slug> --slug <slug>
node scripts/derive-runs.js --data data --slug <slug>
cp data/_preparado/<slug>/fotos_linha.geojson data/_source_backup/<slug>_fotos_linha.geojson
node scripts/import-tracks.js --data data --slug <slug>
```

1, 1 e 13 faixas; 38, 5 e 703 linhas de traçado.

## Pirâmide de tiles

Razão 1,6 (formato 7680). 5o_becmb: 27.265 tiles, 404 MB em disco, 123 s;
5o_rcc: 16.605 tiles, 324 MB, 84 s. Conferência de tiles, bytes e grade OK.

## Miniatura

Vista retilínea de 100° de FOV, 1600x900, da foto de entrada, olhando 14° acima
do horizonte para tirar a caçamba borrada. A entrada da CIMH é a 0715, e não a
cabeça da cadeia (0714), que é contraluz escura.

## Calibração

O lote chegou com `mesh_rotation_y = 60` fixo. Ver a skill
`calibrar-orientacao-360` do vault.

- **5o_becmb e 5o_rcc**: o ramo do sol parou por uma foto (29 com sol e rumo
  utilizável, contra o mínimo de 30). O ramo do grafo, ancorado em 5 e 3
  detecções de sol, foi REPROVADO pelo juiz de visão (rua a +14° e +33,5°), o
  mesmo viés de âncora contaminada do `cmd_4a_bda_inf`. A constante corrigida
  pelo desvio foi confirmada em fotos NOVAS por juízes cegos: 5o_becmb 325,9
  (+2°, 7 de 7 a 10° ou menos) e 5o_rcc 145,8 (-1° na terceira rodada, 11 de 11).
  Gravado com `gravar_y.py`: foto apoiada pelo grafo recebe o grafo deslocado
  pela correção (`grafo+visao`, 35 e 50), as demais a constante (`proj+visao`,
  98 e 31). Releitura 214 de 214, e o `provar_marcador.py` põe as 12 vistas em
  rua ou passagem. Com o `y = 60` de lote o marcador errava de 47° a 108°.
- **`cimh`**: ver abaixo.

## Transplante para a produção

Por projeto, com o serviço no ar e restart no fim:

1. Snapshot do `index.db` local pela API de backup (o WAL da calibração entra).
2. Backup do `index.db` de produção pela API de backup, dentro do container.
3. `transplantar-projeto.js --slug <slug> --origem <snapshot> --destino /data/index.db`
   em ensaio (23 conferências, desfeito), depois com `--aplicar`.
4. Pirâmide e miniatura no lugar, com dono `administrador`, e md5 conferido.
5. `docker restart ebgeo-360`, e conferência independente do destino contra a
   origem e contra o backup.

5o_becmb e 5o_rcc em produção em 2026-09-21: 214 fotos, 3.852 campos, 1.083
alvos, 43 traçados, R-tree completo, 36 projetos antigos intocados. Projeto,
miniatura, foto, descritor, tile, marcador (as 81 fotos do RCC no tile 12/1481/2355),
traçado e `nearest` respondem pelo nginx.
