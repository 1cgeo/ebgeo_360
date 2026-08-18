#!/usr/bin/env node

/**
 * @module scripts/migrar-escada
 * @description Leva as piramides JA GRAVADAS para a escada nova, sem regerar
 * nenhum tile que ja existe.
 *
 * POR QUE ESTE SCRIPT EXISTE. Em 2026-08-18 a condicao de parada de
 * `montarEscada` deixou de ser a largura fixa de 2048 e passou a ser o tamanho
 * do tile: a escada agora desce ate o nivel caber em UM tile. A piramide passa
 * a bastar sozinha, com o quadro grosso e o nativo, e o `full_webp` e o
 * `preview_webp` deixam de ser necessarios. O acervo no disco, porem, parou em
 * 2048: sao 99.035 fotos e 11.690.996 tiles bons, que custaram 7,6 horas de
 * geracao. Regerar tudo por causa de dois ou tres niveis novos e trocar horas de
 * CPU por trabalho ja feito.
 *
 * O QUE ELE FAZ, foto a foto:
 *
 *   1. Reproduz a escada ANTIGA (parada em LARGURA_MINIMA_NIVEL) e a NOVA.
 *   2. `delta` e quantos niveis a escada nova acrescentou POR BAIXO.
 *   3. Renumera o que ja existe, `level = level + delta`, de cima para baixo.
 *   4. Gera os niveis 0 a delta-1 A PARTIR DOS PROPRIOS TILES do antigo nivel 0.
 *   5. Reescreve max_level, tile_count e total_bytes com o valor MEDIDO.
 *
 * O PASSO 4 E DE PROPOSITO. A fonte dos niveis novos NAO e o `full_webp`, e sim
 * o antigo nivel 0 composto de volta a partir dos tiles gravados. E a prova de
 * que a piramide se sustenta sem a fonte, que e exatamente o que o chefe quer
 * apagar depois. Se a piramide precisasse do `full_webp` para crescer, ela nao
 * bastaria sozinha, e este script mentiria sobre isso em silencio.
 *
 * O CUIDADO CENTRAL E A NUMERACAO. Acrescentar nivel por baixo EMPURRA todos os
 * outros: o que hoje e `level 0` vira 2 ou 3. O contrato nao muda, e continua
 * dizendo que `level 0` e o mais grosso e que `max_level` e o nativo. Quem muda
 * e o dado.
 *
 * O `total_bytes` MUDA, e isso esta certo. Ele e o token de geracao da URL do
 * tile (`?v=` em routes/phototiles.js), e a escada mudou de verdade: o cliente
 * com cache de um ano PRECISA rebuscar o descritor. O `built_at` tambem se move,
 * pela mesma razao: a assinatura do ETag do descritor conta com ele para
 * enxergar troca de escada.
 *
 * Uso:
 *   node scripts/migrar-escada.js --dry-run
 *   node scripts/migrar-escada.js --so blumenau
 *   node scripts/migrar-escada.js
 *
 * Opcoes:
 *   --dry-run       imprime o plano e nao escreve nada
 *   --so <slug>     um projeto so (aceita lista separada por virgula)
 *   --data <dir>    raiz dos dados (padrao ./data)
 *   --workers <n>   fotos em paralelo no trabalho de imagem
 *   --limite <n>    para o projeto depois de N fotos migradas (piloto)
 */

import Database from 'better-sqlite3';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { availableParallelism } from 'node:os';
import { pathToFileURL } from 'node:url';
import { Worker, isMainThread, parentPort } from 'node:worker_threads';

import {
  montarEscada,
  LARGURA_MINIMA_NIVEL,
} from '../public/calibration/js/pyramid-math.js';

// ============================================================
// Constantes
// ============================================================

/**
 * Fotos em paralelo no trabalho de imagem.
 *
 * O trabalho por foto e pequeno: 8 tiles de fonte, uma composicao de 1,8 MP e
 * nove tiles novos. Medido em 163 ms numa foto de 7680, contra os segundos que
 * a geracao do zero custa. Quatro workers ja saturam a banda de memoria, e o
 * gargalo passa a ser a escrita no SQLite, que e de um escritor so.
 * @constant {number}
 */
const WORKERS_PADRAO = Math.max(1, Math.min(4, availableParallelism() - 1));

/**
 * Fotos entre um checkpoint do WAL e o proximo.
 *
 * A renumeracao reescreve a LINHA inteira de cada tile, blob junto, porque
 * `level` faz parte do registro. Sem checkpoint o WAL cresceria ate o tamanho do
 * projeto, e o faxinal sozinho tem 21 GB. O numero e alto o bastante para o
 * checkpoint nao dominar o tempo, e baixo o bastante para o WAL caber.
 * @constant {number}
 */
const FOTOS_POR_CHECKPOINT = 100;

/**
 * Fotos amostradas por escada para orcar os bytes no `--dry-run`.
 *
 * O plano precisa de MB estimados, e medir o nivel 0 de 99.035 fotos so para
 * imprimir um plano leria o acervo inteiro. A amostra sai da mesma escada, entao
 * as fotos tem a mesma geometria. O tamanho da amostra vai IMPRESSO junto do
 * numero, porque generalizar sem dizer de quantas fotos e afirmar mais do que se
 * mediu.
 * @constant {number}
 */
const AMOSTRA_POR_ESCADA = 20;

// ============================================================
// A escada antiga, e o plano de uma foto
// ============================================================

/**
 * Reproduz a escada que uma piramide gravada ANTES de 2026-08-18 tem.
 *
 * ELA NAO REESCREVE A RECURSAO. `montarEscada` para quando a largura nao passa
 * do `tileSize` que recebeu, e nao usa esse parametro para mais nada alem do
 * `ceil` de `cols` e `rows`. Entao chama-la com `LARGURA_MINIMA_NIVEL` no lugar
 * do tile devolve EXATAMENTE as larguras e alturas da escada velha, com o mesmo
 * arredondamento. Copiar o laco para ca criaria a segunda verdade que o proprio
 * pyramid-math.js existe para matar.
 *
 * O preco desse reuso e uma dependencia escondida: se a parada de `montarEscada`
 * deixar de ser `w > tileSize`, esta funcao muda de significado sem erro nenhum.
 * O teste `tests/unit/migrar-escada.test.js` prende as tres escadas antigas do
 * acervo justamente para isso reprovar.
 *
 * `cols` e `rows` sao REFEITOS com o tile de verdade, porque o tile continua
 * sendo 512 e so a parada mudou.
 *
 * @param {number} width - Largura nativa em pixels.
 * @param {number} height - Altura nativa em pixels.
 * @param {number} tileSize - Lado do tile em pixels.
 * @param {number} razao - Fator entre um nivel e o proximo.
 * @returns {Array<{level:number,width:number,height:number,cols:number,rows:number}>}
 */
export function escadaAntiga(width, height, tileSize, razao) {
  return montarEscada(width, height, LARGURA_MINIMA_NIVEL, razao).map(nivel => ({
    level: nivel.level,
    width: nivel.width,
    height: nivel.height,
    cols: Math.ceil(nivel.width / tileSize),
    rows: Math.ceil(nivel.height / tileSize),
  }));
}

/**
 * A ordem em que os niveis sobem, e a prova de que ela nao colide.
 *
 * A chave primaria e (photo_id, level, x, y), entao um `UPDATE tiles SET level =
 * level + delta` num lance so bate em UNIQUE assim que o nivel 0 tentar ocupar
 * um nivel que ainda existe. A saida e subir DE CIMA PARA BAIXO, um nivel por
 * comando.
 *
 * A PROVA. Os niveis presentes no inicio sao 0..M. Ao processar o nivel `l`, ja
 * subiram os niveis M..l+1, que hoje ocupam M+delta..l+1+delta, e ainda estao no
 * lugar os niveis 0..l. O destino de `l` e `l+delta`. Ele nao esta em 0..l,
 * porque isso pediria delta <= 0. E nao esta em l+1+delta..M+delta, porque isso
 * pediria l >= l+1. Logo o destino esta sempre vazio.
 *
 * Cada linha e reescrita UMA vez. O truque alternativo, mandar tudo para o
 * negativo e voltar, tambem nao colide, mas reescreve o blob de cada tile duas
 * vezes. Com 115,8 GB no acervo isso e o dobro do trabalho de disco.
 *
 * @param {number} maxLevelAntigo - O `max_level` gravado hoje.
 * @param {number} delta - Quantos niveis a escada nova acrescentou por baixo.
 * @returns {number[]} Os niveis a mover, do mais fino ao mais grosso.
 */
export function ordemDaRenumeracao(maxLevelAntigo, delta) {
  if (!Number.isInteger(delta) || delta <= 0) return [];
  const ordem = [];
  for (let l = maxLevelAntigo; l >= 0; l--) ordem.push(l);
  return ordem;
}

/**
 * Decide o que fazer com UMA foto, so pelo que a linha de `tile_pyramids` diz.
 *
 * Sao tres estados, e o terceiro nao e detalhe:
 *
 *   `pronta`        o max_level gravado ja e o da escada nova. Pular.
 *   `migrar`        o max_level gravado e o da escada antiga. Empurrar por delta.
 *   `desconhecida`  nenhum dos dois, ou a escada nova nao contem a antiga.
 *
 * A IDEMPOTENCIA MORA AQUI, e ela e a diferenca entre rodar duas vezes e
 * destruir o acervo. Rodar de novo encontra `pronta` e nao empurra nada. E o
 * estado `desconhecida` nao vira migracao por otimismo: uma piramide que nao
 * esta em nenhum dos dois estados conhecidos e um defeito, e empurra-la
 * espalharia o defeito por mais tres niveis.
 *
 * A ULTIMA CHECAGEM E A QUE MAIS IMPORTA. A migracao so e um deslocamento se a
 * escada nova for a antiga com niveis colados na frente. Isso vale para os tres
 * formatos do acervo, porque a parada mudou e a recursao nao. Se um dia deixar
 * de valer, o `slice` nao bate e a foto cai em `desconhecida` em vez de virar
 * uma grade que ninguem consegue servir.
 *
 * @param {{width:number,height:number,tile_size:number,razao:number,max_level:number}} p
 * @returns {{estado:string, delta:number, motivo:string|null,
 *   antiga:Array<object>, nova:Array<object>, niveisNovos:Array<object>,
 *   tilesNovos:number, pixelsNovos:number}}
 */
export function planoDaFoto(p) {
  const antiga = escadaAntiga(p.width, p.height, p.tile_size, p.razao);
  const nova = montarEscada(p.width, p.height, p.tile_size, p.razao);
  const delta = nova.length - antiga.length;
  const vazio = { antiga, nova, niveisNovos: [], tilesNovos: 0, pixelsNovos: 0 };

  // A escada nova primeiro, e nao a antiga. Com delta 0 as duas dao o mesmo
  // max_level, e a leitura util e "nao ha o que fazer".
  if (p.max_level === nova.length - 1) {
    return { estado: 'pronta', delta: 0, motivo: null, ...vazio };
  }
  if (p.max_level !== antiga.length - 1) {
    return {
      estado: 'desconhecida',
      delta: 0,
      motivo: `max_level ${p.max_level} nao e nem o da escada antiga (${antiga.length - 1})`
        + ` nem o da nova (${nova.length - 1})`,
      ...vazio,
    };
  }

  const rabo = nova.slice(delta);
  const desloca = delta > 0 && rabo.length === antiga.length && rabo.every((n, i) => (
    n.width === antiga[i].width && n.height === antiga[i].height
    && n.cols === antiga[i].cols && n.rows === antiga[i].rows
  ));
  if (!desloca) {
    return {
      estado: 'desconhecida',
      delta: 0,
      motivo: 'a escada nova nao e a antiga com niveis na frente, entao a migracao'
        + ' nao e um deslocamento e teria de regerar tile',
      ...vazio,
    };
  }

  const niveisNovos = nova.slice(0, delta);
  return {
    estado: 'migrar',
    delta,
    motivo: null,
    antiga,
    nova,
    niveisNovos,
    tilesNovos: niveisNovos.reduce((s, n) => s + n.cols * n.rows, 0),
    pixelsNovos: niveisNovos.reduce((s, n) => s + n.width * n.height, 0),
  };
}

/**
 * A identidade da escada de uma piramide, em uma linha.
 *
 * Mesma chave de `generate-tiles.js`, e de proposito: duas fotos com esta chave
 * tem a mesma escada e a mesma grade, entao o plano pode agrupar por ela e o
 * operador le a mesma etiqueta nos dois scripts.
 * @param {{width:number,height:number,tile_size:number,razao:number}} p
 * @returns {string}
 */
export const chaveDaEscada = (p) => `${p.width}x${p.height} tile ${p.tile_size} razao ${p.razao}`;

// ============================================================
// Linha de comando
// ============================================================

/**
 * Le a linha de comando, e ABORTA no valor invalido em vez de engoli-lo.
 *
 * Mesmo gesto do gerar-acervo.js: `--workers abc` virando 1 em silencio muda o
 * plano sem o operador saber. Aqui o estrago seria pior, porque a rodada
 * reescreve dado bom.
 *
 * @param {string[]} argv - Argumentos, ja sem o node e sem o script.
 * @returns {{dryRun:boolean, so:Set<string>|null, dataDir:string, workers:number, limite:number|null}}
 * @throws {Error} Se um valor faltar ou nao for valido.
 */
export function interpretarArgumentos(argv) {
  const opt = {
    dryRun: argv.includes('--dry-run'),
    so: null,
    dataDir: './data',
    workers: WORKERS_PADRAO,
    limite: null,
  };
  const valorDe = (i, nome) => {
    const v = argv[i];
    if (v === undefined || v.startsWith('--')) {
      throw new Error(`${nome} exige um valor, e nao veio nenhum depois dele.`);
    }
    return v;
  };
  const inteiro = (bruto, nome) => {
    const n = Number(bruto);
    if (!Number.isInteger(n) || n < 1) {
      throw new Error(`${nome} pede um inteiro maior ou igual a 1. Recebi "${bruto}".`);
    }
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--so') opt.so = new Set(valorDe(++i, '--so').split(','));
    if (argv[i] === '--data') opt.dataDir = valorDe(++i, '--data');
    if (argv[i] === '--workers') opt.workers = inteiro(valorDe(++i, '--workers'), '--workers');
    if (argv[i] === '--limite') opt.limite = inteiro(valorDe(++i, '--limite'), '--limite');
  }
  return opt;
}

/**
 * Os projetos que tem banco de tiles no disco, em ordem alfabetica.
 *
 * A lista sai do DIRETORIO, e nao do `index.db`. Quem este script migra e o
 * arquivo de tiles, e um projeto sem `{slug}_tiles.db` nao tem o que migrar. Ler
 * o index para descobrir isso acrescentaria uma dependencia que nao decide nada.
 *
 * @param {string} projectsDir - Caminho de data/projects.
 * @returns {Array<{slug:string, path:string}>}
 */
export function projetosComTiles(projectsDir) {
  return readdirSync(projectsDir)
    .filter(nome => nome.endsWith('_tiles.db'))
    .sort()
    .map(nome => ({ slug: nome.slice(0, -'_tiles.db'.length), path: join(projectsDir, nome) }));
}

// ============================================================
// Worker: compoe o nivel de fonte e corta os niveis novos
// ============================================================

/**
 * Loop do worker. Uma foto por mensagem, e NENHUM banco aberto aqui.
 *
 * A leitura fica na thread principal de proposito. Os tiles de fonte sao 8
 * blobs de uns 15 KB, entao a clonagem do postMessage e barata, e o worker nao
 * precisa de uma conexao com o arquivo que a principal esta reescrevendo naquele
 * instante. Isso tira do desenho a pergunta de qual das duas pontas ve a
 * renumeracao primeiro.
 * @returns {Promise<void>}
 */
async function rodarWorker() {
  const sharp = (await import('sharp')).default;
  // O cache do libvips nao ajuda: cada foto e um trabalho novo, nada se repete.
  sharp.cache(false);
  // A unidade de paralelismo e a FOTO. Uma pool do libvips dentro de cada worker
  // multiplicaria as threads pelo numero de workers, so disputando os mesmos
  // nucleos.
  sharp.concurrency(1);

  parentPort.on('message', async (msg) => {
    if (msg.tipo === 'fim') {
      parentPort.close();
      return;
    }
    try {
      // O tile vem NA MENSAGEM, e nao no workerData. Ele e um campo por
      // piramide (`tile_pyramids.tile_size`), e nao um parametro da rodada:
      // ler o tile da primeira foto e aplica-lo nas demais cortaria a grade
      // errada no dia em que um projeto tiver duas.
      const tiles = await gerarNiveisNovos(sharp, msg.tileSize, msg);
      parentPort.postMessage({ tipo: 'pronto', photoId: msg.photoId, tiles });
    } catch (err) {
      parentPort.postMessage({ tipo: 'erro', photoId: msg.photoId, mensagem: descreverErro(err) });
    }
  });
}

/**
 * Compoe o nivel de fonte a partir dos proprios tiles e corta os niveis novos.
 *
 * A COMPOSICAO E CONFERIDA ANTES DE VALER. Cada tile de fonte tem o tamanho
 * previsto pela grade daquele nivel, com a borda RECORTADA, e a contagem tem de
 * fechar com cols x rows. Um tile faltando produziria uma faixa preta que
 * nenhuma checagem posterior enxerga: os niveis novos sairiam com o numero certo
 * de tiles, o total_bytes fecharia, e a parede mostraria um borrao. Por isso a
 * falta reprova a FOTO aqui, antes de qualquer escrita.
 *
 * Cada nivel novo sai do MESMO raw de fonte, e nao em cadeia um do outro: a
 * cadeia empilharia tres reamostragens no nivel mais grosso, que e justamente o
 * primeiro quadro que o usuario ve.
 *
 * `fit: 'fill'` porque as duas dimensoes ja vem calculadas pela escada. Qualquer
 * preservacao de proporcao aqui poderia devolver um pixel a menos e desalinhar a
 * ultima linha de tiles do que o descritor promete.
 *
 * @param {object} sharp - O modulo sharp ja carregado.
 * @param {number} tileSize - Lado do tile em pixels.
 * @param {{photoId:string, fonte:{width:number,height:number,cols:number,rows:number},
 *   tilesFonte:Array<{x:number,y:number,webp:Uint8Array}>, quality:number,
 *   niveisNovos:Array<object>}} msg
 * @returns {Promise<Array<{level:number,x:number,y:number,webp:Buffer}>>}
 */
async function gerarNiveisNovos(sharp, tileSize, msg) {
  const { fonte, tilesFonte, quality, niveisNovos } = msg;

  const previstos = fonte.cols * fonte.rows;
  if (tilesFonte.length !== previstos) {
    throw new Error(
      `nivel de fonte incompleto: ${tilesFonte.length} tiles gravados contra ${previstos}`
      + ` que a grade ${fonte.cols}x${fonte.rows} preve`,
    );
  }

  // O tamanho de CADA tile da fonte, conferido no cabecalho do WebP. Um tile com
  // dimensao errada entraria no composite deslocado, e a imagem sairia torta sem
  // erro nenhum.
  const pecas = [];
  for (const t of tilesFonte) {
    const largura = Math.min(tileSize, fonte.width - t.x * tileSize);
    const altura = Math.min(tileSize, fonte.height - t.y * tileSize);
    const buf = Buffer.from(t.webp.buffer, t.webp.byteOffset, t.webp.byteLength);
    const meta = await sharp(buf).metadata();
    if (meta.width !== largura || meta.height !== altura) {
      throw new Error(
        `tile de fonte ${t.x},${t.y} mede ${meta.width}x${meta.height} e a grade preve`
        + ` ${largura}x${altura}`,
      );
    }
    pecas.push({ input: buf, left: t.x * tileSize, top: t.y * tileSize });
  }

  const base = await sharp({
    create: {
      width: fonte.width, height: fonte.height, channels: 3,
      background: { r: 0, g: 0, b: 0 },
    },
  }).composite(pecas).raw().toBuffer({ resolveWithObject: true });

  const entradaBase = {
    raw: { width: fonte.width, height: fonte.height, channels: base.info.channels },
  };

  const tiles = [];
  for (const nivel of niveisNovos) {
    const reduzido = await sharp(base.data, entradaBase)
      .resize(nivel.width, nivel.height, { fit: 'fill', kernel: 'lanczos3' })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const entrada = {
      raw: { width: nivel.width, height: nivel.height, channels: reduzido.info.channels },
    };
    // y por fora e x por dentro: o recorte de uma linha percorre bytes vizinhos.
    for (let y = 0; y < nivel.rows; y++) {
      const altura = Math.min(tileSize, nivel.height - y * tileSize);
      for (let x = 0; x < nivel.cols; x++) {
        const largura = Math.min(tileSize, nivel.width - x * tileSize);
        const webp = await sharp(reduzido.data, entrada)
          .extract({ left: x * tileSize, top: y * tileSize, width: largura, height: altura })
          .webp({ quality })
          .toBuffer();
        tiles.push({ level: nivel.level, x, y, webp });
      }
    }
  }
  return tiles;
}

// ============================================================
// Utilidades de saida
// ============================================================

/** @param {number} bytes @returns {string} */
const mb = (bytes) => (bytes / 1048576).toFixed(2);

/** @param {number} ms @returns {string} */
function duracao(ms) {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h${String(m % 60).padStart(2, '0')}m`;
  return m > 0 ? `${m}m${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}

/**
 * Descreve um erro que pode NAO ser um Error de verdade.
 *
 * O erro que atravessa a fronteira do worker passa por clonagem estruturada, e
 * ela nao preserva subclasse de Error. "Falhou: undefined" nao aponta nada
 * justamente no momento em que o operador mais precisa da mensagem.
 * @param {unknown} err - O que quer que tenha sido lancado.
 * @returns {string}
 */
function descreverErro(err) {
  if (err instanceof Error && err.message) return err.message;
  if (err && typeof err === 'object') {
    const partes = [err.name, err.code, err.message].filter(Boolean);
    if (partes.length) return partes.join(' ');
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return String(err);
}

/**
 * Envelopa o Uint8Array que veio do worker como Buffer, sem copiar.
 * `postMessage` clona o Buffer e o entrega como Uint8Array puro, e o
 * better-sqlite3 so aceita Buffer para BLOB.
 * @param {Uint8Array} u8 - O tile como veio do worker.
 * @returns {Buffer}
 */
const comoBlob = (u8) => Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength);

// ============================================================
// Plano de um projeto
// ============================================================

/**
 * Le as piramides de um projeto e monta o plano, agrupado por escada.
 *
 * O plano sai da MESMA funcao no `--dry-run` e na rodada de verdade. Dois
 * caminhos de decisao virariam duas contas, e o dry-run que imprime um plano
 * diferente do que a rodada executa e pior que nao ter dry-run.
 *
 * @param {object} dest - Conexao com o banco de tiles.
 * @param {boolean} amostrar - Se mede bytes por pixel para orcar os MB.
 * @returns {{piramides:Array<object>, planos:Map<string,object>, grupos:Array<object>,
 *   migrar:number, prontas:number, desconhecidas:Array<object>,
 *   tilesNovos:number, bytesEstimados:number}}
 */
function planejarProjeto(dest, amostrar) {
  const piramides = dest.prepare(`
    SELECT photo_id, tile_size, max_level, width, height, quality, tile_count,
           total_bytes, razao
    FROM tile_pyramids ORDER BY photo_id
  `).all();

  const planos = new Map();
  const grupos = new Map();
  const desconhecidas = [];
  let migrar = 0;
  let prontas = 0;
  let tilesNovos = 0;

  for (const p of piramides) {
    const plano = planoDaFoto(p);
    planos.set(p.photo_id, plano);
    if (plano.estado === 'pronta') { prontas++; continue; }
    if (plano.estado === 'desconhecida') {
      desconhecidas.push({ photoId: p.photo_id, chave: chaveDaEscada(p), motivo: plano.motivo });
      continue;
    }
    migrar++;
    tilesNovos += plano.tilesNovos;

    const chave = chaveDaEscada(p);
    let grupo = grupos.get(chave);
    if (!grupo) {
      grupo = {
        chave,
        delta: plano.delta,
        larguraNovas: plano.niveisNovos.map(n => n.width),
        larguraTodas: plano.nova.map(n => n.width),
        tilesPorFoto: plano.tilesNovos,
        pixelsPorFoto: plano.pixelsNovos,
        fotos: 0,
        amostras: [],
        bytesPorPixel: null,
      };
      grupos.set(chave, grupo);
    }
    grupo.fotos++;
    if (grupo.amostras.length < AMOSTRA_POR_ESCADA) grupo.amostras.push(p);
  }

  // Bytes por pixel MEDIDOS no nivel 0 de hoje, que e o vizinho mais proximo dos
  // niveis novos. Ele subestima um pouco: tile menor comprime pior por pixel.
  // O numero e um ORCAMENTO do dry-run, e a rodada de verdade mede tudo de novo.
  let bytesEstimados = 0;
  if (amostrar) {
    const somaNivel0 = dest.prepare(
      'SELECT COALESCE(SUM(LENGTH(webp)), 0) FROM tiles WHERE photo_id = ? AND level = 0',
    ).pluck();
    for (const grupo of grupos.values()) {
      let bytes = 0;
      let pixels = 0;
      for (const p of grupo.amostras) {
        const nivel0 = planos.get(p.photo_id).antiga[0];
        bytes += somaNivel0.get(p.photo_id);
        pixels += nivel0.width * nivel0.height;
      }
      grupo.bytesPorPixel = pixels ? bytes / pixels : 0;
      grupo.bytesEstimados = Math.round(grupo.bytesPorPixel * grupo.pixelsPorFoto * grupo.fotos);
      bytesEstimados += grupo.bytesEstimados;
    }
  }

  return {
    piramides,
    planos,
    grupos: [...grupos.values()].sort((a, b) => b.fotos - a.fotos),
    migrar,
    prontas,
    desconhecidas,
    tilesNovos,
    bytesEstimados,
  };
}

// ============================================================
// Conferencia que reprova
// ============================================================

/**
 * Confere o projeto INTEIRO depois da migracao, foto a foto.
 *
 * SAO DUAS PERGUNTAS DIFERENTES, e a primeira e a que reprova escada trocada:
 *
 *   GRADE. Para cada foto e cada nivel de `montarEscada(width, height,
 *   tile_size, razao)`, os tiles gravados tem de ser exatamente a grade cheia.
 *   A prova sai de tres numeros por nivel: a contagem igual a cols x rows, o
 *   minimo em 0 e o maximo em cols-1 e rows-1. Com a chave primaria garantindo
 *   que nao ha par repetido, cols x rows pares distintos dentro de uma caixa de
 *   cols x rows celulas SO PODEM ser a caixa inteira. Nivel a mais ou a menos
 *   tambem cai aqui, porque o conjunto de niveis e comparado.
 *
 *   CONTABILIDADE. `tile_count` e `total_bytes` contra a contagem e a soma
 *   MEDIDAS na tabela de tiles. O `total_bytes` e o token do `?v=`, entao um
 *   valor velho ali manda o cliente pedir a escada nova com a URL antiga.
 *
 * A grade e a unica das duas que enxerga a escada trocada: a contabilidade
 * compara dois numeros que o mesmo laco escreveu, e passaria de pe.
 *
 * @param {object} dest - Conexao com o banco de tiles.
 * @returns {{fotos:number, ok:boolean, reprovadas:Array<{photoId:string,erros:string[]}>,
 *   orfas:string[]}}
 */
export function conferirProjeto(dest) {
  const piramides = dest.prepare(`
    SELECT photo_id, tile_size, max_level, width, height, tile_count, total_bytes, razao
    FROM tile_pyramids ORDER BY photo_id
  `).all();

  // Uma varredura so pela tabela de tiles, agrupada. Ela e um scan do indice da
  // chave primaria, sem tocar nos blobs.
  const grade = new Map();
  for (const r of dest.prepare(`
    SELECT photo_id, level, COUNT(*) AS n, MIN(x) AS minx, MAX(x) AS maxx,
           MIN(y) AS miny, MAX(y) AS maxy
    FROM tiles GROUP BY photo_id, level
  `).iterate()) {
    let porFoto = grade.get(r.photo_id);
    if (!porFoto) { porFoto = new Map(); grade.set(r.photo_id, porFoto); }
    porFoto.set(r.level, r);
  }

  // A segunda varredura le os BLOBs, porque a soma de bytes e o token do `?v=` e
  // nao pode sair de um acumulador em memoria, que e eco do proprio codigo que
  // escreveu.
  const medido = new Map(dest.prepare(
    'SELECT photo_id, COUNT(*) AS n, COALESCE(SUM(LENGTH(webp)), 0) AS b FROM tiles GROUP BY photo_id',
  ).all().map(r => [r.photo_id, r]));

  const reprovadas = [];
  for (const p of piramides) {
    const erros = [];
    const escada = montarEscada(p.width, p.height, p.tile_size, p.razao);
    const porFoto = grade.get(p.photo_id) ?? new Map();

    if (p.max_level !== escada.length - 1) {
      erros.push(`max_level ${p.max_level} contra ${escada.length - 1} da escada`);
    }
    const niveisSobrando = [...porFoto.keys()].filter(l => l < 0 || l >= escada.length);
    if (niveisSobrando.length) {
      erros.push(`niveis fora da escada: ${niveisSobrando.sort((a, b) => a - b).join(', ')}`);
    }
    for (const nivel of escada) {
      const g = porFoto.get(nivel.level);
      const previstos = nivel.cols * nivel.rows;
      if (!g) { erros.push(`nivel ${nivel.level} sem tile nenhum`); continue; }
      if (g.n !== previstos || g.minx !== 0 || g.miny !== 0
        || g.maxx !== nivel.cols - 1 || g.maxy !== nivel.rows - 1) {
        erros.push(
          `nivel ${nivel.level}: ${g.n} tiles em x[${g.minx}..${g.maxx}] y[${g.miny}..${g.maxy}],`
          + ` a escada preve ${previstos} em x[0..${nivel.cols - 1}] y[0..${nivel.rows - 1}]`,
        );
      }
    }

    const m = medido.get(p.photo_id) ?? { n: 0, b: 0 };
    if (p.tile_count !== m.n) erros.push(`tile_count ${p.tile_count} contra ${m.n} medidos`);
    if (p.total_bytes !== m.b) erros.push(`total_bytes ${p.total_bytes} contra ${m.b} medidos`);

    if (erros.length) reprovadas.push({ photoId: p.photo_id, erros });
  }

  // Tile de foto sem linha em tile_pyramids nao e servido por rota nenhuma e
  // ocupa disco. Ele nao reprova a migracao, mas precisa aparecer.
  const comPiramide = new Set(piramides.map(p => p.photo_id));
  const orfas = [...grade.keys()].filter(id => !comPiramide.has(id));

  return { fotos: piramides.length, ok: reprovadas.length === 0, reprovadas, orfas };
}

// ============================================================
// Migracao de um projeto
// ============================================================

/**
 * Migra um projeto inteiro, ou so imprime o plano dele.
 *
 * @param {{slug:string, path:string}} projeto - Projeto e caminho do banco de tiles.
 * @param {{dryRun:boolean, workers:number, limite:number|null}} opt - Opcoes da rodada.
 * @returns {Promise<{ok:boolean, migradas:number, falhas:Array<object>, tilesNovos:number,
 *   bytesNovos:number, plano:object}>}
 */
async function migrarProjeto(projeto, opt) {
  const dest = new Database(projeto.path, { readonly: opt.dryRun });
  if (!opt.dryRun) {
    dest.pragma('journal_mode = WAL');
    dest.pragma('synchronous = NORMAL');
    dest.pragma('busy_timeout = 10000');
  }

  const inicio = Date.now();
  const falhas = [];
  let migradas = 0;
  let tilesEscritos = 0;
  let bytesEscritos = 0;

  try {
    const plano = planejarProjeto(dest, opt.dryRun);

    console.log(`\n=== ${projeto.slug} ===`);
    console.log(`  Arquivo:      ${projeto.path} (${mb(statSync(projeto.path).size)} MB)`);
    console.log(`  Piramides:    ${plano.piramides.length} (${plano.migrar} a migrar,`
      + ` ${plano.prontas} ja na escada nova, ${plano.desconhecidas.length} em estado desconhecido)`);

    for (const g of plano.grupos) {
      console.log(`    ${String(g.fotos).padStart(5)} foto(s)  ${g.chave}`);
      console.log(`            +${g.delta} nivel(is) por baixo: ${g.larguraNovas.join('/')} px`
        + `  ->  escada nova ${g.larguraTodas.join('/')}`);
      console.log(`            ${g.tilesPorFoto} tiles novos por foto,`
        + ` ${g.tilesPorFoto * g.fotos} no total`
        + (opt.dryRun
          ? `, ~${mb(g.bytesEstimados)} MB estimados`
            + ` (${(g.bytesPorPixel * 1000).toFixed(2)} B/kpx medidos em ${g.amostras.length} foto(s))`
          : ''));
    }
    if (plano.desconhecidas.length) {
      console.log(`\n  ATENCAO: ${plano.desconhecidas.length} piramide(s) em estado desconhecido,`
        + ' que esta rodada NAO toca:');
      for (const d of plano.desconhecidas.slice(0, 5)) {
        console.log(`    ${d.photoId} (${d.chave}): ${d.motivo}`);
      }
      if (plano.desconhecidas.length > 5) {
        console.log(`    ... e mais ${plano.desconhecidas.length - 5}`);
      }
    }

    if (opt.dryRun) {
      console.log(`\n  Total do projeto: ${plano.tilesNovos} tiles novos,`
        + ` ~${mb(plano.bytesEstimados)} MB. Nada foi escrito.`);
      return {
        ok: plano.desconhecidas.length === 0, migradas: 0, falhas: [],
        tilesNovos: plano.tilesNovos, bytesNovos: plano.bytesEstimados, plano,
      };
    }

    // --- Escrita ------------------------------------------------------------

    const fila = plano.piramides
      .filter(p => plano.planos.get(p.photo_id).estado === 'migrar')
      .slice(0, opt.limite ?? Infinity);

    const lerFonte = dest.prepare(
      'SELECT x, y, webp FROM tiles WHERE photo_id = ? AND level = 0 ORDER BY y, x',
    );
    const subirNivel = dest.prepare(
      'UPDATE tiles SET level = level + ? WHERE photo_id = ? AND level = ?',
    );
    const inserirTile = dest.prepare(
      'INSERT INTO tiles (photo_id, level, x, y, webp) VALUES (?, ?, ?, ?, ?)',
    );
    const medirFoto = dest.prepare(
      'SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(webp)), 0) AS b FROM tiles WHERE photo_id = ?',
    );
    const atualizarPiramide = dest.prepare(
      'UPDATE tile_pyramids SET max_level = ?, tile_count = ?, total_bytes = ?, built_at = ?'
      + ' WHERE photo_id = ?',
    );

    /**
     * Migra UMA foto inteira numa transacao so.
     *
     * A transacao e a foto, e nao o nivel nem o tile. Uma queda no meio nao pode
     * deixar foto com escada meio velha e meio nova: essa foto nao daria erro em
     * lugar nenhum, e a rota serviria uma grade que nao existe. Como a linha de
     * `tile_pyramids` entra na MESMA transacao, o `max_level` gravado e o
     * marcador de conclusao, e e ele que a proxima rodada le para pular a foto.
     *
     * O `total_bytes` sai de uma MEDIDA na tabela, e nao da soma dos tiles que
     * este laco acabou de inserir. Somar o que se escreveu e eco do proprio
     * codigo; a medida le o que o SQLite realmente guardou.
     */
    const migrarFoto = dest.transaction((r) => {
      for (const nivel of ordemDaRenumeracao(r.maxLevelAntigo, r.delta)) {
        subirNivel.run(r.delta, r.photoId, nivel);
      }
      for (const t of r.tiles) {
        inserirTile.run(r.photoId, t.level, t.x, t.y, comoBlob(t.webp));
      }
      const m = medirFoto.get(r.photoId);
      atualizarPiramide.run(
        r.maxLevelNovo, m.n, m.b, new Date().toISOString(), r.photoId,
      );
      return m;
    });

    let ultimoDesenho = 0;
    const desenhar = (forcado = false) => {
      const agora = Date.now();
      if (!forcado && agora - ultimoDesenho < 200) return;
      ultimoDesenho = agora;
      const eta = migradas
        ? duracao(((agora - inicio) / migradas) * (fila.length - migradas))
        : '--';
      process.stderr.write(
        `\r  ${migradas}/${fila.length} fotos | ${tilesEscritos} tiles novos`
        + ` | ${mb(bytesEscritos)} MB | ETA ${eta}   `,
      );
    };

    if (fila.length) {
      await new Promise((concluir, falhar) => {
        const pendentes = fila.slice();
        const pool = [];
        let vivos = 0;
        let abortado = false;

        /**
         * Le a fonte da proxima foto e a manda ao worker. Foto cuja leitura
         * falha vira falha registrada e o laco segue para a seguinte, em vez de
         * recursao: uma sequencia longa de falhas estouraria a pilha.
         * @param {Worker} w - O worker ocioso.
         */
        const despachar = (w) => {
          // A checagem de aborto e na ENTRADA, e nao a cada volta: o corpo do
          // laco e sincrono, entao o handler de erro do worker nao roda no meio
          // dele e `abortado` nao muda ali dentro.
          if (abortado) return;
          for (;;) {
            const p = pendentes.shift();
            if (!p) { w.postMessage({ tipo: 'fim' }); return; }
            const plan = plano.planos.get(p.photo_id);
            try {
              const tilesFonte = lerFonte.all(p.photo_id);
              w.postMessage({
                tipo: 'foto',
                photoId: p.photo_id,
                tileSize: p.tile_size,
                quality: p.quality,
                // A fonte e o antigo nivel 0, que a escada antiga descreve. Ele
                // vira o nivel `delta` depois da renumeracao.
                fonte: plan.antiga[0],
                niveisNovos: plan.niveisNovos,
                tilesFonte,
              });
              return;
            } catch (err) {
              falhas.push({ photoId: p.photo_id, etapa: 'leitura', mensagem: descreverErro(err) });
              desenhar();
            }
          }
        };

        for (let i = 0; i < Math.min(opt.workers, fila.length); i++) {
          const w = new Worker(new URL(import.meta.url));
          vivos++;
          pool.push(w);

          w.on('message', (msg) => {
            if (msg.tipo === 'erro') {
              falhas.push({ photoId: msg.photoId, etapa: 'imagem', mensagem: msg.mensagem });
            } else {
              // A escrita fica na thread principal: um escritor so no SQLite
              // dispensa retry de SQLITE_BUSY.
              const plan = plano.planos.get(msg.photoId);
              try {
                const m = migrarFoto({
                  photoId: msg.photoId,
                  delta: plan.delta,
                  maxLevelAntigo: plan.antiga.length - 1,
                  maxLevelNovo: plan.nova.length - 1,
                  tiles: msg.tiles,
                });
                migradas++;
                tilesEscritos += msg.tiles.length;
                bytesEscritos += msg.tiles.reduce((s, t) => s + t.webp.byteLength, 0);
                if (m.n !== plan.nova.reduce((s, n) => s + n.cols * n.rows, 0)) {
                  falhas.push({
                    photoId: msg.photoId, etapa: 'escrita',
                    mensagem: `depois de migrar sobraram ${m.n} tiles, e a escada nova preve`
                      + ` ${plan.nova.reduce((s, n) => s + n.cols * n.rows, 0)}`,
                  });
                }
                // O WAL guarda a reescrita de cada linha de tile, blob junto.
                // Sem este checkpoint ele cresceria ate o tamanho do projeto.
                if (migradas % FOTOS_POR_CHECKPOINT === 0) {
                  dest.pragma('wal_checkpoint(TRUNCATE)');
                }
              } catch (err) {
                // Falha de escrita nao mata a rodada. A transacao da foto e
                // atomica, entao o banco nao fica com meia escada, e as fotos
                // seguintes ainda tem o que migrar.
                falhas.push({ photoId: msg.photoId, etapa: 'escrita', mensagem: descreverErro(err) });
              }
            }
            desenhar();
            if (!abortado) despachar(w);
          });

          w.on('error', (err) => {
            if (abortado) return;
            abortado = true;
            process.stderr.write('\n');
            for (const outro of pool) outro.terminate();
            falhar(err);
          });

          w.on('exit', () => {
            vivos--;
            if (vivos === 0) { desenhar(true); process.stderr.write('\n'); concluir(); }
          });

          despachar(w);
        }
      });
    } else {
      console.log('  Nada a migrar neste projeto.');
    }

    dest.pragma('wal_checkpoint(TRUNCATE)');

    // --- Conferencia --------------------------------------------------------

    const conferencia = conferirProjeto(dest);
    console.log(`  Migradas:     ${migradas} foto(s) em ${duracao(Date.now() - inicio)}`
      + `${migradas ? ` (${((Date.now() - inicio) / migradas / 1000).toFixed(2)} s/foto)` : ''}`);
    console.log(`  Tiles novos:  ${tilesEscritos} (${mb(bytesEscritos)} MB)`);
    console.log(`  Arquivo:      ${mb(statSync(projeto.path).size)} MB`);

    if (conferencia.ok) {
      console.log(`  CONFERENCIA OK: as ${conferencia.fotos} piramides batem com montarEscada,`
        + ' e tile_count e total_bytes batem com o medido.');
    } else {
      console.log(`  CONFERENCIA REPROVOU em ${conferencia.reprovadas.length} de`
        + ` ${conferencia.fotos} piramide(s):`);
      for (const r of conferencia.reprovadas.slice(0, 10)) {
        console.log(`    ${r.photoId}: ${r.erros.join('; ')}`);
      }
      if (conferencia.reprovadas.length > 10) {
        console.log(`    ... e mais ${conferencia.reprovadas.length - 10}`);
      }
    }
    if (conferencia.orfas.length) {
      console.log(`  ATENCAO: ${conferencia.orfas.length} foto(s) com tile e sem linha em`
        + ' tile_pyramids. Elas nao sao servidas por rota nenhuma.');
    }
    if (falhas.length) {
      console.log(`  ${falhas.length} foto(s) falharam:`);
      for (const f of falhas.slice(0, 10)) {
        console.log(`    [${f.etapa}] ${f.photoId}: ${f.mensagem}`);
      }
      if (falhas.length > 10) console.log(`    ... e mais ${falhas.length - 10}`);
    }

    return {
      ok: conferencia.ok && falhas.length === 0 && plano.desconhecidas.length === 0,
      migradas, falhas, tilesNovos: tilesEscritos, bytesNovos: bytesEscritos, plano,
    };
  } finally {
    dest.close();
  }
}

// ============================================================
// Thread principal
// ============================================================

/**
 * Roda o plano ou a migracao sobre os projetos pedidos.
 * @returns {Promise<void>}
 */
async function principal() {
  let opt;
  try {
    opt = interpretarArgumentos(process.argv.slice(2));
  } catch (err) {
    console.error(descreverErro(err));
    process.exit(1);
  }

  const projectsDir = resolve(opt.dataDir, 'projects');
  if (!existsSync(projectsDir)) {
    console.error(`Nao achei ${projectsDir}. Use --data para apontar a raiz dos dados.`);
    process.exit(1);
  }

  let projetos = projetosComTiles(projectsDir);
  if (opt.so) {
    const conhecidos = new Set(projetos.map(p => p.slug));
    const faltando = [...opt.so].filter(s => !conhecidos.has(s));
    if (faltando.length) {
      console.error(`Sem banco de tiles para: ${faltando.join(', ')}.`);
      console.error(`Projetos com tiles em ${projectsDir}: ${[...conhecidos].join(', ')}`);
      process.exit(1);
    }
    projetos = projetos.filter(p => opt.so.has(p.slug));
  }

  console.log(opt.dryRun ? 'PLANO da migracao de escada (--dry-run, nada e escrito)'
    : 'MIGRACAO da escada');
  console.log(`  Escada antiga: parava em ${LARGURA_MINIMA_NIVEL} px de largura.`);
  console.log('  Escada nova:   desce ate o nivel caber em um tile.');
  console.log(`  Projetos:      ${projetos.length}${opt.so ? ' (--so)' : ''}`);
  console.log(`  Workers:       ${opt.workers}${opt.limite ? `, limite ${opt.limite} foto(s)/projeto` : ''}`);

  const inicio = Date.now();
  let migradas = 0;
  let tilesNovos = 0;
  let bytesNovos = 0;
  let reprovados = 0;

  for (const projeto of projetos) {
    const r = await migrarProjeto(projeto, opt);
    migradas += r.migradas;
    tilesNovos += r.tilesNovos;
    bytesNovos += r.bytesNovos;
    if (!r.ok) reprovados++;
  }

  console.log(`\n=== Total (${duracao(Date.now() - inicio)}) ===`);
  if (opt.dryRun) {
    console.log(`  ${tilesNovos} tiles novos, ~${mb(bytesNovos)} MB em ${projetos.length} projeto(s).`);
    console.log('  Nada foi escrito. Tire o --dry-run para migrar.');
  } else {
    console.log(`  ${migradas} foto(s) migradas, ${tilesNovos} tiles novos, ${mb(bytesNovos)} MB.`);
  }
  if (reprovados) {
    console.log(`  ${reprovados} projeto(s) com conferencia reprovada ou falha. Veja acima.`);
  }
  // Quem chama este script de dentro de outro le o codigo de saida, nunca o
  // texto acima.
  process.exitCode = reprovados ? 1 : 0;
}

// ============================================================
// Entrada
// ============================================================

// O worker roda ESTE mesmo arquivo, pela mesma razao do generate-tiles.js: a
// matematica da escada nao pode ficar num arquivo e o consumo dela noutro.
// A rodada so acontece pela linha de comando, entao importar o modulo (o teste
// importa) carrega as funcoes e nao escreve nada.
if (!isMainThread) {
  await rodarWorker();
} else if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await principal();
  } catch (err) {
    console.error(`\nFalhou: ${descreverErro(err)}`);
    process.exit(1);
  }
}
