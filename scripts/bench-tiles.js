#!/usr/bin/env node

/**
 * @module scripts/bench-tiles
 * @description Compara o custo em BYTES das tres formas de entregar uma
 * panoramica equirretangular, para o mesmo conjunto de fotos e o mesmo viewport.
 *
 *   A. hoje          preview 512x256, seguido do full inteiro (5760 ou 7680 px).
 *   B. intermediaria preview, seguido de UMA imagem redimensionada ao nivel
 *                    escolhido, sem fatiar. E a variante barata: dispensa
 *                    piramide, pede so mais um BLOB por foto.
 *   C. tiles         um FUNDO, mais os tiles do nivel escolhido que o viewport
 *                    realmente ve.
 *
 * A REGUA DO PILOTO E A VARIANTE B, e nao a variante A. Ganhar de A e facil:
 * qualquer coisa que entregue menos pixel que o nativo ganha. B entrega os
 * mesmos pixels uteis que C, num request so e sem piramide para construir. Se C
 * ganhar de A mas perder para B, a piramide nao se paga, e a tabela tem que
 * dizer isso na cara. O bloco VEREDITO no fim faz essa comparacao explicita.
 *
 * O FUNDO DE C E TRES COISAS DIFERENTES, e a tabela separa as tres. O fundo e o
 * que cobre a esfera enquanto os tiles finos chegam, para o operador nao ver
 * buraco preto ao arrastar a camera:
 *
 *   preview    so o preview de 512x256, que o cliente ja baixa para a lista.
 *   nivel0vis  o preview, mais os tiles do nivel 0 que a camera enxerga.
 *   nivel0     o preview, mais o nivel 0 INTEIRO. E o que a producao faz hoje.
 *
 * A terceira e cara e foi medida: o nivel 0 inteiro custa cerca de 10x o
 * preview, para a mesma funcao. Google, Photo Sphere Viewer e Marzipano usam UMA
 * imagem base borrada e depois os tiles, nunca um nivel inteiro. Por isso as
 * tres linhas saem lado a lado, com a mesma escala.
 *
 * A RAZAO DA ESCADA SAI DO BANCO. `tile_pyramids.razao` diz com que fator a
 * piramide foi construida, e a escada se remonta com ELA, nunca com o padrao
 * assumido. Banco antigo, sem a coluna, cai em RAZAO_PADRAO e o script avisa.
 * `--razao <n>` SIMULA outra escada: os niveis que a simulacao pede e o banco
 * nao tem sao GERADOS com sharp, na mesma regra do gerador, e medidos. Nenhum
 * byte sai de regra de tres, e a coluna `fonte` diz de onde veio cada linha.
 *
 * O QUE ESTE NUMERO E, E O QUE ELE NAO E.
 *
 * Todo byte lido aqui sai de `length()` sobre o BLOB no SQLite. E o CORPO da
 * resposta, e nada alem dele. NAO inclui cabecalho HTTP, quadro HTTP/2,
 * handshake TLS, ACK de TCP nem o custo de abrir conexao. A variante C paga um
 * conjunto de cabecalhos POR TILE, e este script nao ve nenhum deles: o custo
 * fixo por request esta fora da medida, e favorece C na comparacao.
 *
 * O custo fixo por request pesa MENOS do que a intuicao de HTTP/1.1 sugere. A
 * producao esta atras de HTTP/2 (medido: ALPN negocia h2), entao os tiles vao
 * multiplexados no mesmo socket e nao pagam a fila de 6 conexoes por origem, e
 * os cabecalhos repetidos comprimem no HPACK. Muitos requests pequenos deixaram
 * de ser o problema que eram; a duvida que sobra e de bytes e de latencia.
 *
 * A medida de PAREDE, o tempo ate a foto ficar nitida na tela do operador, TEM
 * QUE SAIR DO NAVEGADOR: abra public/calibration/tile-demo.html contra o
 * servico de producao, com HTTP/2 e a latencia real no meio, e leia o painel de
 * metricas dele. Nenhum numero deste script substitui aquela medida. Ele
 * responde uma pergunta so, e responde bem: quantos bytes cada desenho pede.
 *
 * DUAS ASSIMETRIAS DECLARADAS, para ninguem ler a tabela errado.
 *
 * 1. Os bytes de A e de C sao LIDOS do banco, quando o nivel existe la. Os de B
 *    sao GERADOS na hora com sharp, a partir do full e na qualidade WebP da
 *    propria piramide, porque essa variante nao existe em disco. Sao bytes
 *    reais de uma imagem real, nunca uma estimativa por regra de tres. No nivel
 *    nativo B nao reamostra nada: ali ela e o proprio full de hoje.
 * 2. A escada de niveis e o conjunto de tiles visiveis NAO se calculam aqui.
 *    Eles vem de public/calibration/js/pyramid-math.js, o MESMO modulo que o
 *    cliente importa. Antes deste conserto o benchmark tinha conta propria: ele
 *    varria so a caixa do frustum, enquanto o cliente alarga a faixa de
 *    longitude por 1/cos(lat) e ainda soma um anel de margem. Medido em
 *    1904x985, nivel 2 de 7680x3840, camera no horizonte, varrendo a longitude
 *    de 15 em 15 graus: a caixa pura da de 24 a 28 tiles, e o que o cliente
 *    pede da de 48 a 54. O numero que ia a mesa subestimava o trafego real por
 *    quase 2x na mesma direcao, e por 2,2x entre o melhor e o pior caso.
 *    Fora do horizonte a distancia cresce mais: em lat 20 a caixa da 36 a 40 e
 *    o cliente pede de 66 a 72.
 *
 * POR ISSO O SCRIPT REPORTA DUAS LINHAS DE MARGEM, e nao uma:
 *
 *   margem 0  o ideal geometrico, so o que o frustum cobre. E a referencia:
 *             o piso que uma implementacao perfeita pediria.
 *   margem 1  o que a producao realmente pede. O cliente busca um anel extra de
 *             tiles para nao abrir buraco na emenda enquanto o operador
 *             arrasta a camera.
 *
 * Esconder a margem maquiaria o numero. Esconder o ideal perderia a referencia.
 * Use `--margem <n>` para medir outra folga no lugar de 1.
 *
 * O BLOCO DO ACERVO E EXTRAPOLACAO, e diz isso em toda linha. Ele parte de UMA
 * piramide medida (76 fotos de um projeto), ajusta bytes por pixel em funcao da
 * largura do nivel e projeta o armazenamento das outras razoes sobre os
 * `full_size_bytes` do acervo inteiro, que esses sim sao medidos e estao no
 * index.db. Nao e medida do acervo, e nao substitui gerar um segundo projeto.
 *
 * Uso:
 *   node scripts/bench-tiles.js --project museu_cms
 *   node scripts/bench-tiles.js --project museu_cms --razao 1.6 --sample 3
 *   node scripts/bench-tiles.js --project museu_cms --viewport 1920x1080,412x915 \
 *     --dpr 2 --fov 75 --sample 12 --json bench-tiles.json
 *
 * Opcoes:
 *   --project <slug>   projeto a medir (obrigatorio)
 *   --data <dir>       raiz dos dados (padrao ./data)
 *   --viewport <LxA>   um ou mais viewports em CSS px, separados por virgula
 *   --dpr <n>          devicePixelRatio aplicado a todos os viewports
 *   --fov <graus>      fov VERTICAL da camera (viewer.js usa 75, e limita a 10..75)
 *   --sample <n>       quantas fotos medir, amostradas por passo ao longo do projeto
 *   --yaws <n>         quantas direcoes de camera varrer por foto
 *   --pitch <graus>    inclinacao da camera (0 = horizonte)
 *   --margem <n>       folga de tiles da producao (padrao 1; o ideal 0 sai sempre)
 *   --razao <n>        SIMULA outra escada; os niveis que faltam sao gerados
 *   --censo <n>        fotos por projeto no censo de formato do acervo (padrao 8)
 *   --sem-acervo       pula o censo e a extrapolacao (nao abre os outros projetos)
 *   --json <caminho>   grava o resultado completo em JSON
 */

import { resolve, join } from 'node:path';
import { existsSync, writeFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import sharp from 'sharp';

// A FONTE UNICA da escada e do frustum. O caminho e relativo de proposito: o
// modulo vive em public/ porque o navegador precisa dele, e e ESM puro, sem
// dependencia e sem API de Node, entao Node o importa direto.
import {
  montarEscada,
  custoDaEscada,
  fovHorizontal,
  larguraNecessaria,
  escolherNivel,
  tilesVisiveis,
  RAZAO_PADRAO,
} from '../public/calibration/js/pyramid-math.js';

// libvips guarda operacoes num cache proprio. Aqui passam buffers RAW de 88 MB,
// e esse cache viraria o maior consumidor do processo sem acelerar nada: cada
// foto e um trabalho novo, nada se repete entre elas.
sharp.cache(false);

/**
 * Razoes que o orcamento compara, alem da gravada.
 *
 * 2 e a escada classica. 1,6 e a candidata: ela DOMINA 1,5 e 1,4, porque custa
 * menos armazenamento e ainda escolhe um nivel menor no notebook. As duas
 * ultimas ficam na tabela para mostrar a dominancia, nao por serem opcoes.
 * @constant {number[]}
 */
const RAZOES_CANDIDATAS = [2, 1.6, 1.5, 1.4];

/**
 * Os dois formatos nativos do acervo, medidos no censo.
 *
 * O problema da escada e SO dos 7680: em 5760 o nativo ja cai perto da largura
 * util das telas. A tabela de custo mostra os dois lado a lado para essa
 * diferenca aparecer em numero, e nao em afirmacao.
 * @constant {Array<{width:number,height:number}>}
 */
const FORMATOS_ACERVO = [
  { width: 7680, height: 3840 },
  { width: 5760, height: 2880 },
];

const args = process.argv.slice(2);
const getArg = (nome, padrao) => {
  const i = args.indexOf(`--${nome}`);
  return i === -1 || i + 1 >= args.length ? padrao : args[i + 1];
};

const slug = getArg('project', null);
const dataDir = resolve(getArg('data', './data'));
const viewportsArg = getArg('viewport', '1920x1080,1366x768,412x915');
const dpr = Number(getArg('dpr', '1'));
const fov = Number(getArg('fov', '75'));
const amostra = parseInt(getArg('sample', '8'), 10);
const totalYaws = parseInt(getArg('yaws', '8'), 10);
const pitch = Number(getArg('pitch', '0'));
const margemProducao = parseInt(getArg('margem', '1'), 10);
const razaoArg = getArg('razao', null);
const censoPorProjeto = parseInt(getArg('censo', '8'), 10);
const semAcervo = args.includes('--sem-acervo');
const jsonPath = getArg('json', null);

if (!slug) {
  console.error('Faltou --project <slug>. Exemplo: node scripts/bench-tiles.js --project museu_cms');
  process.exit(1);
}
if (!Number.isFinite(dpr) || dpr <= 0) {
  console.error('--dpr precisa ser um numero maior que zero.');
  process.exit(1);
}
// O limite de fov e o do proprio visualizador (viewer.js:349): medir fora dele
// produziria uma escolha de nivel que a interface nunca faz.
if (!Number.isFinite(fov) || fov < 10 || fov > 75) {
  console.error('--fov precisa estar entre 10 e 75 graus, a faixa do viewer.');
  process.exit(1);
}
if (!Number.isFinite(pitch) || pitch < -90 || pitch > 90) {
  console.error('--pitch precisa estar entre -90 e 90 graus.');
  process.exit(1);
}
if (!Number.isInteger(amostra) || amostra < 1) {
  console.error('--sample precisa ser um inteiro maior que zero.');
  process.exit(1);
}
if (!Number.isInteger(totalYaws) || totalYaws < 1) {
  console.error('--yaws precisa ser um inteiro maior que zero.');
  process.exit(1);
}
if (!Number.isInteger(margemProducao) || margemProducao < 0) {
  console.error('--margem precisa ser um inteiro maior ou igual a zero.');
  process.exit(1);
}
if (!Number.isInteger(censoPorProjeto) || censoPorProjeto < 1) {
  console.error('--censo precisa ser um inteiro maior que zero.');
  process.exit(1);
}

// A razao SIMULADA para com mensagem, e nunca cai calada no padrao. Uma escada
// diferente da pedida muda a grade inteira, e o sintoma seria uma tabela
// plausivel medindo outra coisa.
let razaoSimulada = null;
if (razaoArg !== null) {
  const n = Number.parseFloat(razaoArg);
  if (!Number.isFinite(n) || n <= 1) {
    console.error(`--razao precisa de um numero maior que 1, recebeu "${razaoArg}".`);
    process.exit(1);
  }
  razaoSimulada = n;
}

const viewports = viewportsArg.split(',').map((texto) => {
  const m = /^(\d+)x(\d+)$/.exec(texto.trim());
  if (!m) {
    console.error(`Viewport invalido: "${texto}". Use LARGURAxALTURA, ex. 1920x1080.`);
    process.exit(1);
  }
  return { rotulo: texto.trim(), cssW: parseInt(m[1], 10), cssH: parseInt(m[2], 10) };
});

// O ideal geometrico sai SEMPRE, para servir de referencia. A margem da
// producao entra ao lado dele; quando as duas coincidem, uma linha basta.
const margens = margemProducao === 0 ? [0] : [0, margemProducao];
const rotuloMargem = (m) => (m === 0 ? 'ideal (margem 0)' : `producao (margem ${m})`);

/**
 * As tres estrategias de fundo, na ordem da mais barata para a de hoje.
 *
 * O preview entra nas TRES, porque o cliente ja o baixa para a lista de fotos e
 * ele nao e escolha nenhuma. O que muda e o que vem DEPOIS dele.
 * @constant {Array<{id:string,rotulo:string}>}
 */
const ESTRATEGIAS = [
  { id: 'preview', rotulo: 'preview' },
  { id: 'nivel0vis', rotulo: 'nivel0vis' },
  { id: 'nivel0', rotulo: 'nivel0' },
];

// ---------------------------------------------------------------- bancos

const indexPath = resolve(dataDir, 'index.db');
if (!existsSync(indexPath)) {
  console.error(`index.db nao encontrado em ${indexPath}`);
  process.exit(1);
}

const indexDb = new Database(indexPath, { readonly: true });
const projeto = indexDb
  .prepare('SELECT id, slug, name, db_filename FROM projects WHERE slug = ?')
  .get(slug);
if (!projeto) {
  console.error(`Projeto ${slug} nao existe em ${indexPath}.`);
  process.exit(1);
}

const imagensPath = join(dataDir, 'projects', projeto.db_filename);
if (!existsSync(imagensPath)) {
  console.error(`Banco de imagens nao encontrado em ${imagensPath}.`);
  process.exit(1);
}

// O arquivo de tiles e SEPARADO do de imagens, por decisao de contrato: a
// piramide se reconstroi sem reescrever os BLOBs de multiplos MB de `images`.
const tilesPath = join(dataDir, 'projects', `${slug}_tiles.db`);
if (!existsSync(tilesPath)) {
  console.error(`Banco de tiles nao encontrado em ${tilesPath}.`);
  console.error('Gere a piramide deste projeto antes de medir: sem ela a variante C nao tem byte nenhum para somar.');
  process.exit(1);
}

const imagensDb = new Database(imagensPath, { readonly: true });
const tilesDb = new Database(tilesPath, { readonly: true });
for (const db of [indexDb, imagensDb, tilesDb]) {
  db.pragma('busy_timeout = 5000');
  db.pragma('cache_size = -32000');
}

// ---------------------------------------------------------------- piramides

// A razao e coluna NOVA. Um banco gerado antes dela nao a tem, e um SELECT
// direto morreria com "no such column". O fallback e explicito e vai avisado na
// saida: piramide antiga foi construida com a escada classica de metades.
const colunasPiramide = new Set(
  tilesDb.prepare('PRAGMA table_info(tile_pyramids)').all().map((c) => c.name)
);
const razaoGravadaExiste = colunasPiramide.has('razao');
const piramides = new Map(
  tilesDb
    .prepare(`
      SELECT photo_id, tile_size, max_level, width, height, quality, tile_count, total_bytes,
             ${razaoGravadaExiste ? 'razao' : RAZAO_PADRAO} AS razao
      FROM tile_pyramids
    `)
    .all()
    .map((r) => [r.photo_id, r])
);

if (piramides.size === 0) {
  console.error(`${tilesPath} nao tem nenhuma linha em tile_pyramids.`);
  process.exit(1);
}

// O preview sai do index.db, que guarda o tamanho MEDIDO na ingestao. O BLOB
// mora no banco do projeto, e as duas medidas tem que bater: se discordarem, uma
// das duas esta velha, e o alarme no fim da saida diz quantas.
const fotosDoProjeto = indexDb
  .prepare(`
    SELECT ph.id, ph.display_name, ph.sequence_number, ph.preview_size_bytes, ph.full_size_bytes
    FROM photos ph
    WHERE ph.project_id = ?
      AND ph.id NOT IN (SELECT photo_id FROM deleted_photos)
    ORDER BY ph.sequence_number
  `)
  .all(projeto.id);

const comPiramide = fotosDoProjeto.filter((f) => piramides.has(f.id));
if (comPiramide.length === 0) {
  console.error(`Nenhuma foto viva de ${slug} tem piramide em ${tilesPath}.`);
  process.exit(1);
}

// Amostra por PASSO ao longo da sequencia, nunca as N primeiras: fotos vizinhas
// de uma mesma faixa olham quase a mesma cena, e um bloco contiguo mediria uma
// parede so. O passo espalha a amostra pelo projeto inteiro e e deterministico,
// entao duas execucoes comparam as mesmas fotos.
const alvo = Math.min(amostra, comPiramide.length);
const passo = Math.max(1, Math.floor(comPiramide.length / alvo));
const selecionadas = [];
for (let i = 0; selecionadas.length < alvo && i < comPiramide.length; i += passo) {
  selecionadas.push(comPiramide[i]);
}

// Uma razao gravada por projeto. Duas razoes no mesmo banco significam piramide
// meio reconstruida, e ai nao existe "a escada do projeto" para reportar.
const razoesGravadas = new Set(selecionadas.map((f) => piramides.get(f.id).razao));
if (razoesGravadas.size > 1) {
  console.error(`A amostra mistura razoes gravadas (${[...razoesGravadas].join(', ')}).`);
  console.error('A piramide foi reconstruida pela metade. Refaca antes de medir.');
  process.exit(1);
}
const razaoGravada = [...razoesGravadas][0];
const razaoUsada = razaoSimulada ?? razaoGravada;
const simulando = razaoSimulada !== null && razaoSimulada !== razaoGravada;

// A escada e a mesma para todas as fotos de um projeto homogeneo, mas cada foto
// carrega a sua: um projeto com dois formatos nao pode ser medido por uma so.
// A altura de cada nivel vem de divisoes sucessivas pela RAZAO GRAVADA, a regra
// do GERADOR, e nao de proporcao recalculada: era ai que o benchmark inventava
// uma linha a mais no fim da grade e pedia tile que o banco nao tem.
const escadaPorFoto = new Map();
const divergentes = [];
for (const foto of selecionadas) {
  const p = piramides.get(foto.id);
  const gravada = montarEscada(p.width, p.height, p.tile_size, p.razao);
  // O max_level gravado tem que bater com a escada do modulo. Se nao bater, a
  // piramide foi construida com outra regra, e comparar nivel a nivel mentiria.
  if (gravada.length - 1 !== p.max_level) {
    divergentes.push({ foto: foto.display_name, gravado: p.max_level, calculado: gravada.length - 1 });
  }
  const usada = simulando ? montarEscada(p.width, p.height, p.tile_size, razaoUsada) : gravada;
  escadaPorFoto.set(foto.id, { gravada, usada });
}
if (divergentes.length) {
  console.error('max_level gravado diverge da escada de pyramid-math.js nestas fotos:');
  console.table(divergentes);
  process.exit(1);
}

// A tabela reporta UMA escolha de nivel por viewport, entao ela so tem sentido
// se todas as fotos da amostra tiverem o mesmo formato nativo. Num projeto que
// misture 5760 e 7680 a linha diria o nivel da primeira foto e mentiria sobre
// as outras; melhor parar e pedir a medida por formato.
const formatos = new Set(selecionadas.map((f) => {
  const p = piramides.get(f.id);
  return `${p.width}x${p.height}@${p.tile_size}`;
}));
if (formatos.size > 1) {
  console.error(`A amostra mistura formatos nativos (${[...formatos].join(', ')}).`);
  console.error('Meca um formato por vez: a escolha de nivel e reportada por viewport, nao por foto.');
  process.exit(1);
}

// ---------------------------------------------------------------- consultas

const bytesDaImagem = imagensDb.prepare(`
  SELECT length(full_webp) AS full_bytes, length(preview_webp) AS preview_bytes
  FROM images WHERE photo_id = ?
`);
const blobDoFull = imagensDb.prepare('SELECT full_webp FROM images WHERE photo_id = ?');
const bytesDoTile = tilesDb.prepare(`
  SELECT length(webp) AS bytes FROM tiles
  WHERE photo_id = ? AND level = ? AND x = ? AND y = ?
`);

// length() nao materializa o BLOB, mas a varredura se repete a cada yaw, a cada
// margem e a cada viewport, entao o cache poupa consulta sem custar memoria.
const cacheTile = new Map();
let tilesFaltando = 0;
const buracos = new Set();

/**
 * Bytes reais de um tile gravado, lidos do banco. Conta o buraco quando falta.
 * @param {string} photoId - Foto.
 * @param {number} level - Nivel GRAVADO, que na simulacao nao e o nivel da escada usada.
 * @param {number} x - Coluna.
 * @param {number} y - Linha.
 * @returns {number} Bytes do BLOB, ou 0 se ele nao existe.
 */
function tileBytesDoBanco(photoId, level, x, y) {
  // O prefixo separa as duas fontes no MESMO cache. Sem ele, um nivel indexado
  // por indice (banco) e um indexado por largura (sharp) poderiam colidir na
  // mesma chave, e o numero errado sairia calado.
  const chave = `banco|${photoId}|${level}|${x}|${y}`;
  if (cacheTile.has(chave)) return cacheTile.get(chave);
  const linha = bytesDoTile.get(photoId, level, x, y);
  const bytes = linha ? linha.bytes : 0;
  if (!linha) {
    tilesFaltando++;
    buracos.add(`${photoId} nivel ${level}`);
  }
  cacheTile.set(chave, bytes);
  return bytes;
}

/**
 * De onde vem o byte de um nivel da escada USADA.
 *
 * Um nivel simulado que casa em largura, altura e grade com um nivel gravado e
 * o MESMO nivel: mudou o indice, nao o pixel. Ai o byte se le do banco, pelo
 * indice gravado. Quando nao casa, o nivel nao existe em disco e sai de sharp.
 * @param {string} photoId - Foto.
 * @param {{width:number,height:number,cols:number,rows:number}} nivel - Nivel da escada usada.
 * @returns {{fonte:'banco'|'sharp', level:number|null}}
 */
function origemDoNivel(photoId, nivel) {
  const { gravada } = escadaPorFoto.get(photoId);
  const casa = gravada.find((g) => g.width === nivel.width && g.height === nivel.height
    && g.cols === nivel.cols && g.rows === nivel.rows);
  return casa ? { fonte: 'banco', level: casa.level } : { fonte: 'sharp', level: null };
}

// Os buffers RAW sao grandes (7680x3840x3 sao 88 MB), entao o cache guarda UM
// de cada, e nao um por foto. O laco visita uma foto de cada vez, e mantem os
// dois vivos so enquanto ela esta em medicao.
let rawNativoCache = null;
let rawNivelCache = null;
let tilesGerados = 0;

/**
 * O RAW nativo de uma foto, decodificado uma vez so.
 * @param {string} photoId - Foto.
 * @returns {Promise<{data:Buffer,width:number,height:number,canais:number}>}
 */
async function rawNativo(photoId) {
  if (rawNativoCache && rawNativoCache.photoId === photoId) return rawNativoCache;
  const linha = blobDoFull.get(photoId);
  if (!linha) throw new Error(`Foto ${photoId} sem full_webp em ${imagensPath}`);
  const { data, info } = await sharp(linha.full_webp).raw().toBuffer({ resolveWithObject: true });
  rawNativoCache = { photoId, data, width: info.width, height: info.height, canais: info.channels };
  return rawNativoCache;
}

/**
 * O RAW de um nivel simulado, reduzido do nativo pela regra do GERADOR.
 *
 * `fit: 'fill'` e `kernel: 'lanczos3'` sao os do generate-tiles.js. Qualquer
 * outra reducao produziria bytes que a producao nunca serviria, e a simulacao
 * mediria uma imagem que nao e a que seria gravada.
 * @param {string} photoId - Foto.
 * @param {{width:number,height:number}} nivel - Nivel da escada usada.
 * @returns {Promise<{data:Buffer,width:number,height:number,canais:number}>}
 */
async function rawDoNivel(photoId, nivel) {
  const chave = `${photoId}|${nivel.width}x${nivel.height}`;
  if (rawNivelCache && rawNivelCache.chave === chave) return rawNivelCache;
  const nativo = await rawNativo(photoId);
  if (nivel.width === nativo.width && nivel.height === nativo.height) {
    rawNivelCache = { chave, data: nativo.data, width: nativo.width, height: nativo.height, canais: nativo.canais };
    return rawNivelCache;
  }
  const reduzido = await sharp(nativo.data, {
    raw: { width: nativo.width, height: nativo.height, channels: nativo.canais },
  })
    .resize(nivel.width, nivel.height, { fit: 'fill', kernel: 'lanczos3' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  rawNivelCache = {
    chave,
    data: reduzido.data,
    width: nivel.width,
    height: nivel.height,
    canais: reduzido.info.channels,
  };
  return rawNivelCache;
}

/**
 * Bytes de um tile que o banco NAO tem, gerado com sharp e medido.
 *
 * A borda sai RECORTADA, como no gerador: a ultima coluna mede o que sobrou da
 * largura, e a ultima linha o que sobrou da altura. Tile de borda completado
 * ate 512 pesaria mais do que o que a producao gravaria.
 *
 * CONTRAPROVA FEITA. Este caminho foi rodado contra um nivel que JA existe no
 * banco, o de 1920 do museu_cms: os 8 tiles sairam com o mesmo sha256 dos
 * gravados. Nao sao bytes parecidos, sao os mesmos bytes. Por isso a simulacao
 * pode ir a tabela ao lado do que foi lido do banco, com o rotulo `fonte`.
 * @param {string} photoId - Foto.
 * @param {object} nivel - Nivel da escada usada.
 * @param {number} tileSize - Lado do tile.
 * @param {number} qualidade - Qualidade WebP da piramide.
 * @param {number} x - Coluna.
 * @param {number} y - Linha.
 * @returns {Promise<number>} Bytes do WebP produzido.
 */
async function tileBytesGerado(photoId, nivel, tileSize, qualidade, x, y) {
  const chave = `sharp|${photoId}|${nivel.width}|${x}|${y}`;
  if (cacheTile.has(chave)) return cacheTile.get(chave);
  const raw = await rawDoNivel(photoId, nivel);
  const largura = Math.min(tileSize, nivel.width - x * tileSize);
  const altura = Math.min(tileSize, nivel.height - y * tileSize);
  const webp = await sharp(raw.data, {
    raw: { width: raw.width, height: raw.height, channels: raw.canais },
  })
    .extract({ left: x * tileSize, top: y * tileSize, width: largura, height: altura })
    .webp({ quality: qualidade })
    .toBuffer();
  cacheTile.set(chave, webp.length);
  tilesGerados++;
  return webp.length;
}

/**
 * Bytes de um tile da escada USADA, do banco ou de sharp, sempre medidos.
 * @param {string} photoId - Foto.
 * @param {object} nivel - Nivel da escada usada.
 * @param {number} tileSize - Lado do tile.
 * @param {number} qualidade - Qualidade WebP da piramide.
 * @param {number} x - Coluna.
 * @param {number} y - Linha.
 * @returns {Promise<number>} Bytes do tile.
 */
async function bytesDeUmTile(photoId, nivel, tileSize, qualidade, x, y) {
  const origem = origemDoNivel(photoId, nivel);
  if (origem.fonte === 'banco') return tileBytesDoBanco(photoId, origem.level, x, y);
  return tileBytesGerado(photoId, nivel, tileSize, qualidade, x, y);
}

/**
 * Soma os bytes de uma lista de tiles do mesmo nivel.
 * @param {string} photoId - Foto.
 * @param {object} nivel - Nivel da escada usada.
 * @param {number} tileSize - Lado do tile.
 * @param {number} qualidade - Qualidade WebP da piramide.
 * @param {Array<{x:number,y:number}>} lista - Tiles a somar.
 * @returns {Promise<number>} Soma em bytes.
 */
async function somarTiles(photoId, nivel, tileSize, qualidade, lista) {
  let total = 0;
  for (const t of lista) total += await bytesDeUmTile(photoId, nivel, tileSize, qualidade, t.x, t.y);
  return total;
}

const cacheNivelInteiro = new Map();

/**
 * Bytes de um nivel INTEIRO, o fundo caro que a producao baixa hoje.
 * @param {string} photoId - Foto.
 * @param {object} nivel - Nivel da escada usada.
 * @param {number} tileSize - Lado do tile.
 * @param {number} qualidade - Qualidade WebP da piramide.
 * @returns {Promise<{bytes:number, tiles:number}>} Soma e contagem do nivel.
 */
async function nivelInteiroBytes(photoId, nivel, tileSize, qualidade) {
  const chave = `${photoId}|${nivel.width}`;
  if (cacheNivelInteiro.has(chave)) return cacheNivelInteiro.get(chave);
  const lista = [];
  for (let x = 0; x < nivel.cols; x++) {
    for (let y = 0; y < nivel.rows; y++) lista.push({ x, y });
  }
  const bytes = await somarTiles(photoId, nivel, tileSize, qualidade, lista);
  const valor = { bytes, tiles: lista.length };
  cacheNivelInteiro.set(chave, valor);
  return valor;
}

/**
 * Gera a imagem inteira do nivel (variante B) e mede os bytes REAIS dela.
 *
 * A variante B e a regua do piloto, entao ela nao pode ser estimada. sharp
 * reamostra o full e re-codifica em WebP na mesma qualidade da piramide, e o
 * numero que volta e o tamanho do buffer produzido.
 *
 * No nivel nativo NAO reamostra nada: ali a variante B entrega exatamente o
 * full que a variante A ja entrega hoje, e re-codificar produziria um byte
 * ligeiramente diferente do que o servico serve de verdade.
 * @param {string} photoId - Foto.
 * @param {object} nivel - Nivel escolhido.
 * @param {number} nativa - Largura nativa da foto.
 * @param {number} qualidade - Qualidade WebP da piramide.
 * @param {number} fullBytes - Bytes do full ja armazenado.
 * @returns {Promise<{bytes:number, gerado:boolean}>} Bytes e se houve reamostragem.
 */
async function bytesDaVarianteB(photoId, nivel, nativa, qualidade, fullBytes) {
  if (nivel.width >= nativa) return { bytes: fullBytes, gerado: false };
  const linha = blobDoFull.get(photoId);
  if (!linha) throw new Error(`Foto ${photoId} sem full_webp em ${imagensPath}`);
  const buffer = await sharp(linha.full_webp)
    .resize(nivel.width, nivel.height, { fit: 'fill' })
    .webp({ quality: qualidade })
    .toBuffer();
  return { bytes: buffer.length, gerado: true };
}

// ---------------------------------------------------------------- medicao

const mediana = (v) => {
  if (!v.length) return 0;
  const ord = v.slice().sort((a, b) => a - b);
  return ord[Math.floor(ord.length / 2)];
};
const media = (v) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0);
const p90 = (v) => {
  if (!v.length) return 0;
  const ord = v.slice().sort((a, b) => a - b);
  return ord[Math.min(ord.length - 1, Math.floor(ord.length * 0.9))];
};
const kb = (b) => `${(b / 1024).toFixed(1)} KB`;
const mb = (b) => `${(b / (1024 * 1024)).toFixed(2)} MB`;
const gb = (b) => `${(b / (1024 ** 3)).toFixed(1)} GB`;
const razaoEntre = (a, b) => (b > 0 ? (a / b).toFixed(2) : 'n/d');
const pct = (x) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(0)}%`;

// O preview vem do index.db, que e onde ele foi MEDIDO na ingestao. O BLOB do
// projeto e a segunda medida do mesmo parametro: as duas tem que dar igual, e a
// divergencia vira alarme em vez de virar media silenciosa.
const bytesBase = new Map();
const previewDivergente = [];
for (const foto of selecionadas) {
  const linha = bytesDaImagem.get(foto.id);
  if (!linha) {
    console.error(`Foto ${foto.display_name} (${foto.id}) tem piramide mas nao tem linha em images.`);
    process.exit(1);
  }
  if (foto.preview_size_bytes !== null && foto.preview_size_bytes !== linha.preview_bytes) {
    previewDivergente.push({
      foto: foto.display_name,
      'index.db': foto.preview_size_bytes,
      'blob': linha.preview_bytes,
    });
  }
  bytesBase.set(foto.id, {
    full_bytes: linha.full_bytes,
    preview_bytes: foto.preview_size_bytes ?? linha.preview_bytes,
  });
}

const yaws = Array.from({ length: totalYaws }, (_, i) => (i * 360) / totalYaws);
const resultados = [];
const inicio = Date.now();

for (const vp of viewports) {
  const larguraPx = Math.round(vp.cssW * dpr);
  const alturaPx = Math.round(vp.cssH * dpr);
  const hfov = fovHorizontal(fov, larguraPx / alturaPx);
  const necessaria = larguraNecessaria(larguraPx, alturaPx, fov);

  // A camera do modulo fala em lon/lat, nao em yaw/pitch: lon e a direcao, lat
  // e a elevacao, e `fov` continua sendo a VERTICAL, que o modulo converte.
  const cameraBase = { lat: pitch, fov, largura: larguraPx, altura: alturaPx };

  const porFoto = [];
  for (const foto of selecionadas) {
    const { usada: escada } = escadaPorFoto.get(foto.id);
    const p = piramides.get(foto.id);
    const level = escolherNivel(escada, necessaria);
    const nivel = escada.find((n) => n.level === level) ?? escada[escada.length - 1];
    const nivelFundo = escada[0];
    const nativo = escada[escada.length - 1];
    const base = bytesBase.get(foto.id);

    const b = await bytesDaVarianteB(foto.id, nivel, nativo.width, p.quality, base.full_bytes);

    // Quando o proprio nivel escolhido JA e o nivel 0, nao existe fundo a somar:
    // as tres estrategias colapsam no preview, e somar o nivel 0 de novo
    // contaria o mesmo byte duas vezes.
    const temFundo = nivel.level !== nivelFundo.level;
    const fundoInteiro = temFundo
      ? await nivelInteiroBytes(foto.id, nivelFundo, p.tile_size, p.quality)
      : { bytes: 0, tiles: 0 };

    // Um par (foto, yaw) e uma medida: os tiles do ceu comprimem melhor que os
    // da parede, entao a direcao da camera muda os bytes de C de verdade.
    const porMargem = [];
    for (const margem of margens) {
      const porYaw = [];
      for (const lon of yaws) {
        const camera = { ...cameraBase, lon };
        const vistos = tilesVisiveis(nivel, p.tile_size, camera, margem);
        const bytesVistos = await somarTiles(foto.id, nivel, p.tile_size, p.quality, vistos);
        const fundoVis = temFundo
          ? tilesVisiveis(nivelFundo, p.tile_size, camera, margem)
          : [];
        const bytesFundoVis = temFundo
          ? await somarTiles(foto.id, nivelFundo, p.tile_size, p.quality, fundoVis)
          : 0;
        porYaw.push({
          lon,
          tiles: vistos.length,
          bytes: bytesVistos,
          fundoVisTiles: fundoVis.length,
          fundoVisBytes: bytesFundoVis,
        });
      }

      const porEstrategia = {};
      for (const e of ESTRATEGIAS) {
        const extraBytes = (y) => {
          if (e.id === 'preview') return 0;
          if (e.id === 'nivel0vis') return y.fundoVisBytes;
          return fundoInteiro.bytes;
        };
        const extraTiles = (y) => {
          if (e.id === 'preview') return 0;
          if (e.id === 'nivel0vis') return y.fundoVisTiles;
          return fundoInteiro.tiles;
        };
        porEstrategia[e.id] = {
          bytes: porYaw.map((y) => base.preview_bytes + extraBytes(y) + y.bytes),
          fundo: porYaw.map((y) => base.preview_bytes + extraBytes(y)),
          requests: porYaw.map((y) => 1 + extraTiles(y) + y.tiles),
        };
      }

      porMargem.push({
        margem,
        porEstrategia,
        tilesVistos: porYaw.map((y) => y.tiles),
        fundoVisTiles: porYaw.map((y) => y.fundoVisTiles),
      });
    }

    porFoto.push({
      photoId: foto.id,
      displayName: foto.display_name,
      nivel: nivel.level,
      larguraEntregue: nivel.width,
      alturaEntregue: nivel.height,
      fonteNivel: origemDoNivel(foto.id, nivel).fonte,
      fonteFundo: temFundo ? origemDoNivel(foto.id, nivelFundo).fonte : 'nenhuma',
      bytesA: base.preview_bytes + base.full_bytes,
      bytesB: base.preview_bytes + b.bytes,
      bytesBGerado: b.gerado,
      tilesFundo: fundoInteiro.tiles,
      larguraFundo: nivelFundo.width,
      porMargem,
    });
  }

  const vetorA = porFoto.map((f) => f.bytesA);
  const vetorB = porFoto.map((f) => f.bytesB);

  const porMargem = margens.map((margem, iM) => {
    const vetorTiles = porFoto.flatMap((f) => f.porMargem[iM].tilesVistos);
    const vetorFundoVis = porFoto.flatMap((f) => f.porMargem[iM].fundoVisTiles);
    const porEstrategia = ESTRATEGIAS.map((e) => {
      const bytes = porFoto.flatMap((f) => f.porMargem[iM].porEstrategia[e.id].bytes);
      const fundo = porFoto.flatMap((f) => f.porMargem[iM].porEstrategia[e.id].fundo);
      const requests = porFoto.flatMap((f) => f.porMargem[iM].porEstrategia[e.id].requests);
      return {
        id: e.id,
        rotulo: e.rotulo,
        media: media(bytes),
        p90: p90(bytes),
        fundoMedio: media(fundo),
        requestsMediano: mediana(requests),
      };
    });
    return {
      margem,
      rotulo: rotuloMargem(margem),
      tilesMedianos: mediana(vetorTiles),
      tilesMax: Math.max(...vetorTiles),
      fundoVisMediano: mediana(vetorFundoVis),
      porEstrategia,
    };
  });

  resultados.push({
    viewport: vp.rotulo,
    larguraPx,
    alturaPx,
    hfov,
    necessaria,
    nivel: porFoto[0].nivel,
    larguraEntregue: porFoto[0].larguraEntregue,
    alturaEntregue: porFoto[0].alturaEntregue,
    larguraNativa: escadaPorFoto.get(porFoto[0].photoId).usada.slice(-1)[0].width,
    larguraFundo: porFoto[0].larguraFundo,
    fonteNivel: porFoto[0].fonteNivel,
    fonteFundo: porFoto[0].fonteFundo,
    bGerado: porFoto.some((f) => f.bytesBGerado),
    tilesFundo: porFoto[0].tilesFundo,
    A: { media: media(vetorA), p90: p90(vetorA) },
    B: { media: media(vetorB), p90: p90(vetorB) },
    requestsA: 2,
    requestsB: 2,
    porMargem,
    porFoto,
  });
}

const segundos = ((Date.now() - inicio) / 1000).toFixed(1);

// A linha que decide o piloto e a da margem de PRODUCAO, nunca a do ideal: e
// essa que o cliente pede quando o operador arrasta a camera.
const iProducao = margens.length - 1;

/**
 * De onde vieram os bytes de uma linha da tabela.
 * @param {object} r - Resultado de um viewport.
 * @param {string} estrategia - Id da estrategia de fundo.
 * @returns {string} 'banco', 'sharp' ou 'banco+sharp'.
 */
function fonteDaLinha(r, estrategia) {
  const fontes = new Set([r.fonteNivel]);
  if (estrategia !== 'preview' && r.fonteFundo !== 'nenhuma') fontes.add(r.fonteFundo);
  return [...fontes].sort().join('+');
}

// ---------------------------------------------------------------- armazenamento

const idsComPiramide = comPiramide.map((f) => f.id);
let armazenamentoFull = 0;
let armazenamentoPreview = 0;
for (const id of idsComPiramide) {
  const linha = bytesDaImagem.get(id);
  if (!linha) continue;
  armazenamentoFull += linha.full_bytes;
  armazenamentoPreview += linha.preview_bytes;
}
const tilesReais = tilesDb.prepare('SELECT SUM(length(webp)) AS bytes, COUNT(*) AS n FROM tiles').get();
const tilesDeclarados = tilesDb
  .prepare('SELECT SUM(total_bytes) AS bytes, SUM(tile_count) AS n FROM tile_pyramids')
  .get();

const armazenamento = {
  fotos: idsComPiramide.length,
  fotosDoProjeto: fotosDoProjeto.length,
  fullBytes: armazenamentoFull,
  previewBytes: armazenamentoPreview,
  tilesBytes: tilesReais.bytes ?? 0,
  tilesContagem: tilesReais.n ?? 0,
  tilesBytesDeclarados: tilesDeclarados.bytes ?? 0,
  tilesContagemDeclarada: tilesDeclarados.n ?? 0,
  razaoTilesSobreFull: armazenamentoFull ? (tilesReais.bytes ?? 0) / armazenamentoFull : 0,
};

// ---------------------------------------------------------------- saida

console.log(`Projeto ${projeto.slug} (${projeto.name})`);
console.log(`Imagens: ${imagensPath}`);
console.log(`Tiles:   ${tilesPath}`);
console.log(`Amostra: ${selecionadas.length} de ${comPiramide.length} fotos com piramide, passo ${passo}.`);
console.log(`Camera:  fov vertical ${fov} graus, pitch ${pitch}, dpr ${dpr}, ${yaws.length} direcoes por foto.`);
console.log(`Geometria: public/calibration/js/pyramid-math.js, o mesmo modulo do cliente.`);
console.log(`Margens medidas: ${margens.map(rotuloMargem).join(' e ')}.`);
console.log(`Razao gravada: ${razaoGravada}${razaoGravadaExiste ? '' : ' (ASSUMIDA: o banco nao tem a coluna razao)'}.`);
if (simulando) {
  console.log(`Razao SIMULADA: ${razaoUsada}. A escada usada NAO e a que esta no banco.`);
  console.log('  Os niveis que a simulacao pede e o banco nao tem sao GERADOS com sharp, na regra do gerador.');
  console.log('  Sao bytes reais de imagem real, e nao tiles servidos hoje. A coluna `fonte` diz qual e qual.');
  console.log('  Isso responde "quanto pesaria", nunca "quanto pesa": o acervo continua na razao gravada.');
} else if (razaoSimulada !== null) {
  // Pedir a razao que ja esta gravada nao e simulacao nenhuma. Dizer isso evita
  // que alguem leia a tabela como orcamento de outra escada.
  console.log(`Razao pedida (${razaoSimulada}) e a mesma gravada: nada foi simulado, tudo saiu do banco.`);
}
console.log(`Medicao em ${segundos}s${tilesGerados ? `, ${tilesGerados} tiles gerados com sharp` : ''}.\n`);

console.log('ESCOLHA DE NIVEL (largura util contra largura entregue)');
console.table(resultados.map((r) => ({
  viewport: r.viewport,
  'px reais': `${r.larguraPx}x${r.alturaPx}`,
  'hfov': `${r.hfov.toFixed(1)} graus`,
  'util (px)': Math.round(r.necessaria),
  'nivel': r.nivel,
  'entregue (px)': `${r.larguraEntregue}x${r.alturaEntregue}`,
  'entregue/util': `${((r.larguraEntregue / r.necessaria) * 100).toFixed(0)}%`,
  'nativa (px)': r.larguraNativa,
  'fonte': r.fonteNivel,
})));

console.log('\nTILES QUE O CLIENTE PEDE (a margem e a folga contra buraco na emenda)');
console.table(resultados.flatMap((r) => r.porMargem.map((m) => ({
  viewport: r.viewport,
  'margem': m.rotulo,
  'tiles (mediana)': m.tilesMedianos,
  'tiles (max)': m.tilesMax,
  [`nivel 0 visivel (${r.larguraFundo} px)`]: m.fundoVisMediano,
  'nivel 0 inteiro': r.tilesFundo,
}))));

console.log('\nBYTES POR FOTO ABERTA, POR ESTRATEGIA DE FUNDO (media da amostra)');
console.log('  preview   = so o preview de 512x256, que o cliente ja baixa para a lista.');
console.log('  nivel0vis = preview + os tiles do nivel 0 que a camera enxerga.');
console.log('  nivel0    = preview + o nivel 0 INTEIRO. E o que a producao faz hoje.');
console.table(resultados.flatMap((r) => r.porMargem.flatMap((m) => m.porEstrategia.map((e) => ({
  viewport: r.viewport,
  'margem': m.rotulo,
  'fundo': e.rotulo,
  'fundo (KB)': kb(e.fundoMedio),
  'A hoje': kb(r.A.media),
  'B inteira': kb(r.B.media),
  'C total': kb(e.media),
  'C/A': razaoEntre(e.media, r.A.media),
  'C/B': razaoEntre(e.media, r.B.media),
  'fonte': fonteDaLinha(r, e.id),
})))));

console.log('\nCAUDA (p90 da amostra: a foto cara, nao a tipica)');
console.table(resultados.flatMap((r) => r.porMargem.flatMap((m) => m.porEstrategia.map((e) => ({
  viewport: r.viewport,
  'margem': m.rotulo,
  'fundo': e.rotulo,
  'A hoje': kb(r.A.p90),
  'B inteira': kb(r.B.p90),
  'C total': kb(e.p90),
})))));

console.log('\nREQUESTS POR FOTO ABERTA (corpo medido; o cabecalho de cada um esta FORA da conta)');
console.table(resultados.flatMap((r) => r.porMargem.flatMap((m) => m.porEstrategia.map((e) => ({
  viewport: r.viewport,
  'margem': m.rotulo,
  'fundo': e.rotulo,
  'A': r.requestsA,
  'B': r.requestsB,
  'C (mediana)': e.requestsMediano,
})))));

console.log('\nARMAZENAMENTO NO SERVIDOR (medido, na razao gravada)');
console.table([{
  'fotos com piramide': `${armazenamento.fotos} de ${armazenamento.fotosDoProjeto}`,
  'razao gravada': razaoGravada,
  'full_webp': mb(armazenamento.fullBytes),
  'tiles': mb(armazenamento.tilesBytes),
  'tiles/full': armazenamento.razaoTilesSobreFull.toFixed(2),
  'tiles (contagem)': armazenamento.tilesContagem,
}]);

// ---------------------------------------------------------------- custo da escada

// As duas telas que foram MEDIDAS na mesa, e nao supostas. Elas entram sempre,
// alem dos viewports da linha de comando: o vao da escada foi descoberto nelas,
// e uma tabela sem elas nao reproduziria o numero que decidiu a razao.
const TELAS_MEDIDAS = [
  { rotulo: 'notebook 1350x673', cssW: 1350, cssH: 673 },
  { rotulo: 'monitor 1904x985', cssW: 1904, cssH: 985 },
];

// O orcamento nao depende de gerar nada: `custoDaEscada` da a area total da
// piramide contra a do nativo, e `escolherNivel` diz o que cada tela pediria.
// E a conta que decide a razao ANTES de queimar dias de CPU no acervo.
console.log('\nCUSTO DA ESCADA POR RAZAO (area, nao bytes; a compressao piora em tile pequeno)');
const tileDoProjeto = piramides.get(selecionadas[0].id).tile_size;
const telasDoOrcamento = [
  ...viewports,
  ...TELAS_MEDIDAS.filter((t) => !viewports.some((v) => v.cssW === t.cssW && v.cssH === t.cssH)),
];
console.log(`  Telas: ${telasDoOrcamento.map((t) => `${t.rotulo} (util ${Math.round(larguraNecessaria(Math.round(t.cssW * dpr), Math.round(t.cssH * dpr), fov))} px)`).join(', ')}.`);
console.log('  A celula diz a largura escolhida e quanto dela sobra sobre a largura util.');
const orcamentoEscada = [];
for (const formato of FORMATOS_ACERVO) {
  const linhas = [];
  for (const r of RAZOES_CANDIDATAS) {
    const escada = montarEscada(formato.width, formato.height, tileDoProjeto, r);
    const linha = {
      'razao': r === razaoGravada ? `${r} (gravada)` : String(r),
      'escada': escada.map((n) => n.width).join('/'),
      'custo': `${custoDaEscada(escada).toFixed(2)}x`,
    };
    const escolhas = [];
    for (const tela of telasDoOrcamento) {
      const necessaria = larguraNecessaria(
        Math.round(tela.cssW * dpr), Math.round(tela.cssH * dpr), fov
      );
      const level = escolherNivel(escada, necessaria);
      const nivel = escada.find((n) => n.level === level);
      const sobra = nivel.width / necessaria - 1;
      // Sobra negativa nao e economia: e a tela pedindo mais do que existe. O
      // nivel nativo satura, e o operador ve a foto menos nitida do que a tela
      // aguenta. Por isso o rotulo separa os dois casos.
      const satura = nivel.width >= escada[escada.length - 1].width && sobra < 0;
      linha[tela.rotulo] = `${nivel.width} (${satura ? 'satura ' : ''}${pct(sobra)})`;
      escolhas.push({ tela: tela.rotulo, util: Math.round(necessaria), escolhe: nivel.width, sobra, satura });
    }
    linhas.push(linha);
    orcamentoEscada.push({
      formato: `${formato.width}x${formato.height}`,
      razao: r,
      escada: escada.map((n) => n.width),
      custo: custoDaEscada(escada),
      escolhas,
    });
  }
  console.log(`\n  ${formato.width}x${formato.height}, tile ${tileDoProjeto}`);
  console.table(linhas);
}

// O veredito da razao nao se AFIRMA: ele sai da propria tabela acima. Duas
// contas decidem. O pior desperdicio de cada formato, e quantas telas mudam de
// escolha quando a razao muda. Zero telas mudando quer dizer que a escada ja
// casa, e que razao menor so acrescentaria armazenamento.
const linhaDoOrcamento = (largura, r) => orcamentoEscada
  .find((o) => o.formato.startsWith(`${largura}x`) && o.razao === r);
const piorSobra = (largura, r) => {
  const linha = linhaDoOrcamento(largura, r);
  return linha ? Math.max(...linha.escolhas.map((e) => e.sobra)) : 0;
};
const telasQueMudam = (largura, r) => {
  const base = linhaDoOrcamento(largura, RAZOES_CANDIDATAS[0]);
  const alvo = linhaDoOrcamento(largura, r);
  if (!base || !alvo) return 0;
  return alvo.escolhas.filter((e, i) => e.escolhe !== base.escolhas[i].escolhe).length;
};
const razaoBase = RAZOES_CANDIDATAS[0];
const candidata = RAZOES_CANDIDATAS[1];
const telas = telasDoOrcamento.length;
console.log(`\n  Na razao ${razaoBase}, o pior desperdicio e ${pct(piorSobra(7680, razaoBase))} em 7680 e ${pct(piorSobra(5760, razaoBase))} em 5760.`);
for (const formato of FORMATOS_ACERVO) {
  const mudam = telasQueMudam(formato.width, candidata);
  const antes = pct(piorSobra(formato.width, razaoBase));
  const depois = pct(piorSobra(formato.width, candidata));
  if (mudam === 0) {
    console.log(`  Em ${formato.width}, a razao ${candidata} muda a escolha em 0 de ${telas} telas: a escada JA CASA.`);
    console.log(`    Razao menor so acrescentaria armazenamento, e o desperdicio segue em ${antes}.`);
  } else {
    console.log(`  Em ${formato.width}, a razao ${candidata} muda a escolha em ${mudam} de ${telas} telas.`);
    console.log(`    O pior desperdicio cai de ${antes} para ${depois}.`);
  }
}
console.log('  A troca de razao so se justifica onde a tela satura no nativo e paga pixel a toa.');

// ---------------------------------------------------------------- acervo

/**
 * Le a largura e a altura do CABECALHO de um WebP, sem decodificar a imagem.
 *
 * O censo do acervo precisa do formato de ~99 mil fotos. Decodificar cada uma
 * com sharp custaria horas; o cabecalho custa 32 bytes. As tres variantes de
 * contentor entram porque o acervo tem arquivos de tres geracoes de ingestao.
 * Contraprova feita: nos 29 projetos o cabecalho deu o mesmo que sharp.
 *
 * @param {Buffer} buf - Os primeiros bytes do arquivo.
 * @returns {{width:number,height:number}|null} Dimensoes, ou null se ilegivel.
 */
function dimensoesWebp(buf) {
  if (!buf || buf.length < 30) return null;
  if (buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WEBP') return null;
  const fourcc = buf.toString('latin1', 12, 16);
  if (fourcc === 'VP8 ') {
    if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return null;
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  if (fourcc === 'VP8L') {
    if (buf[20] !== 0x2f) return null;
    const bits = buf.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (fourcc === 'VP8X') {
    return {
      width: (buf[24] | (buf[25] << 8) | (buf[26] << 16)) + 1,
      height: (buf[27] | (buf[28] << 8) | (buf[29] << 16)) + 1,
    };
  }
  return null;
}

/**
 * Censo de formato do acervo, por AMOSTRA de fotos de cada projeto.
 *
 * A contagem de fotos e a soma de `full_size_bytes` saem do index.db, e essas
 * sao exatas. O FORMATO nao esta no index.db, entao ele sai de uma amostra de
 * cabecalhos por projeto. Dois projetos medidos (tubarao e blumenau) misturam
 * 7680 e 5760, entao o censo guarda a PROPORCAO da amostra e reparte os bytes
 * do projeto por ela, em vez de fingir um formato unico.
 *
 * Por que amostra e nao censo completo: a leitura de um cabecalho por chave
 * primaria custou 19 ms medidos num banco de 8,6 GB. O acervo inteiro levaria
 * cerca de 30 minutos, e a proporcao por projeto e estavel.
 *
 * @param {number} porProjeto - Fotos amostradas em cada projeto.
 * @returns {{porFormato:Map<string,{fotos:number,fullBytes:number}>, projetos:Array<object>, semArquivo:string[], ilegiveis:number}}
 */
function censoDoAcervo(porProjeto) {
  const porFormato = new Map();
  const projetos = [];
  const semArquivo = [];
  let ilegiveis = 0;

  const listaProjetos = indexDb.prepare('SELECT id, slug, db_filename FROM projects ORDER BY slug').all();
  const fotosDe = indexDb.prepare(`
    SELECT ph.id, ph.full_size_bytes
    FROM photos ph
    WHERE ph.project_id = ?
      AND ph.id NOT IN (SELECT photo_id FROM deleted_photos)
    ORDER BY ph.sequence_number
  `);

  for (const proj of listaProjetos) {
    const caminho = join(dataDir, 'projects', proj.db_filename);
    const fotos = fotosDe.all(proj.id);
    if (fotos.length === 0) continue;
    const bytesDoProjeto = fotos.reduce((soma, f) => soma + (f.full_size_bytes ?? 0), 0);
    if (!existsSync(caminho)) {
      semArquivo.push(proj.slug);
      continue;
    }

    const db = new Database(caminho, { readonly: true });
    db.pragma('busy_timeout = 5000');
    const cabecalho = db.prepare('SELECT substr(full_webp, 1, 32) AS cab FROM images WHERE photo_id = ?');
    // Amostra por passo, e nao as N primeiras: um projeto que trocou de camera
    // no meio da campanha tem as duas geracoes, e o bloco inicial esconderia a
    // segunda.
    const passoCenso = Math.max(1, Math.floor(fotos.length / porProjeto));
    const contagem = new Map();
    let amostrados = 0;
    for (let i = 0; i < fotos.length && amostrados < porProjeto; i += passoCenso) {
      const linha = cabecalho.get(fotos[i].id);
      const dim = linha ? dimensoesWebp(linha.cab) : null;
      if (!dim) { ilegiveis++; continue; }
      const chave = `${dim.width}x${dim.height}`;
      contagem.set(chave, (contagem.get(chave) ?? 0) + 1);
      amostrados++;
    }
    db.close();
    if (amostrados === 0) { semArquivo.push(proj.slug); continue; }

    for (const [chave, n] of contagem) {
      const fracao = n / amostrados;
      const alvo = porFormato.get(chave) ?? { fotos: 0, fullBytes: 0 };
      alvo.fotos += fotos.length * fracao;
      alvo.fullBytes += bytesDoProjeto * fracao;
      porFormato.set(chave, alvo);
    }
    projetos.push({
      slug: proj.slug,
      fotos: fotos.length,
      amostrados,
      formatos: [...contagem.entries()].map(([k, n]) => `${k}:${n}`).join(' '),
      misto: contagem.size > 1,
    });
  }

  return { porFormato, projetos, semArquivo, ilegiveis };
}

/**
 * Ajusta bytes por pixel em funcao da largura do nivel, medindo a piramide.
 *
 * O tile pequeno comprime PIOR por pixel: no museu_cms o nivel de 1920 gastou
 * cerca de 0,074 byte por pixel e o de 7680 cerca de 0,033. Uma projecao por
 * area pura erraria essa curva, e sempre para menos. O ajuste e uma lei de
 * potencia em log-log, com os niveis que existem no banco.
 *
 * @returns {{a:number, b:number, pontos:Array<{width:number,bpp:number}>}|null}
 */
function ajustarBytesPorPixel() {
  const geometrias = new Set([...piramides.values()].map((p) => `${p.width}x${p.height}@${p.tile_size}|${p.razao}`));
  if (geometrias.size !== 1) return null;

  const areaPorNivel = new Map();
  for (const p of piramides.values()) {
    for (const n of montarEscada(p.width, p.height, p.tile_size, p.razao)) {
      const atual = areaPorNivel.get(n.level) ?? { width: n.width, area: 0 };
      atual.area += n.width * n.height;
      areaPorNivel.set(n.level, atual);
    }
  }
  const bytesPorNivel = tilesDb
    .prepare('SELECT level, SUM(length(webp)) AS bytes FROM tiles GROUP BY level')
    .all();

  const pontos = [];
  for (const linha of bytesPorNivel) {
    const nivel = areaPorNivel.get(linha.level);
    if (!nivel || !nivel.area || !linha.bytes) continue;
    pontos.push({ width: nivel.width, bpp: linha.bytes / nivel.area });
  }
  if (pontos.length < 2) return null;

  const x = pontos.map((p) => Math.log(p.width));
  const y = pontos.map((p) => Math.log(p.bpp));
  const mx = media(x);
  const my = media(y);
  let num = 0;
  let den = 0;
  for (let i = 0; i < x.length; i++) {
    num += (x[i] - mx) * (y[i] - my);
    den += (x[i] - mx) ** 2;
  }
  if (den === 0) return null;
  const b = num / den;
  return { a: Math.exp(my - b * mx), b, pontos };
}

if (!semAcervo) {
  const modelo = ajustarBytesPorPixel();
  if (!modelo) {
    console.log('\nEXTRAPOLACAO PARA O ACERVO: pulada.');
    console.log('  A piramide medida nao tem geometria unica, ou tem menos de dois niveis.');
  } else {
    const t0Censo = Date.now();
    const censo = censoDoAcervo(censoPorProjeto);
    const segundosCenso = ((Date.now() - t0Censo) / 1000).toFixed(1);

    const bpp = (w) => modelo.a * w ** modelo.b;
    const bytesModelados = (escada) => escada.reduce((soma, n) => soma + bpp(n.width) * n.width * n.height, 0);

    // A ancora e MEDIDA: bytes por pixel do full nativo da amostra. Ela carrega
    // cena e qualidade juntas, e e o que traduz a curva de bpp desta piramide
    // para uma foto qualquer do acervo.
    const p0 = piramides.get(selecionadas[0].id);
    const escadaMedida = montarEscada(p0.width, p0.height, p0.tile_size, p0.razao);
    const bppNativoMedido = armazenamento.fullBytes / (armazenamento.fotos * p0.width * p0.height);
    const previsto = armazenamento.fotos * bytesModelados(escadaMedida);
    const erroModelo = previsto / armazenamento.tilesBytes - 1;

    const projecao = RAZOES_CANDIDATAS.map((r) => {
      const linha = { 'razao': r === razaoGravada ? `${r} (gravada)` : String(r) };
      let total = 0;
      for (const formato of FORMATOS_ACERVO) {
        const chave = `${formato.width}x${formato.height}`;
        const dados = censo.porFormato.get(chave) ?? { fotos: 0, fullBytes: 0 };
        const escada = montarEscada(formato.width, formato.height, tileDoProjeto, r);
        const bytes = bytesModelados(escada)
          * dados.fullBytes / (formato.width * formato.height * bppNativoMedido);
        linha[`${chave} (${Math.round(dados.fotos)} fotos)`] = gb(bytes);
        total += bytes;
      }
      linha['total'] = gb(total);
      linha['bytes'] = total;
      return linha;
    });
    const totalRazao2 = projecao.find((p) => p.razao.startsWith('2'))?.bytes ?? 0;
    for (const linha of projecao) {
      linha['vs razao 2'] = totalRazao2 ? pct(linha.bytes / totalRazao2 - 1) : 'n/d';
      delete linha.bytes;
    }

    console.log('\nEXTRAPOLACAO PARA O ACERVO (nao e medida do acervo)');
    console.log(`  Base medida: ${armazenamento.fotos} fotos de UM projeto (${projeto.slug}), razao ${razaoGravada}.`);
    console.log(`  Bytes por pixel ajustados em ${modelo.pontos.length} niveis: ${modelo.pontos.map((p) => `${p.width}px=${p.bpp.toFixed(4)}`).join(', ')}.`);
    console.log(`  Curva bpp(w) = ${modelo.a.toFixed(3)} * w^${modelo.b.toFixed(3)}. Erro na propria amostra: ${pct(erroModelo)}.`);
    console.log(`  Formato de cada projeto por AMOSTRA de ate ${censoPorProjeto} cabecalhos WebP, em ${segundosCenso}s.`);
    console.log(`  Contagem de fotos e soma de full_size_bytes: exatas, do index.db.`);
    console.log('  O que isto NAO e: medida. A cena do acervo nao e a do museu, e a compressao muda com ela.');
    console.table(projecao);

    const mistos = censo.projetos.filter((p) => p.misto);
    if (mistos.length) {
      console.log(`  Projetos com formato MISTO na amostra: ${mistos.map((p) => `${p.slug} (${p.formatos})`).join(', ')}.`);
      console.log('  Neles os bytes foram repartidos pela proporcao da amostra, e nao por formato unico.');
    }
    if (censo.semArquivo.length) {
      console.log(`  Projetos fora da conta, sem banco em disco: ${censo.semArquivo.join(', ')}.`);
    }
    if (censo.ilegiveis) {
      console.log(`  ${censo.ilegiveis} cabecalhos ilegiveis, fora da conta.`);
    }
  }
}

// ---------------------------------------------------------------- veredito

// A regua e B, e nao A. O piloto so se justifica se C ganhar da variante que
// nao precisa de piramide nenhuma. Esta secao compara na margem de PRODUCAO e
// escreve a conclusao por extenso, para ninguem ter que dividir de cabeca.
//
// O fundo da comparacao e o BARATO (preview), porque e o desenho recomendado. O
// fundo de hoje entra ao lado para o custo do nivel 0 inteiro ficar visivel.
console.log('\nVEREDITO CONTRA A REGUA (variante B, na margem de producao, fundo preview)');
const porId = (m, id) => m.porEstrategia.find((e) => e.id === id);
const vereditos = resultados.map((r) => {
  const m = r.porMargem[iProducao];
  const cPreview = porId(m, 'preview').media;
  const cNivel0 = porId(m, 'nivel0').media;
  const ganhaDeA = cPreview < r.A.media;
  const ganhaDeB = cPreview < r.B.media;
  let texto;
  if (ganhaDeB) {
    texto = `C ganha de B por ${razaoEntre(r.B.media, cPreview)}x: a piramide se paga aqui.`;
  } else if (ganhaDeA) {
    texto = `C ganha de A mas PERDE para B por ${razaoEntre(cPreview, r.B.media)}x: a piramide NAO se paga.`;
  } else {
    texto = 'C perde de A e de B: neste viewport o fatiamento so custa.';
  }
  return {
    viewport: r.viewport,
    margem: m.rotulo,
    'C+preview': kb(cPreview),
    'C+nivel0': kb(cNivel0),
    'B': kb(r.B.media),
    veredito: texto,
  };
});
console.table(vereditos);

const perdemParaB = resultados.filter((r) => porId(r.porMargem[iProducao], 'preview').media >= r.B.media);
if (perdemParaB.length) {
  console.log(`\nATENCAO: em ${perdemParaB.length} de ${resultados.length} viewports a variante C perde para a B.`);
  console.log(`  Viewports: ${perdemParaB.map((r) => r.viewport).join(', ')}.`);
  console.log('  B entrega os mesmos pixels uteis num request so e sem piramide para construir e manter.');
  console.log('  Ganhar da variante A nao basta para aprovar o piloto.');
}

// O preco do fundo de hoje, por extenso: e o defeito 1 em numero, e nao em
// adjetivo. A media atravessa todos os viewports da rodada.
const fundoCaro = resultados.map((r) => {
  const m = r.porMargem[iProducao];
  return { preview: porId(m, 'preview').fundoMedio, nivel0: porId(m, 'nivel0').fundoMedio };
}).filter((x) => x.nivel0 > x.preview);
if (fundoCaro.length) {
  const mediaPreview = media(fundoCaro.map((x) => x.preview));
  const mediaNivel0 = media(fundoCaro.map((x) => x.nivel0));
  console.log(`\nPRECO DO FUNDO: preview ${kb(mediaPreview)} contra nivel 0 inteiro ${kb(mediaNivel0)}, ${razaoEntre(mediaNivel0, mediaPreview)}x pela MESMA funcao.`);
  console.log('  Google, Photo Sphere Viewer e Marzipano usam uma imagem base borrada, nunca um nivel inteiro.');
}

// ---------------------------------------------------------------- alertas

// A soma real contra a soma declarada e a checagem barata de piramide truncada:
// tile_pyramids escreve o total no fim da construcao, entao uma parada no meio
// deixa as duas diferentes.
if (armazenamento.tilesBytes !== armazenamento.tilesBytesDeclarados
  || armazenamento.tilesContagem !== armazenamento.tilesContagemDeclarada) {
  console.log('\nATENCAO: os tiles gravados nao batem com o que tile_pyramids declara.');
  console.log(`  reais:      ${armazenamento.tilesContagem} tiles, ${armazenamento.tilesBytes} bytes`);
  console.log(`  declarados: ${armazenamento.tilesContagemDeclarada} tiles, ${armazenamento.tilesBytesDeclarados} bytes`);
  console.log('  A piramide esta incompleta ou foi reconstruida pela metade. Refaca antes de decidir por esta tabela.');
}

if (previewDivergente.length) {
  console.log(`\nATENCAO: em ${previewDivergente.length} fotos o preview_size_bytes do index.db discorda do BLOB.`);
  console.table(previewDivergente.slice(0, 10));
  console.log('  Sao duas medidas do MESMO parametro. Uma das duas esta velha, e a tabela usou a do index.db.');
}

if (tilesFaltando > 0) {
  console.log(`\nATENCAO: ${tilesFaltando} leituras cairam em tile inexistente, em ${buracos.size} foto/nivel.`);
  console.log('  Os bytes da variante C saem SUBESTIMADOS. Refaca a piramide antes de usar esta tabela.');
}

if (!razaoGravadaExiste) {
  console.log(`\nATENCAO: ${tilesPath} nao tem a coluna razao em tile_pyramids.`);
  console.log(`  A escada foi remontada com RAZAO_PADRAO (${RAZAO_PADRAO}), o valor certo para piramide antiga.`);
  console.log('  Regenere a piramide para gravar a razao, ou uma reconstrucao futura vai produzir outra grade.');
}

const degeneradas = resultados.filter((r) => r.larguraEntregue >= r.larguraNativa);
if (degeneradas.length) {
  // Quando a demanda satura no nativo, B entrega o mesmo full de hoje: a
  // variante barata deixa de ser barata, e so C ainda economiza (pelo recorte
  // do frustum, nao pela resolucao).
  console.log(`\nNOTA: em ${degeneradas.length} de ${resultados.length} viewports a demanda satura no nivel nativo.`);
  console.log(`  Nesses (${degeneradas.map((r) => r.viewport).join(', ')}) a variante B e o proprio full de hoje.`);
  console.log('  E o sintoma do vao da escada: veja a tabela de custo por razao acima.');
}

if (jsonPath) {
  const saida = {
    geradoEm: new Date().toISOString(),
    projeto: { slug: projeto.slug, nome: projeto.name },
    bancos: { imagens: imagensPath, tiles: tilesPath },
    geometria: 'public/calibration/js/pyramid-math.js',
    parametros: {
      fov, pitch, dpr, yaws, margens, margemProducao,
      razaoGravada, razaoUsada, simulando, razaoGravadaExiste,
      amostra: selecionadas.length, passo,
      viewports: viewports.map((v) => v.rotulo),
      estrategiasDeFundo: ESTRATEGIAS.map((e) => e.id),
    },
    aviso: 'Bytes de corpo lidos do SQLite, ou gerados com sharp quando o nivel simulado nao existe no banco. Sem cabecalho HTTP, sem HTTP/2, sem TLS, sem tempo de parede. A parede sai do tile-demo.html no navegador.',
    amostraFotos: selecionadas.map((f) => ({ id: f.id, displayName: f.display_name })),
    viewports: resultados,
    orcamentoEscada,
    armazenamento,
    tilesFaltando,
    tilesGerados,
  };
  writeFileSync(resolve(jsonPath), JSON.stringify(saida, null, 2));
  console.log(`\nJSON gravado em ${resolve(jsonPath)}`);
}

indexDb.close();
imagensDb.close();
tilesDb.close();
