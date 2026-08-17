/**
 * @module scripts/medir-parede
 * @description Mede o piloto de tiles NO NAVEGADOR, com relogio de parede.
 *
 * POR QUE ESTE SCRIPT EXISTE. O `bench-tiles.js` soma bytes lidos do SQLite. E
 * a medida certa para orcar armazenamento e trafego, e a medida ERRADA para
 * decidir o piloto: ela nao tem cabecalho HTTP, nao tem TLS, nao tem fila de
 * conexao, nao tem decodificacao de WebP e nao tem o custo de subir textura
 * para a GPU. O que o usuario sente e o tempo ate a foto aparecer, e esse tempo
 * so sai de um navegador de verdade pedindo por HTTP de verdade.
 *
 * COMO. Sobe o Chrome em headless com a porta de depuracao aberta, fala CDP por
 * WebSocket (o Node 22+ ja traz WebSocket global, entao nao ha dependencia
 * nova), abre o `tile-demo.html` servido pelo proprio servico e chama a
 * `window.__rodar()` que o demo expoe. O relogio e o `performance.now()` da
 * pagina, e os bytes sao os que a resposta HTTP entregou.
 *
 * O QUE ELE NAO MEDE. Rede real. Tudo aqui e 127.0.0.1, entao a latencia e
 * proxima de zero e o resultado FAVORECE a variante de menos requests, que hoje
 * e o full. Em producao ha nginx com HTTP/2 (medido: ALPN h2), onde 24 objetos
 * pequenos custaram 43 ms contra 375 ms de um full de 2,51 MB. Leia o numero
 * daqui como piso do ganho de tile, nunca como teto.
 *
 * Uso:
 *   node scripts/medir-parede.js --project museu_cms [--repeticoes 5]
 *     [--viewports 1904x985,1350x673] [--estrategias preview,nivel0vis,nivel0]
 *     [--porta 8199] [--json saida.json]
 */

import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { setTimeout as esperar } from 'node:timers/promises';
import Database from 'better-sqlite3';
import config from '../src/config.js';

// ------------------------------------------------------------------ argumentos

function lerArgs(argv) {
  const a = {
    project: null,
    repeticoes: 5,
    viewports: ['1904x985', '1350x673'],
    estrategias: ['preview', 'nivel0vis', 'nivel0'],
    porta: 8199,
    json: null,
    fotos: 3,
  };
  for (let i = 2; i < argv.length; i++) {
    const v = argv[i + 1];
    switch (argv[i]) {
      case '--project': a.project = v; i++; break;
      case '--repeticoes': a.repeticoes = parseInt(v, 10); i++; break;
      case '--viewports': a.viewports = v.split(','); i++; break;
      case '--estrategias': a.estrategias = v.split(','); i++; break;
      case '--porta': a.porta = parseInt(v, 10); i++; break;
      case '--json': a.json = v; i++; break;
      case '--fotos': a.fotos = parseInt(v, 10); i++; break;
      default: break;
    }
  }
  return a;
}

const args = lerArgs(process.argv);
if (!args.project) {
  console.error('Faltou --project <slug>. Exemplo: node scripts/medir-parede.js --project museu_cms');
  process.exit(1);
}

// ------------------------------------------------------------------ Chrome

const CAMINHOS_CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];

function acharChrome() {
  for (const c of CAMINHOS_CHROME) {
    if (c && existsSync(c)) return c;
  }
  return null;
}

// ------------------------------------------------------------------ CDP cru

/**
 * Cliente CDP minimo sobre o WebSocket global do Node.
 *
 * Nao vale trazer puppeteer para tres chamadas de Runtime.evaluate: seriam
 * centenas de MB de dependencia num repositorio que hoje tem sete.
 */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pendentes = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
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

  fechar() { try { this.ws.close(); } catch { /* ja fechado */ } }
}

async function esperarPorta(url, tentativas = 60) {
  for (let i = 0; i < tentativas; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
    } catch { /* ainda subindo */ }
    await esperar(500);
  }
  throw new Error(`nao respondeu: ${url}`);
}

// ------------------------------------------------------------------ estatistica

/**
 * Mediana, e nao media: uma repeticao que pegou uma pausa de coletor de lixo
 * arrasta a media e nao arrasta a mediana.
 */
function mediana(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function resumir(amostras, campo) {
  const xs = amostras.map(a => a[campo]).filter(x => typeof x === 'number' && Number.isFinite(x));
  if (!xs.length) return null;
  return { p50: Math.round(mediana(xs)), min: Math.round(Math.min(...xs)), max: Math.round(Math.max(...xs)), n: xs.length };
}

// ------------------------------------------------------------------ principal

const chrome = acharChrome();
if (!chrome) {
  console.error('Chrome nao encontrado. Caminhos tentados:\n  ' + CAMINHOS_CHROME.join('\n  '));
  process.exit(1);
}

// As fotos saem do banco de TILES, e nao do index: medir uma foto sem piramide
// compararia tile contra nada e o numero nao diria nada.
const caminhoTiles = `${config.projectsDbDir}\\${args.project}_tiles.db`.replace(/\\/g, '/');
if (!existsSync(caminhoTiles)) {
  console.error(`Sem piramide para ${args.project}: ${caminhoTiles} nao existe. Rode generate-tiles.js antes.`);
  process.exit(1);
}
const tdb = new Database(caminhoTiles, { readonly: true });
const fotos = tdb.prepare('SELECT photo_id FROM tile_pyramids ORDER BY photo_id LIMIT ?').all(args.fotos).map(r => r.photo_id);
const piramide = tdb.prepare('SELECT * FROM tile_pyramids LIMIT 1').get();
tdb.close();

console.log(`Medida de parede, ${args.project}`);
console.log(`  Piramide:    ${piramide.width}x${piramide.height}, tile ${piramide.tile_size}, q${piramide.quality}, razao ${piramide.razao ?? 2}`);
console.log(`  Fotos:       ${fotos.length}  |  repeticoes: ${args.repeticoes}`);
console.log(`  Viewports:   ${args.viewports.join(', ')}`);
console.log(`  Estrategias: ${args.estrategias.join(', ')}, mais 'full' como controle`);
console.log('');

// 1. Sobe o servico
const servidor = spawn(process.execPath, ['src/server.js'], {
  env: { ...process.env, PORT: String(args.porta), LOG_LEVEL: 'warn' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let saidaServidor = '';
servidor.stdout.on('data', d => { saidaServidor += d; });
servidor.stderr.on('data', d => { saidaServidor += d; });

const linhas = [];
let cdp = null;
let navegador = null;

try {
  const saude = await esperarPorta(`http://127.0.0.1:${args.porta}/health`);
  console.log(`  Servico no ar: ${saude.projects} projetos, porta ${args.porta}`);

  for (const viewport of args.viewports) {
    const [larg, alt] = viewport.split('x').map(Number);

    // Um Chrome POR VIEWPORT: --window-size so vale na criacao, e mudar o
    // tamanho depois nao muda o devicePixelRatio nem o layout inicial.
    navegador = spawn(chrome, [
      '--headless=new',
      '--enable-gpu',
      '--use-angle=d3d11',
      '--ignore-gpu-blocklist',
      '--remote-debugging-port=0',
      '--remote-allow-origins=*',
      `--window-size=${larg},${alt}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--user-data-dir=' + (process.env.TEMP || '/tmp') + '/piloto-tiles-chrome-' + larg,
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
    });

    // O alvo da pagina, e nao o do navegador: Runtime.evaluate precisa do alvo.
    const alvos = await (await fetch(urlDevtools.replace(/^ws:\/\/([^/]+).*/, 'http://$1/json/list'))).json();
    const pagina = alvos.find(t => t.type === 'page');
    cdp = await Cdp.conectar(pagina.webSocketDebuggerUrl);
    await cdp.enviar('Page.enable');
    await cdp.enviar('Runtime.enable');

    // `auto=0` DESLIGA a carga automatica do demo. Sem isso, a foto de exemplo
    // que a pagina abre sozinha disputa a rede com a primeira execucao dirigida,
    // e a primeira medida de cada viewport sai inflada.
    const url = `http://127.0.0.1:${args.porta}/calibration/tile-demo.html?auto=0`;
    await cdp.enviar('Page.navigate', { url });
    // Espera o demo publicar o gancho, em vez de dormir um tempo arbitrario.
    for (let i = 0; i < 60; i++) {
      const pronto = await cdp.avaliar('typeof window.__rodar === "function"').catch(() => false);
      if (pronto) break;
      await esperar(500);
      if (i === 59) throw new Error('window.__rodar nunca apareceu. O tile-demo.html expoe o gancho?');
    }

    const real = await cdp.avaliar('JSON.stringify({w:innerWidth,h:innerHeight,dpr:devicePixelRatio})');
    console.log(`\n  Viewport pedido ${viewport}, real ${real}`);

    for (const estrategia of [...args.estrategias, 'full']) {
      for (const uuid of fotos) {
        const amostras = [];
        for (let rep = 0; rep < args.repeticoes; rep++) {
          const modo = estrategia === 'full' ? 'full' : 'tiles';
          const chamada = `window.__rodar(${JSON.stringify({ uuid, estrategia, modo, lon: 137 * (rep + 1) % 360, lat: 0, fov: 75 })})`;
          const m = await cdp.avaliar(chamada);
          if (m && typeof m === 'object') amostras.push(m);
        }
        if (!amostras.length) { console.log(`    ${estrategia} ${uuid.slice(0, 8)}: sem medida`); continue; }
        linhas.push({
          viewport, estrategia, uuid,
          nivel: amostras[0].nivelEscolhido ?? null,
          requests: resumir(amostras, 'requests'),
          bytes: resumir(amostras, 'bytes'),
          primeiraPintura: resumir(amostras, 'msPrimeiraPintura'),
          completo: resumir(amostras, 'msNivelAlvoCompleto'),
        });
        const u = linhas[linhas.length - 1];
        console.log(`    ${estrategia.padEnd(10)} ${uuid.slice(0, 8)}  nivel ${u.nivel}  ${String(u.requests?.p50).padStart(3)} req  ${String(Math.round((u.bytes?.p50 ?? 0) / 1024)).padStart(5)} KB  1a pintura ${String(u.primeiraPintura?.p50).padStart(5)} ms  completo ${String(u.completo?.p50).padStart(5)} ms`);
      }
    }

    cdp.fechar(); cdp = null;
    navegador.kill(); navegador = null;
  }

  // ------------------------------------------------------------- consolidado
  console.log('\n\nMEDIANA POR VIEWPORT E ESTRATEGIA (mediana das fotos, cada uma mediana das repeticoes)');
  const tabela = [];
  for (const viewport of args.viewports) {
    for (const estrategia of [...args.estrategias, 'full']) {
      const g = linhas.filter(l => l.viewport === viewport && l.estrategia === estrategia);
      if (!g.length) continue;
      tabela.push({
        viewport,
        estrategia,
        nivel: g[0].nivel,
        requests: mediana(g.map(x => x.requests?.p50 ?? 0)),
        KB: Math.round(mediana(g.map(x => x.bytes?.p50 ?? 0)) / 1024),
        'ms 1a pintura': Math.round(mediana(g.map(x => x.primeiraPintura?.p50 ?? 0))),
        'ms completo': Math.round(mediana(g.map(x => x.completo?.p50 ?? 0))),
      });
    }
  }
  console.table(tabela);

  for (const viewport of args.viewports) {
    const full = tabela.find(t => t.viewport === viewport && t.estrategia === 'full');
    if (!full) continue;
    console.log(`\n  ${viewport}, contra o full de hoje:`);
    for (const t of tabela.filter(x => x.viewport === viewport && x.estrategia !== 'full')) {
      const rb = full.KB / Math.max(t.KB, 1);
      const rt = full['ms completo'] / Math.max(t['ms completo'], 1);
      console.log(`    ${t.estrategia.padEnd(10)} bytes ${rb.toFixed(2)}x menos, tempo ${rt.toFixed(2)}x ${rt >= 1 ? 'menos' : 'MAIS'}`);
    }
  }

  console.log('\n  LEIA COM ESTA RESSALVA: tudo aqui e 127.0.0.1, sem latencia de rede.');
  console.log('  Isso FAVORECE quem faz menos requests, que hoje e o full. Em producao ha');
  console.log('  nginx com HTTP/2 (ALPN h2 medido), onde 24 objetos pequenos custaram 43 ms');
  console.log('  contra 375 ms de um full de 2,51 MB. O ganho de tile aqui e piso, nao teto.');

  if (args.json) {
    writeFileSync(args.json, JSON.stringify({ piramide, args, linhas, tabela }, null, 2));
    console.log(`\n  Medidas gravadas em ${args.json}`);
  }
} catch (err) {
  console.error('\nFALHOU:', err.message);
  if (saidaServidor) console.error('Saida do servico:\n' + saidaServidor.slice(-2000));
  process.exitCode = 1;
} finally {
  if (cdp) cdp.fechar();
  if (navegador) navegador.kill();
  servidor.kill();
}
