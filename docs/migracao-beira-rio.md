# Migração Beira-Rio: runbook de importação com andares

Runbook do lote de 2026-08. Fonte: pasta `MISSAO_BEIRA_RIO`, 350 fotos, 894
ligações, 189 linhas de planta, 6 andares mais 2 áreas externas.

É o primeiro projeto do acervo com ambiente interno e externo junto, distribuído
por andares. A conferência do lote está em `qa-lote-beira-rio.md`.

## Estado

O código das 8 fases está escrito e testado. **A importação no `index.db` de
produção ainda NÃO rodou.** Ela é o único passo que falta, e é o que muda dado
real.

O pipeline inteiro foi exercitado num banco descartável, com a fonte real:

```
350 fotos, 7 andares (0 a 6), contagens iguais às da conferência do lote
894 ligações, todas is_original = 1  (a fase espacial não rodou)
grafo em 2 componentes: 332 + 18, a ilha inteira no andar 6
inclinação viva: 344 fotos com pitch, 331 com roll
189 linhas de planta em 7 níveis, toda foto a no máximo 7,3 m da sua
7 faixas de coleta, uma por andar, zero fotos sem faixa
```

O filtro de andar do `/nearby` foi medido contra a consulta crua: numa foto do
1º andar, sem filtro vinham 51 fotos, **38 delas dos outros seis níveis**. Com
filtro, só o 1º andar. Nas três fotos testadas, o filtro segurou 109 fotos.

## Decisões tomadas

| assunto | decisão |
|---|---|
| Alvo do consumo | `ebgeo_360` servindo direto na 8081, mais o `ebgeo_web` da `main` |
| `mesh_rotation_y` | importar 60, como veio, e calibrar no visualizador |
| `mesh_rotation_x/z` | converter de `YXZ` para `ZXY` na carga |
| Fonte do andar | o `locate` do json, com o `local` do `fotos.geojson` de reserva |
| Grafo | só o entregue, sem a fase espacial |
| Faixa de coleta | o andar |
| `initialYaw` | descartar |
| Planta do museu | depois |

O `ebgeo_web` tem hoje uma branch `integracao_backend`, 143 commits à frente da
`main`, que absorve o 360 num backend Postgres. A interface de andar feita agora
na `main` terá de ser portada quando essa branch virar a principal.

## O modelo de andar

O andar é propriedade da FOTO, não do projeto, porque este projeto é interno e
externo ao mesmo tempo.

Mapeamento do `locate`:

| `locate` | `floor_level` | `floor_label` | fotos |
|---|---|---|---|
| campo de futebol | 0 | Campo | 8 |
| área externa | 0 | Externo | 86 |
| andar 1 | 1 | 1º andar | 79 |
| andar 2 | 2 | 2º andar | 20 |
| andar 3 | 3 | 3º andar | 12 |
| andar 4 | 4 | 4º andar | 45 |
| andar 5 | 5 | 5º andar | 82 |
| andar 6 | 6 | 6º andar | 18 |

As duas áreas externas ficam no mesmo nível 0, porque estão as duas no chão e as
duas ligam ao andar 1. O rótulo distingue as duas na tela.

Projeto sem linha em `project_floors` não tem andar, e a interface não mostra o
seletor. É assim que os 28 projetos atuais seguem intactos, sem tocar nas 98.690
fotos.

## Fase 1: o andar no estúdio (feita)

**Arquivos:** `src/db/schema.sql`, `src/db/connection.js`, `scripts/migrate.js`,
`scripts/lib/floors.js` (novo).

1. `photos` ganhou `floor_label TEXT`. O `floor_level INTEGER DEFAULT 1` já
   existia e nunca saíra de 1.
2. Tabela nova `project_floors`: `project_id`, `level`, `label`, `plan_coords`
   (JSON `[[[lon,lat],...],...]`, no molde de `project_tracks`).
3. `connection.js` aplica o `ALTER TABLE` e o índice `idx_photos_floor` nos
   bancos que já existem. Conferido no `index.db` real: colunas criadas, e os
   28 projetos anteriores seguem com `floor_label` nulo nas 98.690 fotos.
4. `migrate.js` lê o `locate` da raiz do json. Sem ele, cai no `local` do
   `fotos.geojson` e AVISA, porque json sem `locate` é defeito na fonte.
   `locate` fora do vocabulário estoura em `parseFloor`, em vez de gravar o
   nível 1 em silêncio.

Nível com mais de um nome recebe o rótulo genérico. O nível 0 do Beira-Rio é
"Campo" em 8 fotos e "Externo" em 86, então o andar chama-se "Térreo" e as
fotos guardam o nome fino. Ficar com o primeiro que aparecesse daria ao andar
um nome tirado da ordem de leitura dos arquivos.

## Fase 2: a inclinação convertida (feita)

**Arquivo:** `scripts/lib/orientation.js`, chamado por `migrate.js`.

Achei uma armadilha a mais durante a implementação. **O lote não traz
`mesh_rotation_x` nem `mesh_rotation_z`**: a calibração manual vive só em
`textureRotationX` e `textureRotationZ`. O `resolveMeshRotation` de antes lia o
ramo explícito, achava o `mesh_rotation_y`, e devolvia inclinação ZERO nas 350.
A calibração da tropa sumiria sem uma linha de aviso.

Agora um ramo novo reconhece o par `textureRotation*`, converte de `YXZ` para
`ZXY` pela matriz, e mantém o `mesh_rotation_y` entregue. O Y da conversão é
descartado de propósito. No visualizador de origem o yaw aplicado é 0, então o
Y que sai da mudança de convenção é artefato, não medida.

**Teste** (`tests/unit/orientation-texture.test.js`): a matriz montada em `YXZ`
tem de reproduzir exatamente a montada em `ZXY` com os ângulos convertidos. E o
caso que REPROVA o estado anterior: ler os mesmos números como `ZXY` sem
converter dá outra rotação, com divergência acima de 0,05 num par típico.

No banco piloto, 344 das 350 fotos ficaram com pitch e 331 com roll. Antes,
seriam 350 zeros.

## Fase 3: a planta (feita)

**Arquivo novo:** `scripts/import-floor-plans.js`.

Lê o `planta.geojson`, agrupa as LineStrings pelo atributo `andar` e grava uma
linha de `project_floors` por nível. Re-executável, como o `import-tracks.js`.

**A conferência é do próprio script, e ela ABORTA a gravação.** Antes de
escrever, ele mede a distância de cada foto até a linha mais próxima da planta
do SEU andar. Passando de 15 m, ele para. Planta trocada de andar passa em
qualquer conferência de contagem: o total fecha e o mapa desenha. O erro só
apareceria como parede no lugar errado. Depois de gravar, o script RELÊ o banco
e compara a contagem, porque o retorno do INSERT é eco dele mesmo.

Rodado sobre a fonte real: 189 linhas em 6 níveis, p50 de 0,6 a 2,2 m por andar,
pior foto a 7,3 m. O nível 0 entra sem planta, que é o correto para área
externa.

## Fase 4: a importação (falta rodar em produção)

O `--skip-targets` já existe no `migrate.js`, com o comentário "for manual indoor
graphs". A fase 5 liga por proximidade em planta, e neste lote 26% das fotos têm
foto de outro andar a menos de 5 m, chegando a 0,7 m. Ela ligaria o térreo ao
quinto andar.

Entrada no `PROJECTS` de `scripts/migrate.js`:

```js
{ name: 'Beira-Rio', slug: 'beira_rio',
  description: 'Imagens panorâmicas do Estádio Beira-Rio',
  capture_date: '2026-05-20', location: 'Porto Alegre, RS',
  lat: -30.065515, lon: -51.236004,
  entryPhoto: 'PIC_20260520_104137_20260521163900' }
```

A foto de entrada é cabeça de cadeia `next` com 11 passos, no `andar 1`, dentro
do componente principal, e tem `heading` medido. Cabeça de cadeia fora do
componente principal é a armadilha do lote do faxinal.

Ordem de execução:

A entrada já está ATIVA no `PROJECTS`. A do AMAN também está, e não corre
risco. A fase 2 atribui a foto ao centro de projeto mais próximo, num raio de
50 km, e Resende não recebe foto de Porto Alegre.

```bash
# 1. copia de seguranca do index.db (os UUID sao randomicos: re-rodar duplica)
# 2. metadados e imagens moram na mesma pasta
npm run migrate -- --metadata <pasta> --images <pasta> --skip-targets
# 3. planta
node scripts/import-floor-plans.js --slug beira_rio --planta <planta.geojson>
# 4. faixas por andar
npm run derive-runs -- --slug beira_rio
# 5. tela de vetor
npm run generate-pmtiles
```

Depois de importar, comentar a entrada no `PROJECTS`.

Custo medido: 350 fotos, 1,8 GB de jpg a converter para WebP. Sem imagens, a
migração inteira leva 2,2 s. O DCMun, com 1235 fotos, é a referência de tempo
da conversão.

**Teste.** 350 fotos e **exatamente 894** ligações, todas com `is_original = 1`.
O grafo continua com dois componentes, 332 mais 18, e a ilha inteira no andar 6.
Se a contagem de ligações subir ou o grafo virar um componente só, a fase 5
rodou e ligou o térreo ao quinto andar.

Este teste já passou no banco piloto, com a fonte real.

## Fase 5: o andar nas consultas (feita)

**Arquivos:** `src/db/queries.js`, `src/routes/photos.js`,
`src/routes/projects.js`, `src/routes/calibration.js`,
`scripts/generate-pmtiles.js`.

1. `nearbyPhotos` filtra por `floor_level`. O nível vem do BANCO, não do
   cliente. Uma subconsulta devolve o andar da foto de origem só quando o
   projeto tem `project_floors`. Projeto externo passa NULL e cai na consulta
   antiga, sem ramo separado.
2. `GET /api/v1/photos/:uuid` devolve `floor_label`, e cada ALVO devolve
   `floor_level`/`floor_label`. É o que deixa a interface reconhecer a escada.
3. Rota nova `GET /api/v1/projects/:slug/floors`, com os níveis de cima para
   baixo, os rótulos, a contagem de fotos e a planta em GeoJSON. **Lista vazia
   é resposta válida**, não 404: ela significa "projeto sem andares", e é o que
   diz ao cliente para não desenhar o seletor.
4. O `/nearby` também devolve o `floor_level`, para o filtro ser auditável de
   fora. Sem isso, um vazamento de andar só se veria abrindo o banco.
5. `generate-pmtiles.js` emite `floor_label` junto do `floor_level`.

**Teste** (`tests/integration/floors.test.js`): antes de comparar, um caso
AFIRMA A VARIÂNCIA, conferindo que a consulta crua devolveria os outros andares.
Sem isso, "só veio o andar 1" passaria também num conjunto sem nada a filtrar.
Um terceiro caso confere que projeto SEM `project_floors` não ganha filtro
nenhum.

Medido na fonte real: numa foto do 1º andar, sem filtro vinham 51 fotos, 38
delas dos outros seis níveis.

## Fase 6: faixa de coleta por andar (feita)

**Arquivos:** `scripts/lib/capture-runs.js`, `scripts/derive-runs.js`.

Dois problemas. O padrão `PIC_<data>_<hora>_<costura>`, sem `_output_`, é novo e
cobre 266 das 350. E cada um desses nomes é um disparo único, com pasta própria
em `dados_brutos`, então não existe corrida contínua para agrupar.

O padrão novo passou a ser reconhecido. Ele agrupa pela costura e usa o
instante do disparo como número de quadro. Assim a ordem dentro da faixa sai
cronológica, mesmo sem `captured_at` no banco.

E a faixa passa a ser o ANDAR em projeto com `project_floors`. O critério é
perguntado ao banco, não a uma opção de linha de comando, para não depender de
alguém lembrar da flag. O rótulo sai de `project_floors`, fonte única, e não de
uma foto qualquer do nível.

**Teste** (`tests/unit/capture-runs-floors.test.js`): o caso que reprova o
estado anterior mostra as MESMAS fotos agrupadas por costura formando faixas que
misturam térreo, primeiro e sexto andar.

Rodado na fonte real: 7 faixas, uma por nível, zero fotos sem faixa.

## Fase 7: a calibração por andar (feita)

**Arquivos:** `public/calibration/js/project-map.js`, `index.html`.

O mapa do projeto ganhou seletor de andar na borda esquerda. Sem ele, o mapa do
Beira-Rio desenha 6 andares empilhados no mesmo lugar.

O filtro roda ao montar a coleção de pontos, e não num `filter` de camada do
MapLibre. O mesmo recorte precisa valer para o contador da legenda, e duas
verdades sobre "o que está na tela" divergiriam na primeira troca de andar. Com
andar em exibição, o contador mede o ANDAR, não o projeto.

O mapa abre no andar da foto que está aberta no 360, e não no térreo. Começar
noutro lugar tiraria o operador do contexto que ele acabou de deixar.

O "Aplicar à faixa" passa a valer por andar, que é o agrupamento da fase 6.

Todas as 350 precisam de revisão, porque o `mesh_rotation_y` entra como 60 e não
como ângulo medido. É o mesmo caminho do DCMun.

## Fase 8: o consumo no `ebgeo_web` (feita)

**Arquivos:** `src/js/street_view_tool/components/floor-selector-360.js` (novo),
`street_view_viewer.js`, `add_street_view_control.js`,
`streetview-api.service.js`, `events/event_types.js`, `css/panels-360.css`.

1. Seletor de andar vertical à esquerda do visualizador, de `6` até `1` mais
   `Ext`, alimentado por `/projects/:slug/floors`. Só aparece quando a resposta
   traz níveis, e some no `resetFloorSelector` ao fechar o 360, cache incluído.
2. O evento novo `STREETVIEW_360_FLOOR_CHANGED` liga o seletor aos mapas. O
   controle filtra por `floor_level` a camada de pontos do minimapa E a do mapa
   principal. Ele também desenha a planta do andar como linha, abaixo dos
   pontos.
3. Nível nulo tira o filtro. É o estado de todo projeto externo, e também o
   estado correto ao trocar de levantamento: sem isso, o filtro do projeto
   anterior apagaria o mapa seguinte inteiro.
4. Os marcadores DENTRO da foto não são filtrados. Filtrar apagaria a escada da
   tela. O `syncFloorSelector` cobre o caminho inverso: atravessar uma escada
   troca a foto, e o seletor segue.

O seletor também é o que salva o andar 6, que hoje é uma ilha no grafo entregue
(item 1 da conferência): sem ligação de escada, só se chega lá escolhendo o
andar.

**Teste.** A decisão de qual andar abrir saiu para uma função pura testada
(`tests/unit/floor-selector-360.test.js`), porque o repositório não tem ambiente
de DOM. O resto é verificação manual na tela: trocar o seletor muda a contagem
de pontos do minimapa para o número exato do nível (94 no `Ext`, 79 no 1, 20 no
2, 12 no 3, 45 no 4, 82 no 5, 18 no 6), e clicar num alvo `andar 1 -> andar 2`
move o seletor para o 2.

## O que a importação carrega dos defeitos abertos

Estes vêm da conferência do lote e entram no banco como estão:

- O andar 6 fica sem ligação de escada. O seletor contorna.
- 22 fotos com `heading` igual a 0 exato ficam com marcador apontando errado.
  Elas aparecem na revisão de calibração.
- 65 fotos sem `next` de saída. A navegação comum funciona. O "seguir em frente"
  não.
- O `ele` entra como veio, com 207 zeros. Nada o lê para desenhar.
- As 2 fotos sem `locate` caem na reserva do `fotos.geojson`, que diz `andar 1`.
