/**
 * @module bench/lib/carga
 * @description O apoio comum das tres bancadas: gerador de carga HTTP, e a
 * disciplina de aquecimento, repeticao, mediana e descarte de outlier.
 *
 * SEM DEPENDENCIA EXTERNA, com `node:http` e um Agent de keep-alive. O
 * `autocannon` faria a parte de HTTP, mas ele martela UMA url; aqui a LISTA de
 * alvos e o ponto do exercicio, porque a rajada do frustum e o que decide se o
 * cache de pagina do SQLite ajuda ou atrapalha.
 *
 * KEEP-ALIVE LIGADO de proposito. Em producao o servico fica atras do nginx com
 * HTTP/2 e conexao reaproveitada; medir com conexao nova por requisicao mediria
 * o handshake do TCP, que nao e nosso.
 *
 * A ESTATISTICA E A MESMA DAS TRES BANCADAS, e ela tem tres regras que cada uma
 * custou uma medida que mentiu:
 *
 * 1. RODADAS INTERCALADAS. Medir uma configuracao inteira e depois a outra mede
 *    o cache de pagina do sistema esquentando, e ja inverteu resultado.
 * 2. A MELHOR RODADA, e nao a media. A melhor e a que menos pagou interferencia
 *    de fora. A media soma o ruido de todo mundo, e a mediana carrega metade.
 * 3. A REGUA SAI DA DISPERSAO MEDIDA, nunca de um limiar redondo. Diferenca
 *    abaixo dela pode ser so a rodada que calhou de correr sozinha.
 */

import http from 'node:http';
import { performance } from 'node:perf_hooks';

// ---------------------------------------------------------------- estatistica

/**
 * Mediana de uma lista de numeros.
 * @param {number[]} v - Amostras
 * @returns {number} O valor central
 */
export function mediana(v) {
  return [...v].sort((a, b) => a - b)[v.length >> 1];
}

/**
 * Bytes em MiB, com uma casa.
 * @param {number} b - Bytes
 * @returns {number} MiB
 */
export function mib(b) {
  return b / 1048576;
}

/**
 * @typedef {object} Serie
 * @property {number} melhor    - A melhor rodada, na unidade da funcao medida
 * @property {number} mediana   - A rodada central
 * @property {number} pior      - A pior rodada
 * @property {number} dispersao - (pior/melhor - 1) em porcento
 * @property {number[]} rodadas - Todas as rodadas, em ordem de execucao
 */

/**
 * Resume uma serie de rodadas onde MENOR e melhor (tempo).
 * @param {number[]} tempos - Uma medida por rodada
 * @returns {Serie} O resumo
 */
export function resumoTempo(tempos) {
  const v = [...tempos].sort((a, b) => a - b);
  const melhor = v[0];
  const pior = v[v.length - 1];
  return {
    melhor,
    mediana: v[v.length >> 1],
    pior,
    dispersao: melhor > 0 ? ((pior / melhor) - 1) * 100 : 0,
    rodadas: tempos,
  };
}

/**
 * A regua que decide se uma diferenca sai do ruido.
 *
 * Metade da MENOR dispersao entre as duas medidas comparadas, com piso de 5%.
 * Abaixo dela a diferenca pode ser so a rodada que calhou de correr sozinha, e
 * nao sustenta trocar um pragma nem um parametro do cliente.
 *
 * @param {Serie} a - Serie de referencia
 * @param {Serie} b - Serie comparada
 * @returns {number} A regua, em porcento
 */
export function regua(a, b) {
  return Math.max(5, Math.min(a.dispersao, b.dispersao) / 2);
}

/**
 * Repete uma medida sincrona, com aquecimento e coletor de lixo sob controle.
 *
 * O COLETOR IMPORTA AQUI. Cada leitura de tile aloca um Buffer de dezenas de KB,
 * entao uma rodada de milhares de chaves produz centenas de MB de lixo. Sem
 * `--expose-gc` a coleta cai no meio de uma rodada qualquer e a variacao come a
 * diferenca que se quer medir.
 *
 * @param {Function} fn - A medida. Recebe o indice da rodada, devolve bytes
 * @param {object} opcoes - Configuracao
 * @param {number} opcoes.rodadas - Quantas rodadas medidas
 * @param {number} [opcoes.aquecimento] - Rodadas descartadas antes de medir
 * @returns {{serie: Serie, bytes: number}} Tempos em ms, e os bytes da 1a rodada
 */
export function repeteMedida(fn, { rodadas, aquecimento = 1 }) {
  const coleta = typeof globalThis.gc === 'function' ? globalThis.gc : null;
  for (let i = 0; i < aquecimento; i++) fn(-1);
  const tempos = [];
  let bytes = 0;
  for (let r = 0; r < rodadas; r++) {
    if (coleta) coleta();
    const t0 = process.hrtime.bigint();
    const n = fn(r);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    if (r === 0) bytes = n || 0;
    tempos.push(ms);
  }
  return { serie: resumoTempo(tempos), bytes };
}

// ---------------------------------------------------------------- carga HTTP

/**
 * @typedef {object} Resultado
 * @property {number} requisicoes - Quantas fecharam
 * @property {number} segundos - Duracao da rajada
 * @property {number} rps - Requisicoes por segundo
 * @property {number} bytes - Corpo recebido
 * @property {number} mbps - MiB por segundo
 * @property {object} latencia - media, p50, p90, p99, max, em ms
 * @property {object} codigos - Contagem por status
 * @property {number} erros - Requisicoes que nem chegaram a responder
 */

/**
 * Dispara `alvos.length` requisicoes com `concorrencia` em voo.
 *
 * @param {Array<{caminho:string}>} alvos - Lista de URLs, na ordem de pedido
 * @param {object} opcoes - Configuracao
 * @param {number} opcoes.concorrencia - Requisicoes em voo
 * @param {Record<string,string>} [opcoes.cabecalhos] - Cabecalhos extras
 * @returns {Promise<Resultado>} A medida da rajada
 */
export function dispara(alvos, { concorrencia, cabecalhos = {} } = {}) {
  return new Promise((resolver) => {
    const agent = new http.Agent({
      keepAlive: true,
      maxSockets: concorrencia,
      maxFreeSockets: concorrencia,
    });

    const latencias = new Float64Array(alvos.length);
    const codigos = Object.create(null);
    let proximo = 0;
    let feitas = 0;
    let bytes = 0;
    let erros = 0;
    const t0 = performance.now();

    const encerra = () => {
      const segundos = (performance.now() - t0) / 1000;
      agent.destroy();
      const ordenadas = Array.from(latencias.subarray(0, feitas)).sort((a, b) => a - b);
      const pct = (p) => (ordenadas.length
        ? ordenadas[Math.min(ordenadas.length - 1, Math.floor(ordenadas.length * p))]
        : 0);
      const soma = ordenadas.reduce((a, b) => a + b, 0);
      resolver({
        requisicoes: feitas,
        segundos: +segundos.toFixed(3),
        rps: +(feitas / segundos).toFixed(1),
        bytes,
        mbps: +(bytes / 1048576 / segundos).toFixed(1),
        latencia: {
          media: +(soma / (ordenadas.length || 1)).toFixed(2),
          p50: +pct(0.5).toFixed(2),
          p90: +pct(0.9).toFixed(2),
          p99: +pct(0.99).toFixed(2),
          max: +(ordenadas[ordenadas.length - 1] || 0).toFixed(2),
        },
        codigos,
        erros,
      });
    };

    const puxa = () => {
      if (proximo >= alvos.length) {
        if (feitas >= alvos.length) encerra();
        return;
      }
      const i = proximo++;
      const url = new URL(alvos[i].caminho);
      const inicio = performance.now();

      const req = http.request({
        agent,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: 'GET',
        headers: cabecalhos,
      }, (res) => {
        codigos[res.statusCode] = (codigos[res.statusCode] || 0) + 1;
        let n = 0;
        res.on('data', (c) => { n += c.length; });
        res.on('end', () => {
          latencias[feitas] = performance.now() - inicio;
          bytes += n;
          feitas++;
          if (feitas >= alvos.length) encerra();
          else puxa();
        });
      });
      req.on('error', () => {
        erros++;
        feitas++;
        if (feitas >= alvos.length) encerra();
        else puxa();
      });
      req.end();
    };

    if (!alvos.length) { encerra(); return; }
    for (let i = 0; i < Math.min(concorrencia, alvos.length); i++) puxa();
  });
}

/**
 * Aquece o servico e o cache de pagina antes de medir.
 *
 * SEM ISTO A PRIMEIRA MEDIDA MENTE. A primeira leitura de cada pagina do SQLite
 * paga o disco, e a conexao do projeto ainda nem foi aberta: a rodada inicial
 * mede a abertura do banco, e nao o regime.
 *
 * @param {Array<{caminho:string}>} alvos - Lista de URLs
 * @param {number} [quantos] - Quantas requisicoes de aquecimento
 * @returns {Promise<void>} Resolve quando o aquecimento fecha
 */
export async function aquece(alvos, quantos = 300) {
  await dispara(alvos.slice(0, Math.min(quantos, alvos.length)), { concorrencia: 8 });
}

/**
 * Repete uma rajada HTTP e devolve a MELHOR, pela mesma regra do banco.
 *
 * @param {Array<{caminho:string}>} alvos - Lista de URLs
 * @param {object} opcoes - Configuracao
 * @param {number} opcoes.concorrencia - Requisicoes em voo
 * @param {number} [opcoes.rodadas] - Quantas rajadas medidas
 * @param {Record<string,string>} [opcoes.cabecalhos] - Cabecalhos extras
 * @returns {Promise<Resultado & {dispersao:number}>} A melhor rajada
 */
export async function repeteRajada(alvos, { concorrencia, rodadas = 3, cabecalhos }) {
  const todas = [];
  for (let r = 0; r < rodadas; r++) {
    todas.push(await dispara(alvos, { concorrencia, cabecalhos }));
  }
  const porRps = [...todas].sort((a, b) => b.rps - a.rps);
  const melhor = porRps[0];
  const pior = porRps[porRps.length - 1];
  return { ...melhor, dispersao: pior.rps > 0 ? ((melhor.rps / pior.rps) - 1) * 100 : 0 };
}

// ---------------------------------------------------------------- impressao

/**
 * Formata um resultado de rajada numa linha de tabela.
 * @param {string} rotulo - Nome do cenario
 * @param {Resultado} r - A medida
 * @returns {string} A linha pronta
 */
export function linha(rotulo, r) {
  const cods = Object.entries(r.codigos).map(([k, v]) => `${k}:${v}`).join(' ');
  return `${rotulo.padEnd(26)} ${String(r.rps).padStart(9)} ${String(r.mbps).padStart(8)} `
    + `${String(r.latencia.p50).padStart(8)} ${String(r.latencia.p90).padStart(8)} `
    + `${String(r.latencia.p99).padStart(8)} ${String(r.latencia.max).padStart(9)}  ${cods}`;
}

/** Cabecalho da tabela de rajadas. @constant {string} */
export const CABECALHO = `${'cenario'.padEnd(26)} ${'req/s'.padStart(9)} ${'MiB/s'.padStart(8)} `
  + `${'p50 ms'.padStart(8)} ${'p90 ms'.padStart(8)} ${'p99 ms'.padStart(8)} ${'max ms'.padStart(9)}  codigos`;

/**
 * Imprime a comparacao contra uma base, com a regua do ruido ao lado.
 *
 * A regua ao lado de cada linha NAO e enfeite. Sem ela o leitor toma qualquer
 * sinal por resultado, e a bancada passa a decidir por ruido.
 *
 * @param {string} titulo - O que se compara
 * @param {{nome:string, serie:Serie}} base - A referencia
 * @param {Array<{nome:string, serie:Serie}>} outras - As hipoteses
 * @param {boolean} [menorMelhor] - true quando a medida e tempo
 * @returns {boolean} true se alguma linha saiu do ruido
 */
export function comparaContra(titulo, base, outras, menorMelhor = true) {
  console.log(`\n${titulo}`);
  let algumDecide = false;
  for (const o of outras) {
    const bruto = (o.serie.melhor / base.serie.melhor) - 1;
    const delta = (menorMelhor ? -bruto : bruto) * 100;
    const r = regua(base.serie, o.serie);
    const decide = Math.abs(delta) > r;
    if (decide) algumDecide = true;
    console.log(
      `  ${o.nome.padEnd(24)} ${(delta >= 0 ? '+' : '') + delta.toFixed(1)}%`.padEnd(40)
      + `regua ${r.toFixed(0)}%`
      + (decide ? '   <-- FORA DO RUIDO' : '   (nao decide)'),
    );
  }
  return algumDecide;
}

/**
 * Le argumentos de linha de comando na forma `--nome valor`.
 *
 * A MESMA FORMA das tres bancadas, e a mesma do ebgeo_3d. Bancada irma tem de
 * aceitar o mesmo gesto, senao quem sabe usar uma erra na outra.
 *
 * @param {string[]} argv - Em geral process.argv.slice(2)
 * @returns {{valor: Function, tem: Function}} Leitores de argumento
 */
export function argumentos(argv) {
  return {
    /**
     * @param {string} nome - Ex.: '--foto'
     * @param {string} [padrao] - Valor quando o argumento nao veio
     * @returns {string|undefined} O valor cru
     */
    valor(nome, padrao) {
      const i = argv.indexOf(nome);
      return i >= 0 && argv[i + 1] ? argv[i + 1] : padrao;
    },
    /**
     * @param {string} nome - Ex.: '--frio'
     * @returns {boolean} true se a bandeira veio
     */
    tem(nome) {
      return argv.includes(nome);
    },
  };
}
