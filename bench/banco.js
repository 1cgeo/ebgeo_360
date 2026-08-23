#!/usr/bin/env node

/**
 * @module bench/banco
 * @description Bancada da camada SQLite da piramide, sem HTTP no meio.
 *
 * POR QUE SEPARAR DO bench/http.js. Aquele mede o que o cliente sente, e nele o
 * custo do banco fica misturado com o do Fastify, do keep-alive e do loop de
 * eventos. Este isola a leitura do BLOB. Sem a separacao, uma melhora de 20% no
 * banco some dentro do ruido do HTTP e ninguem sabe se ela existiu.
 *
 * O QUE ESTA BANCADA NAO MEDE, e de proposito. `page_size`, `quality`,
 * `effort`, `tile_size` e a razao da escada estao FORA. O acervo de producao ja
 * foi gerado inteiro com esses valores, e a formula nao muda. Medir o que nao
 * pode mudar produz relatorio, nao decisao. O que sobra e CODIGO, e e o que
 * esta aqui: os pragmas de abertura, o `statSync` por acesso e o tamanho da
 * rajada.
 *
 * O ARQUIVO PRECISA SER MAIOR QUE O mmap_size, senao a pergunta sobre mmap nao
 * existe. Num banco de 20,9 MiB as variantes empataram por construcao, dentro de
 * uma dispersao de 90%. O `faxinal` passa de 1,4 GB contra os 256 MB do servico,
 * e e por isso que ele e o projeto padrao.
 *
 * TRES CUIDADOS, herdados da bancada irma do ebgeo_3d:
 *
 * 1. RODADAS INTERCALADAS. Medir uma configuracao inteira e depois a outra mede
 *    o cache de pagina do sistema esquentando.
 * 2. COLETOR DE LIXO CONTROLADO. Cada leitura aloca um Buffer de dezenas de KB.
 *    Sem `--expose-gc` a coleta cai no meio de uma rodada qualquer.
 * 3. A MELHOR RODADA, e nao a media. A media soma o ruido de todo mundo.
 *
 * Uso:
 *   node --expose-gc bench/banco.js --projeto faxinal
 *   node --expose-gc bench/banco.js --projeto faxinal --chaves 4000 --rodadas 9
 */

import { statSync } from 'node:fs';
import { basename } from 'node:path';
import { totalmem } from 'node:os';
import Database from 'better-sqlite3';
import {
  ALVOS, PROJETO_PADRAO, RAJADA_REFERENCIA, MARGEM_CLIENTE,
  caminhoDosTiles, frustum, rajada, sorteio,
} from './lib/alvos.js';
import {
  argumentos, mediana, mib, repeteMedida, resumoTempo, comparaContra,
} from './lib/carga.js';

const a = argumentos(process.argv.slice(2));
const o = {
  projeto: a.valor('--projeto', PROJETO_PADRAO),
  chaves: parseInt(a.valor('--chaves', '4000'), 10),
  rodadas: parseInt(a.valor('--rodadas', '9'), 10),
};

const caminho = caminhoDosTiles(o.projeto);
if (!statSync(caminho, { throwIfNoEntry: false })) {
  console.error(`ERRO: o projeto "${o.projeto}" nao tem piramide gerada.`);
  console.error('A raiz dos dados sai da chave STREETVIEW_DATA_DIR.');
  process.exit(2);
}

/**
 * O `mmap_size` do servico, em src/db/connection.js:getProjectDb.
 * @constant {number}
 */
const MMAP_DO_SERVICO = 268435456;

/**
 * O `cache_size` do servico, em pagina negativa (KiB).
 * @constant {number}
 */
const CACHE_DO_SERVICO = -32000;

/** SQL do seek de um tile, identico ao de src/db/tiles-queries.js. @constant {string} */
const SQL_TILE = 'SELECT webp FROM tiles WHERE photo_id = ? AND level = ? AND x = ? AND y = ?';

// ---------------------------------------------------------------- o dado

const bytesArquivo = statSync(caminho).size;
const sonda = new Database(caminho, { readonly: true });
const piramides = sonda.prepare(`
  SELECT photo_id, tile_size, max_level, width, height, quality, tile_count, total_bytes, razao
  FROM tile_pyramids ORDER BY photo_id
`).all();
if (!piramides.length) {
  console.error('ERRO: o arquivo existe mas tile_pyramids esta vazia.');
  process.exit(3);
}
const chavesTodas = sonda.prepare('SELECT photo_id, level, x, y FROM tiles').all();
sonda.close();

const piramide = piramides[0];

console.log(`arquivo    ${basename(caminho)}  ${mib(bytesArquivo).toFixed(0)} MiB`);
console.log(`conteudo   ${piramides.length.toLocaleString('pt-BR')} piramides, ${chavesTodas.length.toLocaleString('pt-BR')} tiles`);
console.log(`escada     ${piramide.width}x${piramide.height}, tile ${piramide.tile_size}, razao ${piramide.razao}, max_level ${piramide.max_level}`);
console.log(`carga      ${o.chaves.toLocaleString('pt-BR')} leituras x ${o.rodadas} rodadas intercaladas`);

const cabeNoMmap = bytesArquivo < MMAP_DO_SERVICO;
console.log(`mmap       ${mib(MMAP_DO_SERVICO).toFixed(0)} MiB do servico contra ${mib(bytesArquivo).toFixed(0)} MiB de arquivo`
  + (cabeNoMmap ? '   <-- O ARQUIVO CABE NO MMAP' : ''));
if (cabeNoMmap) {
  console.log('ATENCAO: com o arquivo menor que o mmap, a secao 4 empata por construcao.');
  console.log('         Rode contra um projeto grande para a pergunta existir.');
}
if (bytesArquivo < totalmem() * 0.25) {
  console.log('ATENCAO: o arquivo cabe folgado na memoria do sistema, entao "frio" abaixo');
  console.log('         mede a conexao, e nunca o disco.');
}

const coleta = typeof globalThis.gc === 'function';
if (!coleta) {
  console.log('\nAVISO: sem --expose-gc a coleta cai no meio de uma rodada qualquer.');
  console.log('       rode: node --expose-gc bench/banco.js ...');
}

/**
 * Abre o banco de tiles com pragmas explicitos.
 * @param {{cache:number, mmap:number}} c - A configuracao
 * @returns {object} A conexao better-sqlite3
 */
function abre(c) {
  const db = new Database(caminho, { readonly: true });
  db.pragma('query_only = true');
  db.pragma(`cache_size = ${c.cache}`);
  db.pragma('busy_timeout = 5000');
  db.pragma(`mmap_size = ${c.mmap}`);
  return db;
}

/**
 * Amostra DISJUNTA por rodada, para a leitura fria nao reler o que ja leu.
 *
 * A leitura fria so vale enquanto as paginas nao estao no cache do sistema.
 * Reler a mesma amostra na rodada seguinte mede o cache, e foi assim que a
 * versao anterior desta bancada achou 0,45 ms de "frio" contra 0,35 ms de
 * "quente": a diferenca era so a abertura da conexao.
 *
 * @param {Array} lista - Todas as chaves, ja embaralhadas
 * @param {number} k - Tamanho da amostra
 * @param {number} fatia - Indice da rodada
 * @returns {Array} As chaves daquela fatia
 */
function fatiaDisjunta(lista, k, fatia) {
  const passo = Math.max(1, lista.length - k);
  return lista.slice((fatia * k) % passo, ((fatia * k) % passo) + k);
}

// Embaralhado UMA vez, com semente fixa: as fatias saem espalhadas pelo arquivo
// inteiro, e nao em blocos vizinhos da btree.
const chavesEmbaralhadas = sorteio(chavesTodas);

// ---------------------------------------------------------------- 1. frio x quente

console.log('\n=== 1. seek de um tile pela chave primaria: frio contra quente ===');

const friosMs = [];
const quentesMs = [];
for (let r = 0; r < o.rodadas; r++) {
  const fatia = fatiaDisjunta(chavesEmbaralhadas, o.chaves, r);

  // FRIO: conexao nova, e chaves que este processo nunca leu.
  const db = abre({ cache: CACHE_DO_SERVICO, mmap: MMAP_DO_SERVICO });
  const st = db.prepare(SQL_TILE);
  if (coleta) globalThis.gc();
  let t0 = process.hrtime.bigint();
  for (const k of fatia) st.get(k.photo_id, k.level, k.x, k.y);
  friosMs.push(Number(process.hrtime.bigint() - t0) / 1e6);

  // QUENTE: a MESMA conexao, relendo as MESMAS chaves.
  if (coleta) globalThis.gc();
  t0 = process.hrtime.bigint();
  for (const k of fatia) st.get(k.photo_id, k.level, k.x, k.y);
  quentesMs.push(Number(process.hrtime.bigint() - t0) / 1e6);
  db.close();
}
const serieFria = resumoTempo(friosMs);
const serieQuente = resumoTempo(quentesMs);
const usFrio = (serieFria.melhor * 1000) / o.chaves;
const usQuente = (serieQuente.melhor * 1000) / o.chaves;
console.log(`${'estado'.padEnd(10)} ${'melhor ms'.padStart(10)} ${'mediana'.padStart(9)} ${'us/seek'.padStart(9)} ${'tiles/s'.padStart(11)} ${'dispersao'.padStart(10)}`);
console.log(`${'frio'.padEnd(10)} ${serieFria.melhor.toFixed(1).padStart(10)} ${serieFria.mediana.toFixed(1).padStart(9)} ${usFrio.toFixed(1).padStart(9)} ${Math.round(1e6 / usFrio).toLocaleString('pt-BR').padStart(11)} ${`${serieFria.dispersao.toFixed(0)}%`.padStart(10)}`);
console.log(`${'quente'.padEnd(10)} ${serieQuente.melhor.toFixed(1).padStart(10)} ${serieQuente.mediana.toFixed(1).padStart(9)} ${usQuente.toFixed(1).padStart(9)} ${Math.round(1e6 / usQuente).toLocaleString('pt-BR').padStart(11)} ${`${serieQuente.dispersao.toFixed(0)}%`.padStart(10)}`);
console.log(`frio custa ${(usFrio / usQuente).toFixed(2)}x o quente`);
console.log('Cada rodada fria le uma FATIA DIFERENTE do arquivo, para nao reler o que ja');
console.log('caiu no cache. O cache do sistema nao se esvazia daqui, entao este numero e o');
console.log('piso do custo frio, nunca o teto.');

// ---------------------------------------------------------------- 2. a rajada

console.log(`\n=== 2. a rajada do frustum inteiro (${RAJADA_REFERENCIA} tiles na referencia) ===`);
console.log(`${'alvo'.padEnd(14)} ${'viewport'.padStart(10)} ${'nivel'.padStart(5)} ${'previsto'.padStart(8)} ${'medidos'.padStart(8)} ${'KiB'.padStart(8)} ${'quente ms'.padStart(10)} ${'frio ms'.padStart(8)} ${'us/tile'.padStart(8)}`);

const dbRajada = abre({ cache: CACHE_DO_SERVICO, mmap: MMAP_DO_SERVICO });
const stRajada = dbRajada.prepare(SQL_TILE);
const medidasAlvo = [];
for (const alvo of ALVOS) {
  const r = rajada(piramide, alvo, RAJADA_REFERENCIA);
  const { serie, bytes } = repeteMedida(() => {
    let n = 0;
    for (const t of r.tiles) {
      const linhaTile = stRajada.get(piramide.photo_id, t.level, t.x, t.y);
      if (linhaTile) n += linhaTile.webp.length;
    }
    return n;
  }, { rodadas: o.rodadas });

  // A MESMA rajada, com conexao nova e OUTRA foto a cada repeticao. Repetir a
  // mesma foto acharia tudo no cache de pagina, e o "frio" viraria quente
  // disfarcado.
  const frios = [];
  for (let i = 0; i < Math.min(o.rodadas, 5); i++) {
    const outra = piramides[(i + 1) % piramides.length];
    const db = abre({ cache: CACHE_DO_SERVICO, mmap: MMAP_DO_SERVICO });
    const st = db.prepare(SQL_TILE);
    if (coleta) globalThis.gc();
    const t0 = process.hrtime.bigint();
    for (const t of r.tiles) st.get(outra.photo_id, t.level, t.x, t.y);
    frios.push(Number(process.hrtime.bigint() - t0) / 1e6);
    db.close();
  }
  const serieFriaRajada = resumoTempo(frios);
  medidasAlvo.push({ alvo, r, serie, bytes, serieFriaRajada });
  console.log(
    `${alvo.nome.padEnd(14)} ${`${alvo.largura}x${alvo.altura}`.padStart(10)} ${String(r.nivel).padStart(5)} `
    + `${String(r.previsto).padStart(8)} ${String(r.tiles.length).padStart(8)} `
    + `${(bytes / 1024).toFixed(0).padStart(8)} `
    + `${serie.melhor.toFixed(2).padStart(10)} `
    + `${serieFriaRajada.melhor.toFixed(2).padStart(8)} `
    + `${(serie.melhor * 1000 / r.tiles.length).toFixed(1).padStart(8)}`,
  );
}
console.log(`"previsto" e tilesVisiveis com margem ${MARGEM_CLIENTE}. "medidos" e o recorte de ${RAJADA_REFERENCIA} tiles,`);
console.log('que e o numero que o visualizador pediu de verdade, contado pelo Network do CDP.');

// ---------------------------------------------------------------- 3. margem

console.log('\n=== 3. margem 1 contra margem 0 (tile-loader.js:80) ===');
console.log(`${'alvo'.padEnd(14)} ${'m=1 tiles'.padStart(10)} ${'m=0 tiles'.padStart(10)} ${'m=1 KiB'.padStart(9)} ${'m=0 KiB'.padStart(9)} ${'a mais'.padStart(9)}`);

/**
 * Soma os bytes de uma lista de tiles.
 * @param {Array<{level:number,x:number,y:number}>} tiles - As coordenadas
 * @returns {number} Bytes somados
 */
function bytesDe(tiles) {
  let n = 0;
  for (const t of tiles) {
    const linhaTile = stRajada.get(piramide.photo_id, t.level, t.x, t.y);
    if (linhaTile) n += linhaTile.webp.length;
  }
  return n;
}

for (const alvo of ALVOS) {
  const com = frustum(piramide, alvo, 1);
  const sem = frustum(piramide, alvo, 0);
  const bCom = bytesDe(com.tiles);
  const bSem = bytesDe(sem.tiles);
  console.log(
    `${alvo.nome.padEnd(14)} ${String(com.tiles.length).padStart(10)} ${String(sem.tiles.length).padStart(10)} `
    + `${(bCom / 1024).toFixed(0).padStart(9)} ${(bSem / 1024).toFixed(0).padStart(9)} `
    + `${`${((bCom / Math.max(bSem, 1) - 1) * 100).toFixed(0)}%`.padStart(9)}`,
  );
}
console.log('A margem paga a folga que impede buraco na emenda ao arrastar, e esta tabela e o');
console.log('CUSTO dela. O beneficio e visual e nao esta medido: trocar MARGEM_TILES exige');
console.log('editar public/calibration/js/tile-loader.js, fora do alcance desta bancada.');

// ---------------------------------------------------------------- 4. pragmas

console.log('\n=== 4. cache_size e mmap_size ===');

const CONFIGS = [
  { nome: 'servico (32MB/256MB)', cache: CACHE_DO_SERVICO, mmap: MMAP_DO_SERVICO },
  { nome: 'cache 2 MB', cache: -2000, mmap: MMAP_DO_SERVICO },
  { nome: 'sem mmap', cache: CACHE_DO_SERVICO, mmap: 0 },
  { nome: 'mmap = o arquivo', cache: CACHE_DO_SERVICO, mmap: bytesArquivo },
  { nome: 'cache 2 MB, sem mmap', cache: -2000, mmap: 0 },
];

const abertos = CONFIGS.map((c) => {
  const db = abre(c);
  return { ...c, db, stmt: db.prepare(SQL_TILE), tempos: [] };
});

// Aquecimento de TODOS antes de medir qualquer um, senao a primeira da lista
// paga o disco por todas as outras.
const alvoPragma = fatiaDisjunta(chavesEmbaralhadas, o.chaves, o.rodadas + 3);
for (const c of abertos) {
  for (let i = 0; i < 500; i++) {
    const k = alvoPragma[i % alvoPragma.length];
    c.stmt.get(k.photo_id, k.level, k.x, k.y);
  }
}

for (let r = 0; r < o.rodadas; r++) {
  const ordem = r % 2 === 0 ? abertos : [...abertos].reverse();
  for (const c of ordem) {
    if (coleta) globalThis.gc();
    const t0 = process.hrtime.bigint();
    for (const k of alvoPragma) c.stmt.get(k.photo_id, k.level, k.x, k.y);
    c.tempos.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
}

console.log(`${'configuracao'.padEnd(22)} ${'melhor ms'.padStart(10)} ${'mediana'.padStart(9)} ${'us/seek'.padStart(9)} ${'dispersao'.padStart(10)}`);
const series = abertos.map((c) => {
  const serie = resumoTempo(c.tempos);
  console.log(
    `${c.nome.padEnd(22)} ${serie.melhor.toFixed(1).padStart(10)} ${serie.mediana.toFixed(1).padStart(9)} `
    + `${(serie.melhor * 1000 / o.chaves).toFixed(1).padStart(9)} ${`${serie.dispersao.toFixed(0)}%`.padStart(10)}`,
  );
  c.db.close();
  return { nome: c.nome, serie };
});
const algumDecide = comparaContra(
  'contra o pragma do servico, pela MELHOR rodada de cada:',
  series[0], series.slice(1), true,
);
if (!algumDecide) {
  console.log('\nNenhuma variante saiu do ruido: os pragmas de hoje estao bons.');
}

// ---------------------------------------------------------------- 5. statSync

console.log('\n=== 5. o statSync de tiles-queries.js:109, cobrado DUAS vezes por tile ===');
// A ROTA CHAMA tileStmts DUAS VEZES por tile servido: uma dentro de
// getTilePyramid e outra dentro de getTileBlob (phototiles.js). Cada chamada faz
// o seu proprio statSync, entao o numero que decide e o do PAR.
const { serie: serieStat } = repeteMedida(() => {
  for (let i = 0; i < o.chaves; i++) statSync(caminho, { throwIfNoEntry: false });
  return 0;
}, { rodadas: o.rodadas });
const usStat = (serieStat.melhor * 1000) / o.chaves;
console.log(`${'statSync, uma chamada'.padEnd(30)} ${usStat.toFixed(2).padStart(9)} us`);
console.log(`${'por tile servido (duas)'.padEnd(30)} ${(usStat * 2).toFixed(2).padStart(9)} us`);
console.log(`${'seek de tile, quente'.padEnd(30)} ${usQuente.toFixed(2).padStart(9)} us`);
console.log(`${'seek de tile, frio'.padEnd(30)} ${usFrio.toFixed(2).padStart(9)} us`);
console.log(`${'peso do par sobre o seek quente'.padEnd(30)} ${((usStat * 2 / usQuente) * 100).toFixed(0).padStart(9)} %`);
console.log(`${`o par x ${RAJADA_REFERENCIA} tiles`.padEnd(30)} ${((usStat * 2 * RAJADA_REFERENCIA) / 1000).toFixed(2).padStart(9)} ms por rajada`);
if (medidasAlvo[0]) {
  console.log(`${'a rajada de leitura custou'.padEnd(30)} ${medidasAlvo[0].serie.melhor.toFixed(2).padStart(9)} ms`);
}
console.log('A conferencia de mtime e tamanho pega a TROCA do arquivo pelo gerador com o');
console.log('servico no ar. Ela e cobrada em dobro porque getTilePyramid e getTileBlob');
console.log('chamam tileStmts cada um por sua conta.');

dbRajada.close();
console.log(`\nmediana das rodadas frias: ${mediana(friosMs).toFixed(1)} ms`);
