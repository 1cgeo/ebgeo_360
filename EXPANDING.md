# Expandindo a Base do 360

Guia para adicionar novos projetos e fotos ao servico de 360 do EBGeo apos uma nova missao de campo.

## Visao Geral do Fluxo

```
Missao de Campo
      |
      v
Fotos 360 (JPG) + Metadados (JSON)
      |
      v
1. Registrar novo projeto em migrate.js
2. Executar migracao (JSON+JPG -> SQLite)
3. Gerar PMTiles para marcadores no mapa
4. Adicionar thumbnail do projeto
5. Verificar e testar
6. Deploy
```

## Pre-requisitos

- Node.js 22+ (o servico roda direto no host, sem container)
- Dependencias instaladas com `npm install` (os modulos nativos `better-sqlite3`
  e `sharp` baixam binario pronto; nao e preciso compilador C++)
- Arquivo `.env` na raiz: `cp .env.example .env`. O `npm start` usa
  `node --env-file=.env` e falha se o arquivo nao existir, mesmo com todos os
  valores no padrao
- tippecanoe instalado (para gerar PMTiles)
- Fotos panoramicas 360 em formato JPG
- Metadados de cada foto em formato JSON

## Passo 1: Preparar os Dados de Campo

### Estrutura esperada dos arquivos

```
METADATA/
  MULTICAPTURA_XXXX_NNNNNN.json    # Um JSON por foto
  ...
IMG/
  MULTICAPTURA_XXXX_NNNNNN.jpg     # Uma imagem panoramica por foto
  ...
```

### Formato do JSON de metadados

Cada arquivo JSON deve conter as informacoes da camera e os alvos de navegacao:

```json
{
  "camera": {
    "lat": -29.784988,
    "lon": -55.774959,
    "ele": 120.5,
    "heading": 180.0,
    "height": 2.5,
    "mesh_rotation_y": 180,
    "floor_level": 1
  },
  "targets": [
    {
      "img": "MULTICAPTURA_XXXX_NNNNNN",
      "lat": -29.785100,
      "lon": -55.775020,
      "ele": 120.3,
      "next": true,
      "icon": "next"
    }
  ]
}
```

Campos da camera:
- **lat/lon** — Coordenadas WGS84 (obrigatorios)
- **ele** — Altitude em metros
- **heading** — Azimute da camera em graus (0-360, 0=Norte)
- **height** — Altura da camera em metros (geralmente ~2.5m)
- **mesh_rotation_y** — Rotacao da malha 3D em graus (padrao 180)
- **mesh_rotation_x / mesh_rotation_z** — Correcao de pitch e roll em graus (padrao 0)
- **orientation** — Pose da panoramica como quaternion (alternativa aos tres angulos)
- **floor_level** — Andar da foto (padrao 1, usado para indoor maps)

#### Pose por quaternion (`orientation`)

Scanner, rig de SLAM e reconstrucao por SfM ja produzem a pose de cada panoramica
como quaternion. Nesse caso, em vez de calibrar os tres angulos a mao foto a foto,
basta emitir `orientation` no JSON:

```json
{
  "camera": {
    "lat": -30.031805,
    "lon": -51.235408,
    "orientation": [0.804644, -0.0000087, -0.0000146, 0.593758]
  }
}
```

- Aceita `[qw, qx, qy, qz]` (a ordem usada por praticamente todo CSV de scanner),
  ou um objeto com as chaves `w/x/y/z` ou `qw/qx/qy/qz`.
- O quaternion e assumido num referencial **Z-up destro** (X leste, Y norte, Z cima),
  que e o que instrumento de campo emite. A conversao para o referencial Y-up do
  Three.js esta em `scripts/lib/orientation.js`.
- Quando `heading` nao vier, ele e derivado do proprio quaternion. Isso resolve o
  caso do acervo do museu, onde `heading` e NULL em todas as fotos.

**Precedencia, que nao muda:** angulo explicito (`mesh_rotation_*`) vence sempre,
para que o acervo ja calibrado a mao nunca seja sobrescrito; o quaternion so entra
quando nenhum angulo foi dado; sem os dois, valem os padroes historicos (180/0/0).

> Atencao: o sinal e a fase da conversao ainda **nao** foram confirmados contra um
> instrumento real, porque nenhum conjunto do acervo carrega quaternion ate agora.
> Confira o primeiro lote real antes de aplicar em massa. O ajuste se faz pela
> opcao `frame` de `resolveMeshRotation`, em `scripts/lib/orientation.js`; hoje o
> `migrate.js` a chama sem opcoes e **nao ha flag de linha de comando** para isso,
> entao mudar o referencial exige editar a chamada.

Campos de cada target:
- **img** — Nome do arquivo da foto alvo (sem extensao `.jpg`)
- **lat/lon/ele** — Coordenadas do alvo
- **next** — `true` para o proximo ponto na sequencia
- **icon** — `"next"` para indicar proximo na sequencia

## Passo 2: Registrar o Novo Projeto

> **ATENCAO:** o array `PROJECTS` em `scripts/migrate.js` esta hoje
> **inteiramente comentado**. Isso e proposital (os UUIDs sao gerados por
> `randomUUID`, entao re-rodar um projeto ja migrado o duplicaria), mas
> significa que rodar a migracao sem descomentar nada e um no-op silencioso:
> zero fotos atribuidas, e tudo cai no relatorio `_unassigned_photos.csv`.
> Descomente apenas o projeto que voce vai migrar, ou acrescente o novo.

Edite o array `PROJECTS` em `scripts/migrate.js` e adicione uma nova entrada:

```javascript
const PROJECTS = [
  // ... projetos existentes ...

  {
    name: 'Nome do Local',                    // Nome de exibicao
    slug: 'nome_do_local',                    // Identificador unico (sem acentos, sem espacos)
    description: 'Imagens panoramicas de ...',
    capture_date: '2026-03-15',               // Data da captura (YYYY-MM-DD)
    location: 'Cidade, UF',                   // Localizacao textual
    lat: -25.123456,                          // Latitude do centro do projeto
    lon: -50.654321,                          // Longitude do centro do projeto
    entryPhoto: 'MULTICAPTURA_XXXX_NNNNNN',  // Foto de entrada (primeira da sequencia)
  },
];
```

### Regras para o slug
- Apenas letras minusculas, numeros e underscores
- Sem acentos ou caracteres especiais
- Sera usado como nome do arquivo do banco: `{slug}.db`

### Como escolher o centro do projeto
- Use a coordenada central aproximada da area mapeada
- Todas as fotos dentro de 50 km desse ponto serao atribuidas a este projeto
- Se dois projetos estiverem proximos, cada foto ira para o projeto cujo centro esta mais perto

### Como escolher a foto de entrada
- E a primeira foto que o usuario vera ao abrir o projeto
- Geralmente a primeira foto capturada na sequencia
- A cadeia de navegacao `next: true` parte desse ponto

## Passo 3: Executar a Migracao

```bash
# Migracao completa (metadados + imagens)
node scripts/migrate.js \
  --metadata /caminho/para/METADATA \
  --images /caminho/para/IMG \
  --output ./data

# Somente metadados (para testes rapidos, sem converter imagens)
node scripts/migrate.js \
  --metadata /caminho/para/METADATA \
  --images /caminho/para/IMG \
  --output ./data \
  --skip-images
```

### O que a migracao faz (7 fases)

1. **Le metadados** — Todos os JSONs do diretorio `METADATA/`
2. **Atribui a projetos** — Cada foto vai para o projeto com centro mais proximo (max 50 km)
3. **Sequencia fotos** — Segue a cadeia `next:true` a partir da foto de entrada, depois BFS, depois orfas
4. **Gera UUIDs** — Cada projeto e foto recebe um UUID v4 unico
5. **Analise espacial** — Cria links extras entre fotos proximas (raio 50m, separacao angular 15 graus)
6. **Popula metadados** — Insere fotos, alvos e indice espacial no `index.db`
7. **Processa imagens** — Converte JPG para WebP (full + preview 512x256) em lotes de 100, gravando no `{slug}.db`

### Parametros opcionais

| Parametro | Padrao | Descricao |
|-----------|--------|-----------|
| `--workers` | 4 | Numero de workers para processamento paralelo |
| `--radius` | 50 | Raio em metros para busca de alvos espaciais |
| `--skip-images` | false | Pula conversao de imagens (so metadados) |
| `--skip-targets` | false | Pula geracao automatica de alvos espaciais (usa apenas targets do JSON) |
| `--multiplier` | 5 | Raio adaptativo = mediana da distancia ao vizinho mais proximo x este fator |
| `--max-targets` | — | Teto de alvos espaciais por foto |
| `--sectors` | 4 | Setores angulares usados na selecao de alvos |
| `--per-sector` | 3 | Maximo de alvos por setor |

Um projeto pode ainda trazer `skipTargets: true` na propria entrada de `PROJECTS`,
que pula a geracao automatica so daquele projeto (distinto do `--skip-targets`,
que vale para todos).

### Importante: Migracao e aditiva

A migracao usa `INSERT OR REPLACE`, entao:
- Rodar novamente com os **mesmos dados** sobrescreve sem duplicar
- Para adicionar **apenas o novo projeto**, voce pode rodar com um diretorio METADATA/IMG contendo apenas os novos arquivos, mas o `index.db` existente precisa estar no `--output`

## Passo 4: Gerar PMTiles

Apos a migracao, gere o arquivo PMTiles para que os marcadores aparecam no mapa 2D do EBGeo:

```bash
node scripts/generate-pmtiles.js --data ./data --output ./data
```

Isso cria `fotos.pmtiles` contendo um ponto para cada foto com:
- `photo_uuid` — UUID para buscar via API
- `nome_img` — Nome original da foto
- `project` — Slug do projeto
- `heading` — Azimute da camera

Requisito: [tippecanoe](https://github.com/felt/tippecanoe) deve estar instalado.

## Passo 5: Adicionar Thumbnail

Crie uma imagem de thumbnail para o novo projeto no diretorio de thumbnails:

```
{STREETVIEW_DATA_DIR}/thumbnails/{slug}.webp
```

- Formato: WebP
- Nome do arquivo: deve corresponder ao slug do projeto (ex: `nome_do_local.webp`)
- A imagem sera servida na API em `GET /api/v1/thumbnails/{slug}.webp`
- Usada pelo catalogo do EBGeo Web como preview do projeto

O diretorio e `thumbnails/` dentro do `STREETVIEW_DATA_DIR` definido no `.env`
(padrao `./data/thumbnails/`).

## Passo 6: Verificar

### Verificacao manual

```bash
# Iniciar o servico
npm run dev

# Testar endpoints
curl http://localhost:8081/health
curl http://localhost:8081/api/v1/projects
curl http://localhost:8081/api/v1/projects/nome_do_local
```

No retorno de `/health`, confirme que o campo `projects` reflete o total com o novo projeto.

No retorno de `/api/v1/projects/nome_do_local`, verifique:
- `photoCount` — Numero esperado de fotos
- `entryPhotoId` — UUID valido
- `center` — Coordenadas corretas
- `previewThumbnail` — Path do thumbnail (ex: `/thumbnails/nome_do_local.webp`)

### Testar thumbnail

```bash
curl -o test_thumb.webp "http://localhost:8081/api/v1/thumbnails/nome_do_local.webp"
```

### Testar foto de entrada

```bash
# Buscar metadados da foto de entrada
curl http://localhost:8081/api/v1/photos/<entryPhotoId>

# Baixar imagem preview
curl -o test_preview.webp "http://localhost:8081/api/v1/photos/<entryPhotoId>/image?quality=preview"

# Baixar imagem full
curl -o test_full.webp "http://localhost:8081/api/v1/photos/<entryPhotoId>/image?quality=full"
```

### Testar Calibração

Abra `http://localhost:8081/calibration/` no navegador e selecione o novo projeto no seletor.

### Executar testes automatizados

```bash
npm test
```

## Passo 6: Deploy

### Reiniciar o servico

O servico roda direto no Node, sem container. Como os bancos SQLite sao lidos do
disco a cada abertura, basta apontar o `STREETVIEW_DATA_DIR` para o `data/`
atualizado e reiniciar:

```bash
npm start        # ou `npm run dev` durante desenvolvimento
```

Se um projeto novo foi acrescentado com o servico no ar, e preciso reiniciar: as
conexoes com os bancos de projeto sao abertas sob demanda e ficam em cache por
nome de arquivo (`src/db/connection.js`), e o `index.db` e aberto uma vez na
partida.

### Atualizacao no EBGeo Web

Apos adicionar o novo projeto no servico de 360:

1. O PMTiles (`fotos.pmtiles`) precisa estar acessivel pelo EBGeo Web
2. Os novos marcadores aparecerao automaticamente no mapa 2D
3. Clicar em um marcador abrira o visualizador 360 com a foto correspondente

## Estrutura Final dos Dados

Apos migracao completa:

```
data/
  index.db              # Metadados de todos os projetos e fotos
  projects/
    alegrete.db          # BLOBs do projeto Alegrete
    uruguaiana.db        # BLOBs do projeto Uruguaiana
    nome_do_local.db     # BLOBs do novo projeto
    ...
  fotos.pmtiles          # Marcadores para mapa 2D
```

## Troubleshooting

### "X photos unassigned"
As fotos estao a mais de 50 km de qualquer centro de projeto. Verifique se as coordenadas `lat/lon` do novo projeto estao corretas.

### Foto de entrada nao encontrada
O valor `entryPhoto` no PROJECTS nao corresponde a nenhum JSON em METADATA/. Verifique o nome do arquivo (sem extensao `.json`).

### Imagens nao aparecem
Verifique se os nomes dos arquivos JPG correspondem exatamente aos nomes dos JSONs (sem extensao). Exemplo: `MULTICAPTURA_0466_001369.json` precisa de `MULTICAPTURA_0466_001369.jpg`.

### Projeto aparece com 0 fotos
As fotos provavelmente foram atribuidas a outro projeto mais proximo. Ajuste as coordenadas do centro ou verifique se nao ha outro projeto com centro mais proximo das fotos.

### tippecanoe nao encontrado
Instale seguindo as instrucoes em https://github.com/felt/tippecanoe#installation. No Linux: `apt install tippecanoe`. No macOS: `brew install tippecanoe`.
