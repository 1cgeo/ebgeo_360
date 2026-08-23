#!/usr/bin/env node

/**
 * @module bench/cliente
 * @description Bancada do CLIENTE: o que o navegador sente ao abrir a foto.
 *
 * POR QUE ELA EXISTE, DEPOIS DAS OUTRAS DUAS. bench/banco.js diz que o SQLite
 * entrega um tile em microssegundos, e bench/http.js diz que a rota entrega
 * milhares por segundo. Nenhum dos dois sabe se a TELA fica pronta: entre a
 * rota e o pixel ha o descritor, a escolha do nivel, a decodificacao do WebP e
 * o upload da textura, e e ali que o usuario espera.
 *
 * AS TRES PERGUNTAS DE CODIGO que ela responde:
 *
 *   1. passar `renderer` ao carregador, contra nao passar. Hoje o
 *      `preview-viewer.js:741` passa so o `gl`, e sem o renderer a subida
 *      parcial nao existe: cada lote reenvia o canvas INTEIRO em vez do
 *      retangulo do tile.
 *   2. a serializacao do `tile-loader.js:1210`. O `await` do nivel 0 poe
 *      descritor, fundo e nivel alvo em TRES voltas de rede em serie.
 *   3. quanto custa a abertura, por viewport, em primeiro quadro e em completo.
 *
 * A margem 1 contra 0 (`tile-loader.js:80`) NAO esta aqui: trocar a constante
 * exige editar public/, fora do alcance da bancada. O CUSTO dela esta medido em
 * bench/banco.js secao 3, em tiles e em bytes.
 *
 * ELA NAO SOBE SERVIDOR. O proprio servico ja serve a pagina, por
 * `/calibration/`. Suba com `npm start` antes.
 *
 * DUAS PAGINAS, DOIS PAPEIS:
 *   `/calibration/tile-demo.html?auto=0` expoe `window.__rodar`, que fixa
 *   viewport e camera e mede por dentro do carregador.
 *   `/calibration/?photo=<uuid>` e o visualizador de verdade, e e nele que a
 *   serializacao da abertura se mede, pelo Network do CDP.
 *
 * Uso:
 *   node bench/cliente.js --projeto faxinal
 *   node bench/cliente.js --projeto faxinal --repeticoes 5 --gpu software
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as esperar } from 'node:timers/promises';
import { subirChrome } from '../scripts/lib/cdp.js';
import { SONDA_WEB } from '../scripts/lib/sonda-web.js';
import { ALVOS, PROJETO_PADRAO, RAJADA_REFERENCIA, rajada, piramidesDoProjeto } from './lib/alvos.js';
import { argumentos, resumoTempo } from './lib/carga.js';

const a = argumentos(process.argv.slice(2));
const o = {
  base: a.valor('--base', 'http://127.0.0.1:8081'),
  projeto: a.valor('--projeto', PROJETO_PADRAO),
  repeticoes: parseInt(a.valor('--repeticoes', '3'), 10),
  gpu: a.valor('--gpu', 'hardware'),
  json: a.valor('--json'),
  semCaptura: a.tem('--sem-captura'),
};

/**
 * O canvas da panoramica, achado pela AREA e nunca pela ordem no DOM.
 *
 * ISTO CUSTOU UMA MEDIDA INTEIRA. `querySelector('#viewer-container canvas')`
 * devolve o primeiro do DOM, e o primeiro e o MINIMAPA do MapLibre, de 339x277.
 * O arrasto da bancada caiu nele: o mapa girou, a panoramica nao, e o giro
 * fechou com ZERO tile enquanto o contador marcava 57 quadros por segundo.
 * Numero plausivel e resposta errada.
 * @constant {string}
 */
const CANVAS_360 = "Array.from(document.querySelectorAll('#viewer-container canvas'))"
  + '.sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0]';

/** Condicao de pronto do visualizador de calibracao. @constant {string} */
const PRONTO_360 = `(() => {
  const c = ${CANVAS_360};
  const o = document.getElementById('loading-overlay');
  return !!c && c.clientWidth > 400 && (!o || o.style.display === 'none');
})()`;

const DIR_CAPTURAS = join(import.meta.dirname, 'capturas');

// ---------------------------------------------------------------- o alvo

const piramides = piramidesDoProjeto(o.projeto);
if (!piramides.length) {
  console.error(`ERRO: o projeto "${o.projeto}" nao tem piramide gerada.`);
  process.exit(2);
}
const piramide = piramides[0];
const uuid = piramide.photo_id;

const saude = await fetch(`${o.base}/health`).then((r) => r.json()).catch(() => null);
if (!saude || saude.status !== 'ok') {
  console.error('ERRO: o servico nao responde em /health. Suba com `npm start`.');
  process.exit(3);
}

console.log(`alvo      ${o.base}/calibration/`);
console.log(`foto      ${uuid}  ${piramide.width}x${piramide.height} razao ${piramide.razao}`);
console.log(`carga     ${o.repeticoes} repeticoes, GPU ${o.gpu}`);

/**
 * Roda `window.__rodar` na pagina dirigida e devolve a medida.
 * @param {object} cdp - Cliente CDP conectado
 * @param {object} opcoes - Opcoes de window.__rodar
 * @returns {Promise<object>} A medida
 */
async function rodarNaPagina(cdp, opcoes) {
  const texto = await cdp.avaliar(
    `window.__rodar(${JSON.stringify(opcoes)}).then(r => JSON.stringify(r))`, 180000,
  );
  return JSON.parse(texto);
}

/**
 * O script que faz o A/B do `renderer`, injetado na pagina dirigida.
 *
 * ELE CRIA DOIS CARREGADORES NOVOS, e nao mexe no da pagina. `createTileLoader`
 * aceita `renderer` como opcao, entao o A/B cabe inteiro do lado de fora: nao
 * ha uma linha de public/ para editar. Os dois rodam a MESMA foto, com a MESMA
 * camera e cache `no-store`, e o que se le e `bytesParaGpu`, que o proprio
 * carregador ja conta.
 * @constant {string}
 */
const SCRIPT_RENDERER = `
window.__benchRenderer = async function (uuid, comRenderer, alvo) {
  const [mod, THREE] = await Promise.all([
    import('./js/tile-loader.js'),
    import('three'),
  ]);
  const cv = document.createElement('canvas');
  cv.width = alvo.largura;
  cv.height = alvo.altura;
  const rend = new THREE.WebGLRenderer({ canvas: cv, antialias: false });
  const opcoes = { gl: rend.getContext() };
  if (comRenderer) opcoes.renderer = rend;
  const L = mod.createTileLoader(opcoes);
  L.ignorarCache('no-store');
  L.atualizarCamera({
    lon: alvo.lon, lat: alvo.lat, fov: alvo.fov,
    largura: alvo.largura, altura: alvo.altura,
  });
  const t0 = performance.now();

  // O LACO DE QUADRO COMECA ANTES DA CARGA, e isso NAO e detalhe. A primeira
  // versao desta bancada so chamava aplicarAtualizacoes depois do await de
  // carregarFoto, e aquele await so volta quando o fundo inteiro fechou: os
  // tiles chegavam sem nenhum quadro rodando, empilhavam num retangulo unico e
  // o caminho com renderer pagava 3 subidas parciais quase do tamanho do
  // canvas. O A/B media o laco da bancada, e nao o do visualizador: deu o SINAL
  // TROCADO. O viewer roda rAF desde o inicio, e aqui tambem.
  let rodando = true;
  const laco = (async () => {
    while (rodando) {
      L.aplicarAtualizacoes();
      await new Promise(r => requestAnimationFrame(r));
    }
  })();

  await L.carregarFoto(uuid);
  const limite = performance.now() + 60000;
  let quieto = 0;
  while (performance.now() < limite && quieto < 8) {
    await new Promise(r => requestAnimationFrame(r));
    const e = L.getEstatisticas();
    quieto = (e.pendentes === 0 && e.tilesDesenhados > 0) ? quieto + 1 : 0;
  }
  rodando = false;
  await laco;
  L.aplicarAtualizacoes();
  const e = L.getEstatisticas();
  e.msParede = Math.round(performance.now() - t0);
  L.dispose();
  rend.dispose();
  return JSON.stringify(e);
};
window.__benchRendererPronto = true;
`;

const medidas = { abertura: [], renderer: {}, ondas: null };
const perfil = join(tmpdir(), 'ebgeo360-bench-cliente');
const chrome = await subirChrome({
  largura: 1904, altura: 985, perfil, semGpu: o.gpu === 'software',
});
const { cdp } = chrome;
await cdp.enviar('Page.enable');
await cdp.enviar('Runtime.enable');
await cdp.enviar('Network.enable');

// ---------------------------------------------------------------- 1. abertura

console.log('\n=== 1. abrir a foto: primeiro quadro e nivel alvo completo ===');
console.log('(pagina dirigida, cache do carregador FRIO a cada rodada)');
console.log(`${'alvo'.padEnd(14)} ${'viewport'.padStart(10)} ${'nivel'.padStart(5)} ${'previsto'.padStart(8)} ${'pedidos'.padStart(8)} ${'KiB'.padStart(8)} ${'1o quadro'.padStart(10)} ${'completo'.padStart(9)} ${'disp'.padStart(6)}`);

await cdp.enviar('Page.navigate', { url: `${o.base}/calibration/tile-demo.html?auto=0` });
if (!await cdp.esperarCondicao('window.__pronto === true', 60000)) {
  console.error('ERRO: tile-demo.html nao ficou pronta.');
  await chrome.fechar();
  process.exit(4);
}

for (const alvo of ALVOS) {
  const prev = rajada(piramide, alvo, RAJADA_REFERENCIA);
  const tempos = [];
  const primeiras = [];
  let ultima = null;
  for (let r = 0; r < o.repeticoes; r++) {
    ultima = await rodarNaPagina(cdp, {
      uuid,
      viewport: { largura: alvo.largura, altura: alvo.altura, dpr: 1 },
      lon: alvo.lon, lat: alvo.lat, fov: alvo.fov,
      modo: 'tiles',
      cache: 'no-store',
    });
    if (ultima.erro) { console.error(`  ${alvo.nome}: ${ultima.erro}`); break; }
    tempos.push(ultima.msNivelAlvoCompleto ?? ultima.msTotal);
    primeiras.push(ultima.msPrimeiraPintura ?? 0);
  }
  if (!tempos.length) continue;
  const serie = resumoTempo(tempos);
  const seriePrim = resumoTempo(primeiras);
  medidas.abertura.push({ alvo: alvo.nome, serie, seriePrim, ultima });
  console.log(
    `${alvo.nome.padEnd(14)} ${`${alvo.largura}x${alvo.altura}`.padStart(10)} ${String(ultima.nivelEscolhido).padStart(5)} `
    + `${String(prev.previsto).padStart(8)} ${String(ultima.tilesPedidos).padStart(8)} `
    + `${(ultima.bytes / 1024).toFixed(0).padStart(8)} `
    + `${seriePrim.melhor.toFixed(0).padStart(10)} ${serie.melhor.toFixed(0).padStart(9)} `
    + `${`${serie.dispersao.toFixed(0)}%`.padStart(6)}`,
  );
}

// ---------------------------------------------------------------- 2. renderer

console.log('\n=== 2. passar `renderer` contra nao passar (preview-viewer.js:741) ===');
await cdp.enviar('Runtime.evaluate', { expression: SCRIPT_RENDERER });
if (!await cdp.esperarCondicao('window.__benchRendererPronto === true', 10000)) {
  console.log('SEM MEDIDA: o script de A/B nao carregou na pagina.');
} else {
  console.log(`${'caminho'.padEnd(22)} ${'uploads'.padStart(8)} ${'parciais'.padStart(9)} ${'MiB p/ GPU'.padStart(11)} ${'tiles'.padStart(6)} ${'ms'.padStart(7)}`);
  const alvoR = ALVOS[0];
  for (const [rotulo, com] of [['hoje (so gl)', false], ['com renderer', true]]) {
    const series = [];
    let ultimo = null;
    for (let r = 0; r < o.repeticoes; r++) {
      const texto = await cdp.avaliar(
        `window.__benchRenderer(${JSON.stringify(uuid)}, ${com}, ${JSON.stringify(alvoR)})`, 180000,
      ).catch((e) => `ERRO ${e.message}`);
      if (String(texto).startsWith('ERRO')) { console.log(`  ${rotulo}: ${texto}`); break; }
      ultimo = JSON.parse(texto);
      series.push(ultimo.bytesParaGpu);
    }
    if (!ultimo) continue;
    // A MELHOR RODADA e a de MENOR bytesParaGpu, pela mesma razao das outras
    // bancadas: ela e a que menos pagou interferencia de fora.
    const melhorBytes = Math.min(...series);
    medidas.renderer[rotulo] = { ...ultimo, melhorBytes };
    console.log(
      `${rotulo.padEnd(22)} ${String(ultimo.uploads).padStart(8)} ${String(ultimo.uploadsParciais).padStart(9)} `
      + `${(melhorBytes / 1048576).toFixed(1).padStart(11)} ${String(ultimo.tilesDesenhados).padStart(6)} `
      + `${String(ultimo.msParede).padStart(7)}`,
    );
  }
  const hoje = medidas.renderer['hoje (so gl)'];
  const novo = medidas.renderer['com renderer'];
  if (hoje && novo && novo.melhorBytes > 0) {
    const delta = ((novo.melhorBytes / hoje.melhorBytes) - 1) * 100;
    console.log(`${(hoje.melhorBytes / 1048576).toFixed(1)} MiB hoje contra ${(novo.melhorBytes / 1048576).toFixed(1)} MiB com renderer: `
      + `${delta >= 0 ? '+' : ''}${delta.toFixed(0)}%`);
    if (delta > 0) {
      console.log('O RENDERER SAIU PIOR NESTA REDE, e o mecanismo esta no proprio codigo.');
      console.log('`marcarPedaco` acumula uma CAIXA ENVOLVENTE (min/max) e `subirPedacoAcumulado`');
      console.log('a envia uma vez por quadro. Em localhost os 54 tiles chegam em poucos quadros,');
      console.log('cada caixa vira uma faixa larga do canvas, e a soma passa a subida inteira.');
      console.log('O ganho documentado (216 para 38 MiB) vem de tiles chegando espalhados no tempo.');
      console.log('CONCLUSAO: a decisao depende da latencia real, e esta bancada nao a reproduz.');
    } else {
      console.log('O renderer corta a subida, como a documentacao previa.');
    }
  }
  console.log('`uploadsParciais` em ZERO na primeira linha e a prova de que o caminho de hoje');
  console.log('nao usa subida parcial nenhuma: cada lote re-especifica a textura inteira.');
}

// ---------------------------------------------------------------- 3. as ondas

console.log('\n=== 3. a serializacao do `await` do nivel 0 (tile-loader.js:1210) ===');

// O RELOGIO E O DO PROTOCOLO, e nao o da pagina. `Network.requestWillBeSent`
// traz `timestamp` monotonico do navegador, entao a ordem das ondas sai do que
// a pilha de rede fez, e nunca do que a pagina achou que fez.
const eventos = [];
cdp.ao('Network.requestWillBeSent', (p) => {
  eventos.push({ tipo: 'pede', url: p.request.url, t: p.timestamp, id: p.requestId });
});
cdp.ao('Network.loadingFinished', (p) => {
  eventos.push({ tipo: 'fecha', id: p.requestId, t: p.timestamp });
});

await cdp.enviar('Page.addScriptToEvaluateOnNewDocument', { source: SONDA_WEB });
eventos.length = 0;
await cdp.enviar('Page.navigate', { url: `${o.base}/calibration/?photo=${uuid}` });
const abriu = await cdp.esperarCondicao(PRONTO_360, 90000);
await esperar(3000);

if (!abriu) {
  console.log('SEM MEDIDA: o visualizador nao abriu a foto em 90 s.');
} else {
  const pede = eventos.filter((e) => e.tipo === 'pede');
  const fecha = new Map(eventos.filter((e) => e.tipo === 'fecha').map((e) => [e.id, e.t]));
  // SO A FOTO ALVO, e so a PRIMEIRA abertura dela. A pagina de calibracao abre
  // a foto pedida e depois busca vizinhas, entao uma leitura por nivel misturava
  // duas fotos: a onda do nivel 4 aparecia DEPOIS da do nivel 6 e o vao entre
  // ondas saia negativo. O vao negativo era da bancada, e nao do carregador.
  const doTile = new RegExp(`/photos/${uuid}/tiles/(\\d+)/\\d+/\\d+\\.webp`);
  const descritor = pede.filter((e) => e.url.includes(`/photos/${uuid}/tiles.json`));
  const tilesTodos = pede.map((e) => {
    const m = doTile.exec(e.url);
    return m ? { ...e, nivel: Number(m[1]), fim: fecha.get(e.id) } : null;
  }).filter(Boolean);
  // O CORTE E A PRIMEIRA PAUSA LONGA. Depois que o nivel alvo fecha, qualquer
  // tile novo da MESMA foto vem de movimento de camera, e nao da abertura.
  const tiles = [];
  let anterior = null;
  for (const t of tilesTodos.sort((x, y) => x.t - y.t)) {
    if (anterior !== null && (t.t - anterior) > 1.0) break;
    tiles.push(t);
    anterior = t.fim ?? t.t;
  }

  if (!descritor.length || !tiles.length) {
    console.log(`SEM MEDIDA: descritor ${descritor.length}, tiles ${tiles.length}.`);
  } else {
    const niveis = [...new Set(tiles.map((t) => t.nivel))].sort((x, y) => x - y);
    const t0 = descritor[0].t;
    const fimDescritor = fecha.get(descritor[0].id) ?? t0;
    const ms = (t) => ((t - t0) * 1000).toFixed(0);

    console.log(`${'onda'.padEnd(22)} ${'n'.padStart(4)} ${'inicio ms'.padStart(10)} ${'fim ms'.padStart(8)}`);
    console.log(`${'tiles.json'.padEnd(22)} ${String(descritor.length).padStart(4)} ${ms(t0).padStart(10)} ${ms(fimDescritor).padStart(8)}`);
    const porOnda = [];
    for (const n of niveis) {
      const doNivel = tiles.filter((t) => t.nivel === n);
      const ini = Math.min(...doNivel.map((t) => t.t));
      const fim = Math.max(...doNivel.map((t) => t.fim ?? t.t));
      porOnda.push({ nivel: n, n: doNivel.length, ini, fim });
    }
    // EM ORDEM DE TEMPO, e nao de nivel. A serializacao e uma pergunta sobre
    // QUANDO cada onda saiu, e ordenar por nivel ja fez a tabela sugerir uma
    // sequencia que o relogio desmentia.
    porOnda.sort((x, y) => x.ini - y.ini);
    for (const w of porOnda) {
      console.log(`${`tiles nivel ${w.nivel}`.padEnd(22)} ${String(w.n).padStart(4)} ${ms(w.ini).padStart(10)} ${ms(w.fim).padStart(8)}`);
    }
    medidas.ondas = porOnda.map((x) => ({ ...x, ini: ms(x.ini), fim: ms(x.fim) }));

    // AS DUAS PERGUNTAS SAO SEPARADAS, e juntar as duas ja fez esta tabela
    // comparar o nivel 0 com o nivel 4 e chamar o resultado de serializacao.
    //   A. quanto o primeiro tile espera pelo descritor
    //   B. o nivel ALVO espera o fundo fechar, ou anda junto com ele
    const fundo = porOnda.find((w) => w.nivel === 0);
    const alvoOnda = porOnda.reduce((m, w) => (w.n > m.n ? w : m), porOnda[0]);
    const primeiroTile = Math.min(...porOnda.map((w) => w.ini));
    console.log(`espera pelo descritor  ${((primeiroTile - fimDescritor) * 1000).toFixed(0)} ms entre o tiles.json fechar e o primeiro tile sair`);
    if (fundo && alvoOnda && fundo.nivel !== alvoOnda.nivel) {
      const vao = (alvoOnda.ini - fundo.fim) * 1000;
      console.log(`fundo contra alvo      nivel 0 de ${ms(fundo.ini)} a ${ms(fundo.fim)} ms, nivel ${alvoOnda.nivel} comeca em ${ms(alvoOnda.ini)} ms`);
      if (vao > 0) {
        console.log(`vao de ${vao.toFixed(0)} ms: o nivel alvo SO saiu depois de o fundo fechar. E o await da linha 1210.`);
      } else {
        console.log(`sobreposicao de ${(-vao).toFixed(0)} ms: o nivel alvo saiu ANTES de o fundo fechar.`);
        console.log('Nesta rede o await nao chega a serializar: o fundo sao poucos tiles e ele');
        console.log('resolve antes de a onda grande terminar. Com RTT de rede real o vao aparece,');
        console.log('e esta bancada nao o reproduz. Medir com --latencia exigiria estrangular o CDP.');
      }
    }
    console.log(`total da abertura      ${((Math.max(...porOnda.map((w) => w.fim)) - t0) * 1000).toFixed(0)} ms ate o ultimo tile fechar`);
    const sonda = await cdp.avaliar('JSON.stringify(window.__sonda.ler())').then(JSON.parse).catch(() => null);
    if (sonda) {
      const tex = Object.values(sonda.textura || {}).reduce((n, t) => n + (t.bytes || 0), 0);
      console.log(`textura subida na abertura: ${(tex / 1048576).toFixed(1)} MiB, heap ${sonda.memoria ? sonda.memoria.heapUsadoMB.toFixed(1) : '-'} MiB`);
    }

    if (!o.semCaptura) {
      try {
        mkdirSync(DIR_CAPTURAS, { recursive: true });
        const tiro = await cdp.enviar('Page.captureScreenshot', { format: 'jpeg', quality: 80 });
        const nome = `${o.projeto}-abertura-nivel${niveis[niveis.length - 1]}.jpg`;
        writeFileSync(join(DIR_CAPTURAS, nome), Buffer.from(tiro.data, 'base64'));
        console.log(`captura   bench/capturas/${nome}`);
      } catch (err) {
        console.log(`captura   FALHOU: ${err.message}`);
      }
    }
  }
}

await chrome.fechar();

if (o.json) {
  writeFileSync(o.json, JSON.stringify({
    quando: new Date().toISOString(), projeto: o.projeto, foto: uuid, medidas,
  }, null, 2));
  console.log(`\ngravado em ${o.json}`);
}
