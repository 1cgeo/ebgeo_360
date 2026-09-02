# Migração EXPOEX 2026 (Cais Mauá, Porto Alegre)

Runbook do lote de 2026-08, 101 panorâmicas da Exposição do Exército no Cais
Mauá. Segue o ciclo dos lotes anteriores: **pré-flight → pasta preparada →
backup → migrate → pós-flight → traçado → thumbnail → entrega**.

Rodado em 2026-09-02, no `data/` desta máquina, que é cópia de teste. A produção
está no servidor e recebe o lote em passo separado.

## A fonte

```
CAIS_METADADOS/
├── 101 *.json               um por foto (camera + targets + datetime)
├── 101 *.jpg                panorâmicas com o NADIR tapado, 7680x3840
├── 101 *_original.jpg       a saída da câmera, com EXIF, mesmo formato
├── 102 *.aux.xml            sidecar do GDAL, ruído para a migração
├── fotos.geojson            101 pontos
└── fotos_linha.geojson      182 linhas
```

Ao lado, `DADOS QGIS - Posicionamento das imagens/` com as camadas de trabalho:
`imagens_processadas.gpkg` (as 101), `todas_imagens.shp` (116), `conexao.shp`
(182) e `imagens_adicionais.shp` (16).

Metadados e imagens na MESMA pasta, como no Beira-Rio, em Cascavel e no Serra
Dourada. Insta360 Pro2, série `IP2E30FN7S8MDX`, a mesma de Cascavel. Captura em
2026-08-23, das 13:11:45 às 14:46:25. Área de 230 m de diagonal, com mediana de
5,1 m entre vizinhas.

O pareamento fecha exato: 101 JSON contra 101 JPG, zero sobra dos dois lados, e
nenhum dos 101 nomes colide com as 100.937 fotos que já estavam no `index.db`.

### Qual JPG entra

A `.jpg` e a `_original.jpg` têm o mesmo 7680x3840. A diferença mora no oitavo
inferior da imagem: é o NADIR tapado, com o brasão da DSG e um borrão sobre o
operador. O `migrate.js` monta o caminho como `${originalName}.jpg`, então pega
a tapada, que é a certa.

**O tapa-nadir apagou o EXIF.** A `.jpg` tem zero tag; a `_original.jpg` tem 6
mais o IFD de GPS e o XMP com o bloco GPano. Guarde as originais: quem for
calibrar precisa delas. O XMP não ajuda no rumo, porque traz
`PoseHeadingDegrees="0"` e nenhum `PosePitch`/`PoseRoll`.

## O bloqueador: a entrega traz a coordenada de ANTES do ajuste

O posicionamento foi ajustado à mão no QGIS, mas só a GEOMETRIA do
`imagens_processadas.gpkg` andou. Os atributos `long_img`/`lat_img`, de onde os
JSON nasceram, ficaram na posição anterior.

| medida | valor |
|---|---|
| fotos com diferença acima de 0,5 m | 82 de 101 |
| diferença mediana | 3,06 m |
| diferença máxima | 15,65 m |
| distância mediana ao vizinho | 5,1 m |

O erro é da ordem do espaçamento entre fotos, então põe o marcador na posição
errada no mapa e no visualizador.

**Quem manda é a geometria, e a prova é o traçado.** Os 101 pontos da geometria
coincidem com vértices do `fotos_linha.geojson` na precisão cheia, 101 de 101,
contra 17 de 101 pelo atributo. O afastamento ao traçado é 0,00 m em todos pela
geometria, contra p50 de 1,14 m e máximo de 15,66 m pelo atributo.

Confirmado pelo chefe em 2026-09-02: o ajuste foi manual e a geometria é a boa.

## A pasta preparada

`data/_preparado/expoex_2026/`, com as 101 imagens tapadas, os 101 JSON
corrigidos e o `fotos_linha.geojson`. Três correções sobre a entrega:

1. **lat/lon da câmera e de cada alvo** vêm da geometria do gpkg. Os alvos
   espelhavam a câmera da foto-alvo em 425 de 425 casos, então andam junto.
2. **`heading` recalculado** como rumo ao alvo `next`, sobre a coordenada
   corrigida, nas 41 fotos que têm `next`. As outras 60 mantêm o valor entregue.
   O `heading` da entrega era o rumo ao `next` calculado sobre a coordenada
   velha: p50 de 13,0° de diferença contra o rumo real, e 47 fotos com zero.
3. **As 10 conexões que só a camada de linha tem** entram como alvo recíproco.

O grafo preparado é a UNIÃO de duas fontes que divergiam: 215 conexões nos JSON
e 180 na camada de linha, com 10 que os JSON não trazem, de 9,8 m a 56,6 m. As
duas mais longas estão fora do alcance da Fase 5, então nenhuma automação as
recriaria. Ficam 225 pares, 445 alvos dirigidos.

A conferência do preparo relê o destino campo a campo e reprova 86 de 101 fotos
se o JSON for copiado como veio.

### O que ficou de fora

15 fotos estão em `imagens_adicionais.shp` com posição, mas não viraram JPG nem
JSON. Não deixam buraco: cada uma tem foto processada a menos de 11,7 m, com
mediana de 4,1 m. Vale confirmar com quem preparou se o descarte foi de
propósito.

## Backup

`data/_backups/pre_expoex_20260902/index.db`, pela API de backup do SQLite (o
`index.db` está em WAL). Conferido depois de escrever: `integrity_check` ok, 35
projetos, 100.937 fotos, 635.091 alvos.

## A migração

```bash
node scripts/migrate.js \
  --metadata data/_preparado/expoex_2026 \
  --images   data/_preparado/expoex_2026 \
  --output   data \
  --tracks   data/_preparado/expoex_2026/fotos_linha.geojson
```

Antes de rodar, os 8 projetos que estavam descomentados no `PROJECTS` foram
comentados, como manda o EXPANDING.md. Todos já estavam no `index.db`, e o
`migrate.js` gera UUID novo a cada rodada.

### RODAR COM `--tracks`

Aqui o `fotos_linha.geojson` NÃO é caminho andado: é a própria camada de
conexões que a equipe desenhou, uma linha por ligação. Serve de guarda do mesmo
jeito, e com a coordenada corrigida cada foto fica a 0,00 m dela.

### NÃO usar `--skip-targets`

Medido na Fase 5, com raio adaptativo de 24 m: 801 candidatos, 440 reprovados
pela guarda (38,8%) e 361 alvos espaciais novos em 96 fotos. Nenhum deles liga
fotos distantes no grafo manual: 257 pares estão a 3 saltos, 96 a 4 saltos e 5 a
1 salto, e nenhum a 5 ou mais. Ou seja são atalhos ao longo do que já se anda,
com comprimento mediano de 12,9 m contra 7,9 m dos originais. Nenhum pisa em
aresta original, porque a chave primária de `targets` é o par e a checagem deu
zero repetição.

Resultado: 101 fotos, 806 alvos (445 originais e 361 espaciais), 0 erro de
imagem, 70 s.

## Pós-flight

Releitura do `index.db` campo a campo, na mesma extensão da escrita:

- Nenhum dos 35 projetos anteriores mudou de contagem ou de centro.
- +101 fotos e +806 alvos, exatamente.
- lat/lon das 101 idênticos à geometria do gpkg E ao JSON preparado.
- `ele`, `heading`, `mesh_rotation_*` e `floor_level` conferem com o preparado.
- `sequence_number` cobre 1 a 101 sem furo.
- Os 445 alvos originais são o mesmo conjunto do grafo preparado.
- `distance_m` de todos os 806 confere com a geometria, com pior desvio abaixo
  de 1 cm.
- Os 101 blobs decodificam: `full_webp` em 7680x3840 e `preview_webp` em
  512x256, com tamanho batendo com `full_size_bytes`/`preview_size_bytes`.

`expoex_2026.db`: 211,8 MB de `full_webp` e 1,7 MB de `preview_webp`.

### Hora e faixas

```bash
node scripts/import-captured-at.js --sources data/_preparado/expoex_2026 --slug expoex_2026
node scripts/derive-runs.js --slug expoex_2026
```

O `datetime` do JSON é o carimbo da câmera, e cobre 100% das fotos. Gravado nas
101, com zero divergência na releitura.

**O `derive-runs` dá 101 faixas de UMA foto cada.** Não é defeito: o id de
sessão no nome é único por foto, porque o levantamento foi a PÉ e cada panorama
é uma parada. A consequência importa para a calibração, abaixo.

## Pirâmide de tiles

```bash
node scripts/generate-tiles.js --project expoex_2026 --limit 5   # piloto
node scripts/generate-tiles.js --project expoex_2026
```

Piloto de 5 fotos: 18,94 MB, 1,878x o `full_webp`, 2,65 s/foto. As 101 fecharam
em 1m56s com 20.705 tiles e 378,33 MB, 1,873x o `full_webp`, dentro do que o
piloto projetou. Razão 1,6, que é a que o formato 7680 pede, com escada de
458/733/1172/1875/3000/4800/7680. Conferência de tiles, de bytes e de grade OK.

## Traçado no mapa

```bash
cp data/_preparado/expoex_2026/fotos_linha.geojson \
   data/_source_backup/expoex_2026_fotos_linha.geojson
node scripts/import-tracks.js --slug expoex_2026
```

**O `import-tracks.js` só aceita `LineString`, e a entrega vem em
`MultiLineString`.** As 182 feições têm exatamente uma parte cada, então a
conversão é sem perda, e foi conferida coordenada a coordenada. O conserto
durável seria aceitar `MultiLineString` na leitura do geojson (linha 214),
como o `achatar` já faz no ramo do PMTiles.

182 linhas gravadas em `project_tracks`, idênticas à fonte uma a uma.

## Thumbnail

`data/thumbnails/expoex_2026.webp`, 1600x900, 215 KB. Vista retilínea de 100°
de FOV tirada da foto de entrada, olhando a fileira de barracas. Os thumbnails
do acervo são perspectiva, e não recorte de equirretangular.

## Conferência das rotas

Serviço no ar em 8081, com o `data/` atualizado:

| rota | resultado |
|---|---|
| `/health` | `projects: 36` |
| `/api/v1/projects/expoex_2026` | 101 fotos, centro e thumbnail certos |
| `/api/v1/thumbnails/expoex_2026.webp` | 200, 215.650 bytes |
| `/api/v1/photos/<entrada>` | metadados e alvos |
| `/api/v1/photos/<entrada>/tiles.json` | razão 1,6, níveis 0 a 6 |
| `/api/v1/photos/<entrada>/tiles/0/0/0.webp` | 200, 21.760 bytes |
| `/api/v1/photos/<entrada>/image?quality=full` | 200, 2.526.500 bytes |

A UI de calibração abre o projeto, desenha a panorâmica por tiles, os marcadores
e o minimapa no Cais Embarcadero.

## O que NÃO foi feito

- **`generate-pmtiles.js` não rodou.** Ele saiu do caminho de produção em
  2026-08-10: o mapa lê as rotas de tile do serviço. O `fotos.pmtiles` fica
  desatualizado de propósito, como saída de emergência.
- **`aposentar-full.js` não rodou.** O lote de Cascavel também guarda os blobs
  nesta máquina, e a poda é decisão à parte.
- **Deploy no servidor.** O que está descrito aqui foi feito na cópia de teste.

## A calibração, feita em 2026-09-02

O lote chegou com `mesh_rotation_y = 60` fixo nas 101 e `gyro_stabilized: false`.
O chefe calibrou à mão a foto de entrada no visualizador (`y = 331,9`, `x = 2,8`,
`z = 1,0`), aplicou o valor ao projeto e disse que teria de ser corrigido foto a
foto. A medida confirmou, e deu o número.

### O bruto da missão tem os gyro.mp4

A pasta do bruto do Insta360 fica na chave `MISSAO_EXPOEX_DIR` do `.env` do
vault. São 137 pastas de sessão, uma por parada, cada uma com `gyro.mp4`, os
`origin_<disparo>_<lente>_*.jpg` e o `pro.prj`. As 101 fotos do lote casam uma a
uma com a sua pasta, pelos 19 primeiros caracteres do nome.

A raiz do bruto não tem JSON nenhum, porque a entrega processada mora em outra
pasta. O `fase_rajadas` do `calibrar.py` passou a tirar os nomes do `index.db`
quando não acha JSON na raiz.

### Um valor único de guinada está errado por construção

O azimute do sol MEDIDO nas imagens espalha pela circunferência inteira (p50 de
93° em torno da média), enquanto o azimute PREVISTO varia só 22,3° na missão
toda. Contra o 331,9 aplicado ao projeto, a guinada que o sol pede difere em
96,4° na mediana, e 95% das fotos ficam a mais de 3°.

O `derive-runs.js` já dizia isso por outro caminho: 101 faixas de uma foto cada.

### O método: sol para o rumo, acelerômetro para a vertical

Uma foto dá UMA observação do sol, que são 2 vínculos para 3 graus de liberdade.
O terceiro vem da vertical do acelerômetro, e as duas direções bastam para
resolver a rotação por foto.

Os eixos do IMU se ligam ao frame do panorama por UMA rotação para o projeto
todo, ajustada pelo ângulo ZENITAL do sol, que a efeméride sabe e que não depende
da resposta. Sobra de 0,89° na mediana e 2,96° no p90, com 82 de 86 fotos
dentro. Como o ajuste não usa o gabarito, o gabarito fica livre para conferir.

### O resultado

| medida | valor |
|---|---|
| sol detectado | 86 de 101 (85,1%) |
| resolvidas | 82 |
| gravadas | 81 (a de entrada ficou como o chefe deixou) |
| inclinação contra a vertical | p50 3,63°, p90 4,69°, máximo 6,61° |
| guinada gravada | de 0,1° a 359,8° |
| gabarito, fora do ajuste | d_y = -7,30°, d_x = +0,17°, d_z = +2,22° |

Releitura do banco depois de gravar: 81 de 81 conferem campo a campo.

### A prova de produto: o marcador cai onde se anda

O ajuste usou o disco do sol, o acelerômetro e a efeméride. NÃO usou a posição
das fotos nem o grafo. O azimute da foto vizinha, que sai só da geometria, é
medida de fora: com o ângulo certo a coluna correspondente do panorama mostra a
passagem por onde se chega lá.

    py provar_marcador.py --slug expoex_2026

Seis fotos sorteadas ao longo da sequência, seis vistas em passagem: um portão
aberto, um pátio, a rua de pedestres, a esplanada do cais, um calçadão e uma rua.
Nenhuma parede, barraca de lado ou viatura.

### 19 fotos ficam para a mão

15 sem sol detectado e 4 recusadas por sobra alta, que é detecção falsa. Sem sol
não há guinada, e interpolar da vizinha não vale aqui, porque cada foto é uma
pose. Elas ficam com `calibration_source` nulo:

EXPOEX_2026_0006, 0007, 0008, 0009, 0018, 0021, 0023, 0024, 0028, 0029, 0030,
0031, 0037, 0039, 0045, 0047, 0073, 0074 e 0098.

### A armadilha do botão "aplicar ao projeto"

O `batchUpdateMeshRotationY` escreve `calibration_source = 'manual'` em TODAS as
fotos do projeto. A marca existe para proteger a foto que uma pessoa mediu, e um
valor de lote não é isso: ela ficou nas 101 e faria o ajuste pular o projeto
inteiro. Foi limpa nas 100 que só receberam o valor de lote, mantida na foto de
entrada, que é a única com `calibration_reviewed = 1`.

O conserto durável seria o batch escrever outra marca, algo como `'lote'`, para
o ajuste distinguir uma da outra.

## Anexo: o levantamento da calibração, antes de rodar

O lote chega com `mesh_rotation_y = 60` fixo nas 101 e `gyro_stabilized: false`,
ou seja sem calibração de rumo.

Em 2026-09-02 o chefe calibrou a PRIMEIRA foto à mão no visualizador e aplicou
ao projeto: `y = 331,9`, mais `x = 4,2` e `z = 4,0` só nela. É o único gabarito
de campo que existe para este projeto.

### O sol está lá

Varredura da skill `calibrar-orientacao-360`, fase 1: **sol detectado em 86 das
101 fotos (85,1%)**, contra o limiar de 15%. Sol previsto entre 40,2° e 47,4° de
elevação, e o cálculo não põe nenhuma foto abaixo do horizonte.

### Um valor único de guinada está errado por construção

O azimute do sol MEDIDO nas imagens espalha pela circunferência inteira (p50 de
93° em torno da média, máximo de 177°), enquanto o azimute PREVISTO varia só
22,3° na missão toda. A câmera aponta para um lado diferente a cada parada, que
é o que um levantamento a pé produz, e não é artefato do `heading`: forçando
`heading = 0` o espalhamento não muda.

Contra o 331,9 aplicado ao projeto, a guinada que o sol pede difere em 96,4° na
mediana. **95% das fotos ficam a mais de 3° do valor único.** Confirma o que o
chefe suspeitou: tem de ser foto a foto.

Na única foto com gabarito, a guinada ingênua (supondo câmera nivelada) dá
322,8° contra os 331,9° medidos à mão, 9,1° de diferença. É um caso só, mas é o
sinal de que o método fecha.

### A inclinação não tem fonte na entrega

O ramo SOL do `calibrar.py` tira a inclinação da rajada do acelerômetro do
`gyro.mp4` da missão. Este lote não tem: os JSON só trazem
`id/img/lon/lat/ele/heading/mesh_rotation_y`, o XMP não traz pose, e a pasta
`gyro.mp4` da missão não veio.

Uma foto dá UMA observação do sol, ou seja 2 vínculos para 3 graus de liberdade.
Falta uma segunda direção do mundo por foto.

**O tamanho da inclinação, medido.** O módulo do erro de elevação do sol é um
PISO da inclinação, porque guinada não mexe em elevação. Nas 86 fotos com sol:
p50 de 2,17°, p75 de 3,59°, p90 de 5,30°. Piso acima de 3° em 32 fotos e acima
de 5° em 9. As 3 acima de 10° são candidatas a detecção falsa, não a inclinação.

**Candidato a nivelador: o `prumo.py`**, que tira a vertical do ponto de fuga
das retas de prumo da cena. Foi feito para o ramo indoor, mas não depende de
IMU. Piloto em 8 fotos: achou ponto de fuga nas 8, com inclinação de p50 3,56° e
máximo de 17,19°.

**Ele ainda não passa no gabarito.** Na foto do chefe o prumo dá 2,68°, contra
5,80° da medida à mão e contra um piso de 3,31° do próprio sol. Duas medidas do
mesmo parâmetro que discordam indicam defeito, e a prova é um teste: precisa de
mais fotos calibradas à mão antes de valer como nivelador.

O caminho pelo HORIZONTE já foi tentado e falhou em 2026-07 (ver
`docs/tilt-estimation/README.md`): o detector trava na borda céu/copa-de-árvore,
e este acervo também tem árvore.

### O `calibrar.py` não roda neste projeto como está

Duas guardas dele barram o lote, e por motivo estrutural, não por qualidade:

- exige `heading` não nulo, e 60 das 101 têm zero;
- exige distância mínima de 8 m até a próxima foto DA MESMA FAIXA, e aqui cada
  faixa tem uma foto só.

Com isso `fase_ajuste` fica com zero foto utilizável e aborta por amostra
pequena. Adaptar significa resolver `mesh_rotation_y` de forma absoluta, com
`heading = 0`, e por foto em vez de por faixa. A suavização de +-7 fotos, os
blocos e a lista de degraus do `auditar.py` também não valem aqui, porque todos
supõem que o ângulo é constante dentro da faixa.
