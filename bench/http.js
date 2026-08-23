#!/usr/bin/env node

/**
 * @module bench/http
 * @description Bancada de carga do servico, pela porta HTTP.
 *
 * O QUE ELA MEDE, depois que o escopo fechou em CODIGO. O acervo de producao ja
 * saiu gerado, e a formula da piramide nao muda. Entao ficam de fora
 * `page_size`, `quality`, `effort`, `tile_size` e a razao. Fica de pe o que uma
 * linha de codigo ainda pode trocar:
 *
 *   1. a rajada de 54 tiles com 24 em voo, que e o gesto do cliente
 *   2. LOG_LEVEL `info` contra `warn`
 *   3. o `@fastify/compress` com `global: true` contra sem plugin
 *   4. o 304, o 200, e o ETag fraco com prefixo `W/` que nunca casa
 *   5. o custo POR FOTO, pago 54 vezes por rajada
 *
 * ESTA BANCADA SOBE SERVIDOR, ao contrario da irma do ebgeo_3d. Ali a regra era
 * nao subir, para nao esconder o ambiente da producao. Aqui o AMBIENTE E A
 * PERGUNTA: `LOG_LEVEL` se le na partida, e o `compress` esta escrito no
 * src/server.js sem chave de ambiente. Ver bench/lib/servico.js.
 *
 * Uso:
 *   node bench/http.js --projeto faxinal
 *   node bench/http.js --projeto faxinal --requisicoes 4000 --json saida.json
 */

import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import {
  ALVOS, PARALELO_CLIENTE, PROJETO_PADRAO, RAJADA_REFERENCIA,
  piramidesDoProjeto, rajada, repete, urlDoTile, urlDoDescritor,
} from './lib/alvos.js';
import { dispara, aquece, repeteRajada, linha, CABECALHO, resumoTempo } from './lib/carga.js';
import { subirReal, subirEmbutido } from './lib/servico.js';
import { getPhotoById, isPhotoDeleted, getProjectByPhotoId } from '../src/db/queries.js';
import { getTilePyramid, tilesDbFilenameFor } from '../src/db/tiles-queries.js';
import { escadaGravada } from '../public/calibration/js/pyramid-math.js';

const argv = process.argv.slice(2);
const v = (n, p) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : p; };
const o = {
  projeto: v('--projeto', PROJETO_PADRAO),
  requisicoes: parseInt(v('--requisicoes', '4000'), 10),
  rodadas: parseInt(v('--rodadas', '5'), 10),
  portaA: parseInt(v('--porta', '8191'), 10),
  json: v('--json'),
};

// A foto sai do banco: o servico nao lista as fotos de um projeto, e o
// `total_bytes` que entra na URL como token de geracao so existe na linha de
// tile_pyramids.
const piramides = piramidesDoProjeto(o.projeto);
if (!piramides.length) {
  console.error(`ERRO: o projeto "${o.projeto}" nao tem piramide gerada.`);
  process.exit(2);
}
const piramide = piramides[0];
const uuid = piramide.photo_id;

console.log(`projeto   ${o.projeto}  ${piramides.length.toLocaleString('pt-BR')} piramides`);
console.log(`foto      ${uuid}  ${piramide.width}x${piramide.height} razao ${piramide.razao}`);

const resultados = {};

/**
 * Dispara, registra e imprime uma rajada.
 * @param {string} rotulo - Nome do cenario
 * @param {Array} alvos - Lista de URLs
 * @param {number} concorrencia - Requisicoes em voo
 * @param {object} [cabecalhos] - Cabecalhos extras
 * @returns {Promise<object>} O resultado
 */
async function registra(rotulo, alvos, concorrencia, cabecalhos) {
  const r = await dispara(alvos, { concorrencia, cabecalhos });
  resultados[rotulo] = { ...r, concorrencia };
  console.log(linha(rotulo, r));
  return r;
}

// ================================================================ o servidor A

console.log(`\nsubindo o servico com LOG_LEVEL=warn na porta ${o.portaA}...`);
const servidorWarn = await subirReal({ porta: o.portaA, logLevel: 'warn' });
const base = `http://127.0.0.1:${o.portaA}`;

const resp = await fetch(urlDoDescritor(base, uuid).caminho);
if (!resp.ok) {
  console.error(`ERRO: tiles.json respondeu ${resp.status}. O servico aponta a mesma raiz?`);
  await servidorWarn.fechar();
  process.exit(3);
}
const descritor = await resp.json();
console.log(`escada    ${descritor.levels.map((n) => n.width).join('/')}  maxLevel ${descritor.maxLevel}`);

const url = (t) => urlDoTile(base, uuid, t, piramide.total_bytes);
const referencia = rajada(piramide, ALVOS[0], RAJADA_REFERENCIA);
const alvosRef = referencia.tiles.map(url);
console.log(`rajada    ${referencia.tiles.length} tiles do nivel ${referencia.nivel}, ${PARALELO_CLIENTE} em voo`);

console.log('\naquecendo...');
await aquece(alvosRef, 300);

// ---------------------------------------------------------------- 1. a rajada

console.log(`\n=== 1. a rajada do frustum, uma vez, com ${PARALELO_CLIENTE} em voo ===`);
console.log(`${'alvo'.padEnd(14)} ${'nivel'.padStart(5)} ${'tiles'.padStart(6)} ${'KiB'.padStart(8)} ${'melhor ms'.padStart(10)} ${'p50'.padStart(7)} ${'p99'.padStart(7)} ${'dispersao'.padStart(10)}`);
const rajadas = {};
for (const alvo of ALVOS) {
  const r = rajada(piramide, alvo, RAJADA_REFERENCIA);
  const m = await repeteRajada(r.tiles.map(url), {
    concorrencia: PARALELO_CLIENTE, rodadas: o.rodadas,
  });
  rajadas[alvo.nome] = m;
  console.log(
    `${alvo.nome.padEnd(14)} ${String(r.nivel).padStart(5)} ${String(r.tiles.length).padStart(6)} `
    + `${(m.bytes / 1024).toFixed(0).padStart(8)} ${(m.segundos * 1000).toFixed(1).padStart(10)} `
    + `${String(m.latencia.p50).padStart(7)} ${String(m.latencia.p99).padStart(7)} `
    + `${`${m.dispersao.toFixed(0)}%`.padStart(10)}`,
  );
}

console.log('\n--- a mesma rajada, variando o que esta em voo ---');
console.log(CABECALHO);
for (const c of [1, 8, PARALELO_CLIENTE, 64, 128]) {
  await registra(`c=${c}`, repete(alvosRef, o.requisicoes), c);
}
console.log('O semaforo da rota e 64 (phototiles.js). Acima dele o p50 conta a fila, e nao');
console.log('o servico.');

// ---------------------------------------------------------------- 2. o 304

console.log('\n=== 2. o 304, o 200, e o ETag fraco ===');
console.log(CABECALHO);
const umTile = url(referencia.tiles[0]);
const cabeca = await fetch(umTile.caminho);
const etag = cabeca.headers.get('etag');
const etagNu = etag.replace(/"/g, '');
await registra('200 (sem validador)', repete([umTile], o.requisicoes), PARALELO_CLIENTE);
await registra('304 (etag forte)', repete([umTile], o.requisicoes), PARALELO_CLIENTE, { 'if-none-match': etag });
// O ETAG FRACO E O DEFEITO. phototiles.js:337 faz `replace(/"/g, '')` e compara
// com o etag nu. Num validador fraco isso deixa o `W/` grudado, entao
// `W/abc123` nunca casa com `abc123` e o servico devolve o corpo inteiro. Quem
// manda `W/` e qualquer proxy que transforme a resposta, e o nginx faz isso ao
// ligar gzip.
await registra('304? (etag W/ fraco)', repete([umTile], o.requisicoes), PARALELO_CLIENTE, { 'if-none-match': `W/"${etagNu}"` });
const forte = resultados['304 (etag forte)'];
const fraco = resultados['304? (etag W/ fraco)'];
console.log(`etag forte devolve ${Object.keys(forte.codigos).join(',')}, etag W/ devolve ${Object.keys(fraco.codigos).join(',')}`);
console.log(`o W/ custa ${(fraco.bytes / 1024 / 1024).toFixed(1)} MiB contra ${(forte.bytes / 1024).toFixed(0)} KiB do forte, nas mesmas ${o.requisicoes} requisicoes`);

// ---------------------------------------------------------------- 3. LOG_LEVEL

console.log('\n=== 3. LOG_LEVEL info contra warn ===');
const portaInfo = o.portaA + 1;
console.log(`subindo um segundo servico com LOG_LEVEL=info na porta ${portaInfo}...`);
const servidorInfo = await subirReal({ porta: portaInfo, logLevel: 'info' });
const baseInfo = `http://127.0.0.1:${portaInfo}`;
const alvosInfo = referencia.tiles.map((t) => urlDoTile(baseInfo, uuid, t, piramide.total_bytes));
await aquece(alvosInfo, 300);

console.log(CABECALHO);
const comWarn = await repeteRajada(repete(alvosRef, o.requisicoes), { concorrencia: PARALELO_CLIENTE, rodadas: 3 });
resultados['LOG_LEVEL=warn'] = comWarn;
console.log(linha('LOG_LEVEL=warn', comWarn));
const comInfo = await repeteRajada(repete(alvosInfo, o.requisicoes), { concorrencia: PARALELO_CLIENTE, rodadas: 3 });
resultados['LOG_LEVEL=info'] = comInfo;
console.log(linha('LOG_LEVEL=info', comInfo));
const custoLog = ((comWarn.rps / comInfo.rps) - 1) * 100;
console.log(`info custa ${custoLog.toFixed(1)}% da vazao contra warn, e a producao roda info (docker-compose.yml:15).`);
console.log(`O medir-web.js:863 sobe com warn, entao a medida dele descreve um servidor que ninguem opera.`);
console.log(`bytes de log do servico info nesta rodada: ${(servidorInfo.saida().length / 1024).toFixed(0)} KiB`);
await servidorInfo.fechar();

// ---------------------------------------------------------------- 4. compress

console.log('\n=== 4. @fastify/compress: global true contra sem plugin ===');
console.log('(servidor EMBUTIDO, so com as rotas de tile: o numero vale contra ele mesmo)');
await servidorWarn.fechar();

const portaEmb = o.portaA + 2;
console.log(CABECALHO);
const medidasCompress = {};
for (const [rotulo, ligado] of [['compress global:true', true], ['sem compress', false]]) {
  const srv = await subirEmbutido({ porta: portaEmb, compress: ligado });
  const baseEmb = `http://127.0.0.1:${portaEmb}`;
  const alvosEmb = referencia.tiles.map((t) => urlDoTile(baseEmb, uuid, t, piramide.total_bytes));
  await aquece(alvosEmb, 200);
  // COM `Accept-Encoding: gzip`, que e o que todo navegador manda. Sem esse
  // cabecalho o plugin sai do caminho e a comparacao daria empate por
  // construcao.
  const m = await repeteRajada(repete(alvosEmb, o.requisicoes), {
    concorrencia: PARALELO_CLIENTE, rodadas: 3, cabecalhos: { 'accept-encoding': 'gzip' },
  });
  medidasCompress[rotulo] = m;
  resultados[rotulo] = m;
  console.log(linha(rotulo, m));
  await srv.fechar();
}
const cLigado = medidasCompress['compress global:true'];
const cDeslig = medidasCompress['sem compress'];
console.log(`o plugin custa ${(((cDeslig.rps / cLigado.rps) - 1) * 100).toFixed(1)}% da vazao no tile WebP, que ele nem comprime`);
console.log('(image/webp esta fora do customTypes de src/server.js, entao o hook roda e passa)');

// ---------------------------------------------------------------- 5. por foto

console.log(`\n=== 5. o custo POR FOTO, pago ${RAJADA_REFERENCIA} vezes por rajada ===`);
// NENHUMA das cinco chamadas abaixo depende de level, x ou y. A rota as repete
// a cada tile, e a rajada inteira e sempre da MESMA foto. Medido aqui em
// processo, sem HTTP, porque o que se quer e o custo da funcao e nao da rota.
const dbFilename = tilesDbFilenameFor(`${o.projeto}.db`);
const passos = [
  { nome: 'getPhotoById', fn: () => getPhotoById(uuid) },
  { nome: 'isPhotoDeleted', fn: () => isPhotoDeleted(uuid) },
  { nome: 'getProjectByPhotoId', fn: () => getProjectByPhotoId(uuid) },
  { nome: 'getTilePyramid', fn: () => getTilePyramid(dbFilename, uuid) },
  {
    nome: 'escadaGravada',
    fn: () => escadaGravada(
      piramide.width, piramide.height, piramide.tile_size, piramide.razao, piramide.max_level,
    ),
  },
];
const N = 2000;
for (const p of passos) p.fn();
console.log(`${'chamada'.padEnd(24)} ${'us/chamada'.padStart(11)} ${`x${RAJADA_REFERENCIA} (ms)`.padStart(12)}`);
let somaUs = 0;
for (const p of passos) {
  const tempos = [];
  for (let r = 0; r < 5; r++) {
    const t0 = performance.now();
    for (let i = 0; i < N; i++) p.fn();
    tempos.push(performance.now() - t0);
  }
  const us = (resumoTempo(tempos).melhor * 1000) / N;
  somaUs += us;
  console.log(`${p.nome.padEnd(24)} ${us.toFixed(2).padStart(11)} ${((us * RAJADA_REFERENCIA) / 1000).toFixed(2).padStart(12)}`);
}
console.log(`${'soma'.padEnd(24)} ${somaUs.toFixed(2).padStart(11)} ${((somaUs * RAJADA_REFERENCIA) / 1000).toFixed(2).padStart(12)}`);
const refRajada = rajadas[ALVOS[0].nome];
if (refRajada) {
  const msRajada = refRajada.segundos * 1000;
  console.log(`a rajada inteira leva ${msRajada.toFixed(1)} ms de parede, entao o trabalho por foto`);
  console.log(`repetido ${RAJADA_REFERENCIA} vezes vale ${(((somaUs * RAJADA_REFERENCIA) / 1000 / msRajada) * 100).toFixed(1)}% dela.`);
}
console.log('Nenhuma dessas cinco depende de level, x ou y. Elas se repetem por tile porque a');
console.log('rota as chama de novo a cada requisicao, e nao porque a resposta mudou.');

// ---------------------------------------------------------------- resumo

console.log('\n=== resumo ===');
console.log(`rajada de ${referencia.tiles.length} tiles   ${(rajadas[ALVOS[0].nome].segundos * 1000).toFixed(1)} ms, p99 ${rajadas[ALVOS[0].nome].latencia.p99} ms`);
console.log(`LOG_LEVEL info    ${custoLog.toFixed(1)}% de vazao a menos que warn`);
console.log(`compress no tile  ${(((cDeslig.rps / cLigado.rps) - 1) * 100).toFixed(1)}% de vazao a menos, sem comprimir nada`);
console.log(`ETag W/           ${Object.keys(fraco.codigos).join(',')} em vez de 304`);
console.log(`trabalho por foto ${((somaUs * RAJADA_REFERENCIA) / 1000).toFixed(2)} ms por rajada`);

if (o.json) {
  writeFileSync(o.json, JSON.stringify({
    quando: new Date().toISOString(), projeto: o.projeto, foto: uuid, resultados, rajadas,
  }, null, 2));
  console.log(`\ngravado em ${o.json}`);
}
