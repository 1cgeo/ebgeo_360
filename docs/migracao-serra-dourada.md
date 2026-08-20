# Migração Serra Dourada (Goiânia, GO)

Runbook do lote de 2026-08, entrega do 2º CGEO, fonte
`serra_dourada_360`. Segue o ciclo dos lotes anteriores: **pré-flight → pasta
preparada → backup → migrate → pós-flight → traçado → thumbnail → entrega**.

**Processado pelo caminho ANTIGO, sem pirâmide de tiles**, porque a produção
ainda não recebeu a migração de tiles. O `generate-tiles.js` NÃO rodou. Quando a
pirâmide chegar à produção, o projeto entra na geração como os outros 29.

## A fonte

```
serra_dourada_360/
├── 151 *.json          um por foto (camera + targets)
├── 150 *.jpg           panorâmicas equirretangulares
├── fotos.geojson       151 pontos
└── fotos_linha.geojson 180 segmentos, 360 vértices
```

Metadados e imagens na MESMA pasta, como no lote do Beira-Rio.

O JSON traz três campos que o schema não carrega: `pano_id`, `address` e
`copyright` (`© 2026 Google`). O `z5` no nome do arquivo é o zoom da pirâmide de
origem. São panorâmicas do Street View, e o banco não guarda a procedência.

## O bloqueador: o WebP para em 16383 px

A fonte veio em **16384x8192 (80 fotos)** e **13312x6656 (70)**, muito acima dos
5760x2880 e 7680x3840 do acervo.

O `migrate.js` converte o `full` no tamanho NATIVO (Fase 7,
`webp({ quality: 80 })`). O WebP guarda a dimensão em 14 bits, e o teto é 16383.
As 80 fotos de 16384 px falham com `Processed image is too large for the WebP
format`: entrariam em `photos`, apareceriam no mapa e no grafo, e dariam 404 no
endpoint de imagem. É o modo de falha do DCMun (40 metadados órfãos), por outra
causa.

Medido numa foto de 16384x8192, com o sharp do próprio repositório:

| destino | WebP | tempo | textura RGBA na GPU |
|---|---|---|---|
| 16383x8191 | 7,63 MB | 37 s | 537 MB |
| 13312x6656 | 5,34 MB | 18 s | 354 MB |
| 8192x4096 | 2,53 MB | 3,1 s | 134 MB |
| 7680x3840 | 2,25 MB | 2,9 s | 118 MB |

**Decisão do chefe: 7680x3840.** É o maior formato que o acervo já serve, e sem
pirâmide o visualizador baixa o `full` inteiro e sobe UMA textura por foto. A
16383 a razão 2:1 se quebra, que é o que a matemática de UV do visualizador
assume. A fonte fica guardada: reingerir em resolução maior é um comando, depois
que a pirâmide chegar à produção.

## Pasta preparada

`serra_dourada_prep` — 150 JPG em 7680x3840 (JPEG q95, 4:4:4, lanczos3) mais os
150 JSON correspondentes. Total de 1,22 GB, média de 8,13 MB.

Um metadado fica de fora, por não ter JPG, e o nome está em `_descartados.txt`:
`goiania-goias_2019-04_z5_kieXS4L281aX`. Os 4 alvos que apontavam para ele são
descartados sozinhos pelo `migrate.js` (`if (!targetUuid) continue`), e nenhuma
foto fica ilhada.

Conferido relendo os 150 arquivos do disco: 150 em 7680x3840, pareamento exato
com os 150 JSON.

## Análise prévia

**Densidade coerente com o acervo.** NN mediana 10,0 m (mínima 2,36 m, p90
10,9 m), contra 13,1 m de mediana entre os 29 projetos. Zero pares sobrepostos,
diferente do DCMun. Bbox de cerca de 410 x 435 m em torno do Estádio Serra
Dourada.

**O lote mistura CINCO campanhas do Street View:** 2015-08 (3 fotos), 2017-02
(6), 2018-10 (12), 2018-11 (49) e 2019-04 (80). Não é acervo empilhado no mesmo
ponto: a rota atravessa trechos que o Google fotografou em anos diferentes.

**Grafo entregue, e ele basta.** 340 alvos, dos quais 336 sobrevivem ao descarte
do órfão, fechando UM componente só com as 150 fotos. Seis alvos vêm marcados
`ponte` (ligação entre campanhas) e 18 vêm marcados `manual`.

**Rodar com `skipTargets`.** A Fase 5 usaria raio de 50 m (10,0 x 5) e ligaria
foto de 2015 a foto de 2019 por proximidade, sem critério de campanha. A
curadoria do 2º CGEO é a fonte.

**`mesh_rotation_y` distinto em todas as 151** (nada de valor uniforme como o
`mesh_rotation_y = 60` do DCMun). A orientação vem calculada da origem. O
`resolveMeshRotation` respeita ângulo explícito, então nada é sobrescrito.

## Entrada no `PROJECTS`

Já adicionada e **ativa** em `scripts/migrate.js`. Centro = centroide das 150.

```js
{ name: 'Estádio Serra Dourada', slug: 'serra_dourada',
  description: 'Imagens panorâmicas do entorno do Estádio Serra Dourada',
  capture_date: '2019-04-01', location: 'Goiânia, GO',
  lat: -16.698887, lon: -49.234559,
  entryPhoto: 'goiania-goias_2018-11_z5_LeUhNMDBpvH3', skipTargets: true }
```

`capture_date` traz a campanha mais recente e mais numerosa. A data do dia não
existe na fonte, que datou por mês.

`entryPhoto` é a cabeça da maior cadeia `next` (49 passos), dentro do componente
principal, que aqui é o único. Ela é de 2018-11, e não da campanha mais nova.

As entradas de `beira_rio` e `aman` ficaram ativas, e isso não fez efeito: a
Fase 2 atribui pelo centro mais próximo com limite de 50 km, e as duas ficam a
mais de 900 km. Sem foto atribuída, o `migrate.js` pula o projeto
(`if (!seq || seq.length === 0) continue`).

## Rodar

Backup em `data/_backups/pre_serra_dourada_20260820/index.db` — 29 projetos,
99.040 fotos, 625.387 alvos, 99.035 linhas de rtree, `integrity_check` ok.

```bash
node scripts/migrate.js \
  --metadata "<pasta preparada>" \
  --images   "<pasta preparada>" \
  --output   "<raiz>/ebgeo_360/data" \
  --workers 4
```

Caminhos na forma `D:/...`, nunca `/d/...`. **Rodar uma vez só**: os UUIDs são
randômicos, e re-executar duplica o projeto.

Terminou em 99,4 s, com 150 imagens processadas e 0 erros.

## Pós-flight

| | esperado | medido |
|---|---|---|
| `projects` | 30 | 30 |
| `photos` | 99.190 | 99.190 |
| `targets` | 625.723 | 625.723 |
| `photos_rtree` | 99.185 | 99.185 |
| fotos do projeto | 150 | 150 |
| alvos do projeto | 336 (340 menos os 4 do órfão) | 336, todos `is_original` |
| componentes do grafo | 1 | 1 |
| `serra_dourada.db` | — | 322 MB, 150 blobs, média de 2,12 MB no `full` |

O esperado de fotos e de alvos foi contado nos JSON da pasta preparada, e não
copiado da saída do `migrate.js`.

Conferências que podiam reprovar, e não reprovaram:

- **Campo a campo contra a fonte:** `lat`, `lon`, `heading` e `mesh_rotation_y`
  iguais nas 150.
- **Os 29 projetos antigos:** `photo_count` de todos conferido contra o valor de
  antes, zero divergência.
- **Blobs:** zero foto do índice sem linha de imagem, zero divergência entre
  `full_size_bytes`/`preview_size_bytes` e o comprimento do blob.
- **Os 150 WebP gravados decodificam**, todos em 7680x3840.
- **Prova de pixel contra a fonte**, em 6 fotos (3 de cada classe de origem):
  erro médio de 0,89 a 1,64 em 255. O controle negativo, a mesma foto espelhada,
  deu de 17,95 a 51,71. O instrumento reprova.
- `integrity_check` ok e `foreign_key_check` limpo.
- Consulta espacial de verdade na bbox de Goiânia devolve as 150.

## Traçado

`fotos_linha.geojson` copiado para
`data/_source_backup/serra_dourada_fotos_linha.geojson`, que é a primeira fonte
do `import-tracks.js`.

As 180 linhas foram inseridas em `project_tracks` SÓ para este projeto, em vez de
rodar o `import-tracks.js` inteiro. A razão: `data/_source_backup/` não existia
nesta máquina, então o script cairia no `fotos_linha.pmtiles` para os outros 29
projetos, apagando e reescrevendo as 3.236 linhas deles a partir da geometria
recortada dos tiles. Conferido depois: 3.416 linhas no total, 180 do
`serra_dourada`, geometria idêntica à da fonte, nenhum outro projeto alterado.

## Thumbnail

`data/thumbnails/serra_dourada.webp`, 1600x900, 113 KB. Recorte da banda do
horizonte da foto de entrada, deslocado 60 graus para o estádio entrar no quadro.

Nota de estado: a pasta `data/thumbnails/` tem só 3 arquivos para 30 projetos
(`beira_rio`, `museu_cms` e agora `serra_dourada`). O `GET /api/v1/projects`
emite `previewThumbnail` sempre, então o catálogo do ebgeo_web pede imagem que dá
404 nos outros 27.

## As rotas foram acionadas

Serviço subido na porta 8081 contra este `data/`:

| rota | resultado |
|---|---|
| `/health` | `{"status":"ok","projects":30}` |
| `/api/v1/projects` | 30 projetos, o `serra_dourada` com 150 e a thumbnail |
| `/api/v1/projects/serra_dourada` | centro e data conferem |
| `/api/v1/thumbnails/serra_dourada.webp` | 200, `image/webp`, 1600x900 |
| `/api/v1/photos/:uuid` | `projectSlug` certo, 2 alvos, `heading` igual ao banco |
| `/api/v1/photos/:uuid/image?quality=full` | 200, WebP 7680x3840, bytes iguais a `full_size_bytes`, cache imutável |
| `/api/v1/photos/:uuid/image?quality=preview` | 200, 512x256 |
| `/api/v1/photos/by-name/:nome` | 200 |
| `/api/v1/photos/nearest` | devolve `Serra_Dourada_0020` |
| `/api/v1/tiles/fotos/12/1487/2240.pbf` | 200, 22.811 bytes, 150 feições, todas do projeto |
| `/api/v1/tracks` | 3.416 feições, 180 com `origem = serra_dourada` |

O tile foi decodificado com `@mapbox/vector-tile`, implementação separada do
`vt-pbf` que o encodou.

## Entrega para o server7

O que precisa atravessar:

1. `data/projects/serra_dourada.db` (322 MB)
2. `data/thumbnails/serra_dourada.webp` (113 KB)
3. As linhas novas do `index.db`: 1 projeto, 150 fotos, 336 alvos, 150
   `photos_rowid`, 150 `photos_rtree`, 180 `project_tracks`

**O `index.db` daqui NÃO pode ser copiado por cima do de produção sem decidir
antes.** Ele é compatível (a poda do `full` não tocou nele: os `full_size_bytes`
das 99.040 continuam lá), mas toda calibração feita na produção desde a última
sincronização se perde. Se houve escrita lá, o caminho é o TRANSPLANTE, como no
Beira-Rio (Decisions 2026-08-10):

- a ordem das chaves estrangeiras não é escolha: `capture_runs` antes de
  `photos`, porque `photos.run_id` referencia `capture_runs(id)`. Este lote não
  tem faixas, então a ordem é `projects` → `photos` → `photos_rowid` →
  `photos_rtree` → `targets` → `project_tracks`;
- **`photos_rowid` é AUTOINCREMENT e indexa o rtree.** O id tem de ser atribuído
  pelo DESTINO, e as linhas do rtree remapeadas para ele. Copiar o id como está
  colide;
- conferir na mesma extensão da escrita: 150 fotos, 336 alvos, 150 linhas de
  rtree, uma consulta espacial de verdade, `integrity_check`,
  `foreign_key_check` e a contagem dos 29 projetos antigos, que não pode mudar.

Depois, subir pela skill `atualizar-dockers`.

## Pendências

- **A convenção de orientação não foi confirmada contra o visualizador.** O
  `mesh_rotation_y` vem calculado da origem, e nunca um lote com essa procedência
  entrou no acervo. O horizonte da foto de entrada está nivelado no recorte da
  thumbnail, o que é indício e não prova. O CQ é abrir uma foto por campanha na
  tela de calibração e ver se o marcador do vizinho cai sobre o caminho. Cinco
  fotos resolvem, uma por campanha.
- **`captured_at` ficou nulo nas 150.** A fonte data por mês (`captura`,
  `AAAA-MM`), e a coluna guarda `AAAA-MM-DDTHH:MM:SS`. Gravar o dia 1 às 00:00
  inventaria dia e hora; deixar nulo perde a campanha, que hoje só vive no nome
  do arquivo original. O `import-captured-at.js` não lê o campo `captura_img` do
  geojson desta entrega.
- **`capture_runs` vazio.** O `derive-runs.js` reconhece `MULTICAPTURA_*` e
  `PIC_*`, e o nome daqui (`goiania-goias_AAAA-MM_z5_<pano_id>`) não casa com
  nenhum dos dois. Sem faixa, o CQ por faixa da calibração não se aplica a este
  projeto.
- **Sem pirâmide de tiles**, por decisão deste lote.

## Edições depois da importação (2026-08-20)

O projeto entrou como `Serra Dourada` e foi **renomeado para `Estádio Serra
Dourada`** por decisão do chefe, direto em `projects.name`, porque não há rota de
escrita para o nome. A entrada do `PROJECTS` foi renomeada junto.

**O `display_name` das fotos NÃO mudou, e continua `Serra_Dourada_NNNN`.** Ele
nasce do `name` do projeto na Fase 4 (`generateUUIDs`), na importação. Uma
re-migração com o nome novo produziria `Estadio_Serra_Dourada_NNNN`, então o
rótulo das fotos e o nome do projeto divergem a partir daqui.

**Três fotos foram apagadas** pela rota `DELETE /api/v1/photos/:uuid`, que é
soft-delete: a linha fica em `photos`, ganha lápide em `deleted_photos` e some
das consultas.

| foto | campanha | alvos removidos |
|---|---|---|
| `Serra_Dourada_0052` | 2015-08 | 2 |
| `Serra_Dourada_0087` | 2017-02 | 2 |
| `Serra_Dourada_0135` | 2018-10 | 5 |

O grafo foi simulado ANTES de apagar: as 147 restantes seguem num componente só,
e nenhuma foto fica sem ligação. Conferido depois de apagar, com o mesmo
critério. O `photo_count` do projeto foi para 147 pela própria rota, as três dão
404 em `/photos` e em `/image`, e o tile `12/1487/2240` passou a trazer 147
feições.

Os 9 alvos que sumiram eram todos `is_original = 1`, isto é, vieram da entrega.
Nenhum alvo criado a mão se perdeu.

## A calibração, feita pelo chefe na tela (2026-08-20)

Com o serviço no ar contra este `data/`, o chefe calibrou o lote pela tela de
calibração. O estado final das 147 vivas:

| | |
|---|---|
| `mesh_rotation_y` | **180 em todas**, aplicado por `batch-calibration` |
| `calibration_source` | `manual` nas 147, valor que PROTEGE contra recalibração |
| revisadas | 112 de 147 |
| alvos | 327 da entrega mais **105 criados a mão** |

**A orientação por foto que veio da fonte foi substituída.** Os 151 valores
distintos de `mesh_rotation_y` (285,73 na primeira, 260,79 na segunda, e assim
por diante) deram lugar a um 180 uniforme. Foi decisão do chefe, conferida por
amostragem na tela. Os valores de origem continuam nos JSON da pasta preparada,
caso um dia seja preciso voltar atrás.

## O transplante para o index.db de produção (2026-08-20)

O `index.db` de produção estava numa pasta de rede, e o projeto entrou nele por
TRANSPLANTE, não por cópia do arquivo inteiro.

**A cópia inteira teria funcionado, e mesmo assim não foi o caminho.** Comparei o
arquivo de produção contra o backup local de antes da importação: mesmas
contagens, e **zero diferença em 99.040 fotos e nos 29 projetos**, campo a campo
(rotações, revisada, fonte da calibração, coordenadas, hora, faixa). Os md5
diferem só por leiaute de página. Ainda assim o transplante é o caminho, porque
só ACRESCENTA linha, e a prova de que os dois estavam iguais vale para o
instante em que foi medida, não para o próximo lote.

O que atravessou: 1 projeto, 150 fotos (147 vivas mais 3 lápides), 432 alvos,
147 linhas de `photos_rowid` e de `photos_rtree`, 180 traçados. Nenhuma faixa e
nenhum andar, que este projeto não tem.

**O `photos_rowid` é AUTOINCREMENT e indexa o rtree**, então o id nasceu NO
DESTINO e as linhas do rtree foram remapeadas para ele. Na produção o contador
estava em 104.438, e os 147 novos vieram depois disso, sem colisão.

O trabalho virou `scripts/transplantar-projeto.js`, que leva QUALQUER projeto de
um `index.db` a outro. Ele roda em duas passadas: sem `--aplicar` faz o ENSAIO,
que monta o payload real, escreve de verdade dentro de uma transação, roda as 25
conferências e então DESFAZ. Só o commit muda entre o ensaio e a gravação, e
qualquer reprovação desfaz tudo sozinha.

A gravação em produção foi feita pelo antecessor de uso único deste script. O
promovido foi conferido depois contra uma CÓPIA do arquivo de produção original,
e o ensaio dele devolveu exatamente os números que estão hoje no arquivo. O
caminho de faixas e andares, que este lote não exercita (tem zero dos dois),
foi exercitado transplantando o `beira_rio` (7 faixas, 7 andares, 350 fotos,
1.384 alvos) para um banco vazio criado do `schema.sql`.

**A conferência espacial reprovou por engano, e o motivo virou comentário no
código.** O R*Tree do SQLite guarda coordenada em float32, arredondando o mínimo
para baixo e o máximo para cima. Medido aqui: o `min_lon` cai até 6,6e-6 grau
abaixo do `lon` da foto. Uma margem de 1e-6 na consulta reprova por
arredondamento, e não por linha faltando. A margem passou a 1e-3 grau, cerca de
100 m, que ainda reprova linha ausente ou posta no lugar errado.

As conferências, todas contra o arquivo depois da escrita: as sete contagens
(+1, +150, +432, +147, +147, +3, +180), o nome do projeto, o `photo_count` 147,
as fotos vivas, os alvos, o rtree do projeto, uma consulta espacial de verdade
na bbox de Goiânia, os traçados, o rowid sem colisão, a foto de entrada viva,
zero alvo apontando para foto inexistente, `integrity_check`,
`foreign_key_check`, os 29 projetos antigos byte a byte iguais, e o grafo num
componente de 147.

Depois da gravação: `wal_checkpoint(TRUNCATE)`, o arquivo fechado sem `-wal` nem
`-shm`, copiado para a rede, e **relido NO DESTINO pela rede** — mesmo md5 dos
dois lados, e a bateria de contagens repetida lendo o arquivo de lá.

Foram junto, na mesma pasta de rede, o `projects/serra_dourada.db` (322 MB, 150
blobs, o primeiro decodificando em WebP 7680x3840, lido de lá) e o
`thumbnails/serra_dourada.webp`. Sem esses dois o projeto entra no catálogo e no
mapa, mas nenhuma foto abre.

O arquivo de produção ANTES do transplante está guardado em
`data/_backups/producao_20260820/index.db.original`, md5 `6313a5ae7320ff5c2dc1a90a2180e34a`.
