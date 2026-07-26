# Substituição do AMAN (lote 2026-07)

O projeto `aman` (5.312 fotos, importado em 2024) foi **substituído** pelo lote
`D:\dados_ebgeo\streetviewaman` (11.756 fotos). Não é um dataset concorrente: é
a mesma captura reexportada, mais duas campanhas novas.

## A prova de que substitui

- **2.219 nomes em comum** com o projeto antigo, e **1.858 deles com coordenada
  idêntica** (< 1 cm; diferença mediana de elevação 0,00 m).
- Os 8 prefixos `MULTICAPTURA_*` do projeto antigo estão entre os 24 do novo.
- O `time_img` do `fotos.geojson` mostra três campanhas:

  | data | fotos |
  |---|---|
  | 2024-04-23 | 2.386 — a captura que virou o AMAN antigo |
  | 2025-09-09 a 09-12 | 8.160 |
  | 2025-11-06 | 1.788 |

- 89,7% das fotos antigas têm substituta a menos de 10 m; 97,6% a menos de 100 m.
- 53,4% das fotos novas estão a mais de 100 m de qualquer foto antiga.
- Densidade equivalente: NN mediana 12,68 m (novo) contra 12,57 m (antigo).
  Resolução idêntica: 5760×2880 nos dois.
- bbox cresce de 8,5 × 10 km para **41 × 21 km**.

## O que se perdeu

Nada de trabalho humano: **zero** fotos revisadas, **zero** targets ocultos,
**zero** overrides, e nenhuma linha de `deleted_photos` era do AMAN.

Somem os 4.764 valores de `mesh_rotation_z` do `estimate-slope-roll.js`, cuja
abordagem o `CLAUDE.md` marca como depreciada. Estão preservados em
`data/_source_backup/aman_metadata.json`.

**126 fotos antigas (2,4%) não têm cobertura nova a menos de 100 m**, em 7
bolsões — o maior com 82 fotos em torno de -22,44852 / -44,46233, todos a
110–250 m da cobertura nova. Imagens preservadas em
`data/_backups/pre_aman_20260726/aman_old.db`.

## Backups

| o quê | onde |
|---|---|
| `index.db` antes de tudo | `data/_backups/pre_aman_20260726/index.db` |
| metadados do AMAN antigo | `data/_source_backup/aman_metadata.json` (5.312 fotos + 35.557 targets, por `original_name`, não por UUID — reconstruível) |
| imagens do AMAN antigo | `data/_backups/pre_aman_20260726/aman_old.db` (3,38 GB, movido — não copiado) |

## Os três problemas da fonte, e o que os geojson resolveram

A pasta traz `fotos.geojson` + `fotos_linha.geojson` e os equivalentes em
GeoPackage (`estrutura.gpkg` = pontos, `conexao.gpkg` = linhas; mesmo conteúdo).

### 1. Sem `mesh_rotation_y` — não resolvido

Os campos de `camera` nos JSONs são só `id, img, lon, lat, ele, heading`, e não
há rotação em nenhum dos geojson/gpkg. As 11.756 caem no default histórico 180.
Não é regressão (o AMAN antigo já estava em 180 nas 5.312), mas passam a ser
11.756 fotos descalibradas em vez de 5.312.

### 2. `next` ausente — RESOLVIDO pela linha

Só 11.601 dos 24.938 targets traziam o campo `next`. O `fotos_linha.geojson` é a
trilha real de captura: **12.927 vértices, 100% coincidem com uma foto** a menos
de 0,5 m; 445 segmentos, 12.483 pares consecutivos, passo p10 11,1 / mediana
13,5 / p90 19,1 m, com apenas 2 saltos acima de 100 m.

O grafo dos JSONs é **superconjunto estrito** da trilha — 23.706 arestas nos
dois, 1.232 só no JSON, **zero só na trilha** — então dá para derivar o sucessor
de cada foto da geometria e injetar `next` sem inventar aresta nenhuma.
Resultado: 11.674 targets marcados.

> **Armadilha:** ordenar por `faixa_img` + `numero_img` **não** dá a sequência
> (passo p90 de 5,4 km). Uma faixa não é contígua — são 445 segmentos para 143
> faixas — e o `time_img` discorda do `numero_img` em 753 fotos. A sequência
> confiável é a geometria da linha, não os números.

### 3. Targets quilométricos — resolvido, mas não como parecia

206 targets passam de 100 m (máximo 23 km). Nenhum liga fotos adjacentes: 184
ligam faixas diferentes e 22 saltam mais de 3 posições. Parecia lixo puro.

**Mas eles são as pontes entre as faixas.** Filtrar todos estilhaça o grafo: o
maior componente cai de 100% para 40,5%, e o raio da Fase 5 (63 m) não religa
nada — as ilhas ficam a mais de 240 m umas das outras.

A solução é um filtro que **preserva pontes**: união-busca com as arestas curtas
primeiro, depois os longos em ordem crescente de distância, mantendo só os que
unem componentes (Kruskal). Sobram **20 pontes** e caem **166 longos
redundantes**, com a conectividade intacta.

| filtro | maior componente |
|---|---|
| todos os targets | 100,0% |
| **só pontes (adotado)** | **100,0%** |
| corte em 2000 m | 90,8% |
| corte em 500 m | 89,1% |
| corte em 100 m | 40,5% |

## Preparo da pasta de metadados

`prep-aman.mjs` (scratchpad da sessão) lê `Metadados/`, e para cada JSON:

1. descarta se não houver JPG correspondente (na prática: 0 — os 583 JPG a mais
   é que não têm JSON);
2. descarta targets longos que não sejam ponte;
3. marca `next: true` no sucessor da trilha, `false` nos demais.

Foto de entrada: `MULTICAPTURA_7674_000990`, cabeça da maior cadeia (1.443
fotos) dentro do maior componente.

## Entrada no `PROJECTS`

```js
{ name: 'Academia Militar das Agulhas Negras', slug: 'aman',
  description: 'Imagens panorâmicas da Academia Militar das Agulhas Negras',
  capture_date: '2025-11-06', location: 'Resende, RJ',
  lat: -22.439251, lon: -44.380062,
  entryPhoto: 'MULTICAPTURA_7674_000990' }
```

Centro = centroide das 11.756 (o antigo era -22,46019 / -44,450328, deslocado
porque a cobertura mudou muito). `capture_date` = a campanha mais recente das
três.

## Ordem da execução

```
1. backup do index.db + export do aman_metadata.json
2. mv data/projects/aman.db -> data/_backups/pre_aman_20260726/aman_old.db
3. DELETE das linhas do aman em photos_rtree, targets, deleted_photos,
   photos_rowid, photos, projects (nessa ordem, numa transação)
4. node scripts/migrate.js --metadata <pasta preparada> \
     --images "D:/dados_ebgeo/streetviewaman/Imagens" --output ./data --workers 4
5. posflight-aman.mjs
6. npm run generate-pmtiles + camada de linha (ver docs/migracao-dcmun.md)
```

O passo 3 removeu exatamente 1 projeto / 5.312 fotos / 35.557 targets / 5.312
`photos_rowid` / 5.312 `photos_rtree`, deixando zero órfãos.

## Ensaio antes de executar

Rodado com `--skip-images` num `--output` descartável: 11.756 fotos, sequência
contígua, 75.286 targets (24.772 originais + 50.514 espaciais), 11.674 `is_next`,
0 dangling, **1 componente, 100% alcançável a partir da entrada**. Distância dos
targets: mediana 27,3 / p90 47,2 / máx 14.097 m (32 acima de 1 km — as pontes).
O AMAN antigo tinha mediana 29,6 / p90 48,6 / máx 1.638 m, também 1 componente.
