/**
 * @module scripts/lib/cdp
 * @description Cliente CDP minimo e o lancador de Chrome headless que os
 * scripts de medida compartilham.
 *
 * POR QUE NAO PUPPETEER. Sao tres chamadas de `Runtime.evaluate` e alguns
 * eventos de `Network`. Trazer puppeteer custaria centenas de MB de dependencia
 * num repositorio que hoje tem oito, e baixaria um Chromium proprio, que NAO e
 * o navegador em que o operador roda o sistema. O Node 22 ja traz `WebSocket`
 * global, entao o cliente cabe em uma classe.
 *
 * POR QUE ELE SAIU DO `medir-parede.js`. O `medir-web.js` precisa do mesmo
 * cliente. Copiar seria criar duas maneiras de falar CDP, e duas maneiras
 * divergem em silencio: a que ganhar um conserto deixa a outra medindo errado
 * sem avisar. Quem mexer no protocolo mexe aqui.
 */

import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { setTimeout as esperar } from 'node:timers/promises';

const CAMINHOS_CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

/**
 * Acha o Chrome instalado na maquina.
 * @returns {string|null} caminho do executavel, ou null
 */
export function acharChrome() {
  for (const c of CAMINHOS_CHROME) {
    if (c && existsSync(c)) return c;
  }
  return null;
}

/** @returns {string} a lista de caminhos tentados, para a mensagem de erro */
export function caminhosChromeTentados() {
  return CAMINHOS_CHROME.filter(Boolean).join('\n  ');
}

/**
 * Cliente CDP sobre o WebSocket global do Node.
 *
 * Alem do par pedido/resposta, ele entrega EVENTOS por `ao(metodo, fn)`. Sem
 * isso nao ha como ler `Network.responseReceived`, que e de onde saem os bytes
 * de verdade: o que a pagina acha que baixou e eco dela mesma, e o que o
 * protocolo relata e o que a pilha de rede entregou.
 */
export class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pendentes = new Map();
    this.ouvintes = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.method) {
        const fns = this.ouvintes.get(msg.method);
        if (fns) for (const fn of fns) { try { fn(msg.params); } catch { /* ouvinte nao derruba a sessao */ } }
        return;
      }
      const p = this.pendentes.get(msg.id);
      if (!p) return;
      this.pendentes.delete(msg.id);
      if (msg.error) p.rejeitar(new Error(JSON.stringify(msg.error)));
      else p.resolver(msg.result);
    });
  }

  static async conectar(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('WebSocket CDP nao abriu')), { once: true });
    });
    return new Cdp(ws);
  }

  /**
   * Registra um ouvinte de evento CDP.
   * @param {string} metodo por exemplo 'Network.responseReceived'
   * @param {Function} fn recebe os params do evento
   * @returns {Function} chame para desinscrever
   */
  ao(metodo, fn) {
    if (!this.ouvintes.has(metodo)) this.ouvintes.set(metodo, new Set());
    this.ouvintes.get(metodo).add(fn);
    return () => this.ouvintes.get(metodo)?.delete(fn);
  }

  enviar(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolver, rejeitar) => this.pendentes.set(id, { resolver, rejeitar }));
  }

  /**
   * Avalia uma expressao na pagina e devolve o valor ja desempacotado.
   * `awaitPromise` faz o CDP esperar a Promise da pagina, que e como a medida
   * de parede chega inteira em vez de vir pela metade.
   */
  async avaliar(expressao, msLimite = 120000) {
    const r = await this.enviar('Runtime.evaluate', {
      expression: expressao,
      awaitPromise: true,
      returnByValue: true,
      timeout: msLimite,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails));
    }
    return r.result.value;
  }

  /**
   * Espera uma condicao virar verdadeira na PAGINA, com limite de tempo.
   *
   * Espera-se por condicao, e nunca por um `sleep` arbitrario: dormir 2 s
   * esconde a lentidao que se quer medir e some com a corrida que se quer pegar.
   *
   * @param {string} expressao expressao booleana avaliada na pagina
   * @param {number} msLimite quanto esperar antes de desistir
   * @param {number} msPasso intervalo entre tentativas
   * @returns {Promise<boolean>} true se a condicao virou verdadeira a tempo
   */
  async esperarCondicao(expressao, msLimite = 30000, msPasso = 50) {
    const fim = Date.now() + msLimite;
    while (Date.now() < fim) {
      const v = await this.avaliar(expressao).catch(() => false);
      if (v) return true;
      await esperar(msPasso);
    }
    return false;
  }

  fechar() { try { this.ws.close(); } catch { /* ja fechado */ } }
}

/**
 * Sobe um Chrome headless com a porta de depuracao aberta e conecta no alvo da
 * pagina.
 *
 * UM CHROME POR VIEWPORT, e nao um redimensionado. `--window-size` so vale na
 * criacao: mudar o tamanho depois nao muda o `devicePixelRatio` nem o layout
 * inicial, e o 360 escolhe o nivel da piramide pela largura da tela.
 *
 * `--enable-precise-memory-info` existe porque sem ele o `performance.memory`
 * vem arredondado em degraus grandes, e a medida de heap nao distingue uma foto
 * de dez.
 *
 * @param {Object} opcoes
 * @param {number} opcoes.largura
 * @param {number} opcoes.altura
 * @param {string} opcoes.perfil diretorio de perfil, apagado antes de subir
 * @param {string[]} [opcoes.extras] argumentos adicionais
 * @returns {Promise<{navegador: Object, cdp: Cdp, fechar: Function}>}
 */
export async function subirChrome({ largura, altura, perfil, extras = [] }) {
  const chrome = acharChrome();
  if (!chrome) {
    throw new Error(`Chrome nao encontrado. Caminhos tentados:\n  ${caminhosChromeTentados()}`);
  }

  // Perfil limpo a cada subida. Sem isso o cache de disco do Chrome sobrevive
  // entre execucoes e a medida "fria" mede um cache quente da rodada anterior.
  try { rmSync(perfil, { recursive: true, force: true }); } catch { /* nao existia */ }

  const navegador = spawn(chrome, [
    '--headless=new',
    '--enable-gpu',
    '--use-angle=d3d11',
    '--ignore-gpu-blocklist',
    '--enable-precise-memory-info',
    '--remote-debugging-port=0',
    '--remote-allow-origins=*',
    `--window-size=${largura},${altura}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    `--user-data-dir=${perfil}`,
    ...extras,
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  // A porta real sai no stderr do Chrome, porque pedimos 0 (efemera).
  const urlDevtools = await new Promise((res, rej) => {
    let buf = '';
    const t = setTimeout(() => rej(new Error('Chrome nao anunciou a porta de depuracao')), 30000);
    navegador.stderr.on('data', (d) => {
      buf += d;
      const m = buf.match(/ws:\/\/[^\s]+/);
      if (m) { clearTimeout(t); res(m[0]); }
    });
    navegador.on('exit', (code) => { clearTimeout(t); rej(new Error(`Chrome saiu antes de abrir (codigo ${code})`)); });
  });

  const base = urlDevtools.replace(/^ws:\/\/([^/]+).*/, 'http://$1');
  const alvos = await (await fetch(`${base}/json/list`)).json();
  const pagina = alvos.find(t => t.type === 'page');
  if (!pagina) throw new Error('Chrome subiu sem alvo de pagina');
  const cdp = await Cdp.conectar(pagina.webSocketDebuggerUrl);

  return {
    navegador,
    cdp,
    /**
     * Fecha pelo protocolo, e so depois mata o processo.
     *
     * `kill()` sozinho NAO basta no Windows: ele derruba o processo pai e deixa
     * de pe os processos de renderizacao e de GPU, que seguram o diretorio de
     * perfil. A subida seguinte encontra o perfil travado e o Chrome sai com
     * codigo 21, sem uma linha de explicacao. Custou uma rodada inteira desta
     * medida para achar.
     */
    async fechar() {
      try { await cdp.enviar('Browser.close'); } catch { /* ja caiu */ }
      cdp.fechar();
      await new Promise((ok) => {
        const t = setTimeout(ok, 3000);
        navegador.once('exit', () => { clearTimeout(t); ok(); });
      });
      try { navegador.kill(); } catch { /* ja morreu */ }
    },
  };
}

/**
 * Bate numa URL ate ela responder, ou desiste.
 * @param {string} url
 * @param {number} tentativas
 * @returns {Promise<Object>} o corpo JSON da resposta
 */
export async function esperarPorta(url, tentativas = 60) {
  for (let i = 0; i < tentativas; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
    } catch { /* ainda subindo */ }
    await esperar(500);
  }
  throw new Error(`nao respondeu: ${url}`);
}
