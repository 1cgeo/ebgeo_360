/**
 * @module scripts/lib/fachada
 * @description Sobe, para a medida, a MESMA topologia que a producao tem: um
 * servidor de frente que entrega o `ebgeo_web` construido e repassa `/ebgeo_360`
 * para o servico de imagens.
 *
 * POR QUE NAO O `vite dev`. O servidor de desenvolvimento entrega cada modulo
 * como um arquivo separado, compilado na hora do primeiro pedido. Sao centenas
 * de objetos e uma compilacao sob demanda que a producao nao tem. Medir ali
 * daria um numero que nao existe em lugar nenhum, e pior: daria um numero RUIM
 * por um motivo que nao e o do sistema.
 *
 * POR QUE NAO DOIS ORIGENS. Em desenvolvimento o `config.js` aponta o 360 para
 * `localhost:8081` e o navegador fala com dois origens. Em producao ha um so,
 * porque o proxy publica o servico sob `/ebgeo_360` e reescreve o caminho para
 * `/api/v1`. As duas topologias tem custo de rede diferente: origem separada
 * paga preflight de CORS e uma segunda conexao. A que interessa medir e a de
 * producao, e o pacote construido ja pede `/ebgeo_360`, entao basta cumprir o
 * contrato do proxy aqui.
 *
 * A REESCRITA E A MESMA DO NGINX: recebe `/ebgeo_360/<resto>`, pede
 * `/api/v1/<resto>` ao servico. Errar isso da 404 em uma camada so, que e o modo
 * silencioso de falhar (o MapLibre trata tile 404 como tile vazio).
 */

import { createServer } from 'node:http';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { extname, join, normalize, resolve, sep } from 'node:path';

const TIPOS = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.geojson': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.pbf': 'application/x-protobuf',
  '.pmtiles': 'application/octet-stream',
  '.glb': 'model/gltf-binary',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.webm': 'video/webm',
  '.terrain': 'application/octet-stream',
};

/**
 * @param {Object} opcoes
 * @param {string} opcoes.raiz diretorio `dist` do ebgeo_web
 * @param {string} opcoes.prefixo prefixo publico do 360, por exemplo '/ebgeo_360'
 * @param {string} opcoes.destino base do servico, por exemplo 'http://127.0.0.1:8199/api/v1'
 * @param {number} opcoes.porta 0 pede porta efemera
 * @param {boolean} [opcoes.comprimir] responder gzip no estatico, como o nginx
 * @param {boolean} [opcoes.substituirExterno] serve um substituto local para o
 *   recurso que sai da maquina. Ver `REMENDO_EXTERNO`
 * @returns {Promise<{porta: number, url: string, fechar: Function, erros: Array}>}
 */
export async function subirFachada({ raiz, prefixo, destino, porta = 0, substituirExterno = false }) {
  const raizAbs = resolve(raiz);
  if (!existsSync(raizAbs)) throw new Error(`raiz da fachada nao existe: ${raizAbs}`);

  const erros = [];

  const servidor = createServer(async (req, res) => {
    // O NAVEGADOR CANCELA PEDIDO O TEMPO TODO, e mais ainda com a rede
    // estrangulada: o carregador de tiles aborta o lote quando a camera anda, e
    // o Chrome inteiro morre no fim de cada combinacao com pedidos em voo.
    // Escrever num `res` ja destruido lanca DENTRO do proprio `catch`, e a
    // excecao escapa do manipulador. A fachada seguia de pe, e alguns pedidos
    // seguintes ficavam pendurados: a aplicacao entao nao completava a partida,
    // e o 360 nao abria. Custou uma rodada de quatro combinacoes para achar,
    // porque so a terceira falhava.
    res.on('error', (err) => erros.push({ url: req.url, erro: `res: ${err.message}` }));
    req.on('error', (err) => erros.push({ url: req.url, erro: `req: ${err.message}` }));
    try {
      if (req.url.startsWith(`${prefixo}/`) || req.url === prefixo) {
        await repassar(req, res, prefixo, destino);
        return;
      }
      if (substituirExterno && req.url.startsWith(CAMINHO_EXTERNO)) {
        servirSubstituto(req, res);
        return;
      }
      servirEstatico(req, res, raizAbs, substituirExterno);
    } catch (err) {
      if (err?.name !== 'AbortError') erros.push({ url: req.url, erro: err.message });
      try {
        if (res.destroyed || res.writableEnded) return;
        if (!res.headersSent) res.writeHead(500);
        res.end('erro na fachada');
      } catch { /* o cliente ja foi embora */ }
    }
  });

  // Conexao meio aberta de um Chrome que morreu nao pode virar excecao solta.
  servidor.on('clientError', (err, socket) => {
    erros.push({ url: '(socket)', erro: err.message });
    try { socket.destroy(); } catch { /* ja destruido */ }
  });

  await new Promise((ok, falha) => {
    servidor.once('error', falha);
    servidor.listen(porta, '127.0.0.1', ok);
  });

  const portaReal = servidor.address().port;
  return {
    porta: portaReal,
    url: `http://127.0.0.1:${portaReal}`,
    erros,
    fechar: () => new Promise(ok => servidor.close(ok)),
  };
}

async function repassar(req, res, prefixo, destino) {
  const resto = req.url.slice(prefixo.length);
  const alvo = `${destino}${resto}`;

  // O cancelamento do cliente VIAJA ate o servico. Sem isto, cada tile abortado
  // pelo navegador continua sendo lido do SQLite e serializado ate o fim, e o
  // trabalho descartado se acumula na medida como se fosse carga real.
  const ac = new AbortController();
  const desistir = () => { if (!res.writableEnded) ac.abort(); };
  res.on('close', desistir);
  req.on('aborted', desistir);

  const upstream = await fetch(alvo, {
    method: req.method,
    headers: { ...req.headers, host: new URL(destino).host },
    signal: ac.signal,
  });
  const cabecalhos = {};
  upstream.headers.forEach((v, k) => {
    // `content-encoding` e `content-length` descrevem o corpo QUE O FETCH JA
    // DESCOMPACTOU. Repassa-los faria o navegador tentar inflar de novo o que ja
    // esta inflado, e o pedido morreria em ERR_CONTENT_DECODING_FAILED.
    if (k === 'content-encoding' || k === 'content-length' || k === 'transfer-encoding') return;
    cabecalhos[k] = v;
  });
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(upstream.status, cabecalhos);
  if (!upstream.body) { res.end(); return; }
  const buf = Buffer.from(await upstream.arrayBuffer());
  if (res.destroyed || res.writableEnded) return;
  res.end(buf);
}

/** Prefixo por onde a fachada entrega os substitutos de recurso externo. */
const CAMINHO_EXTERNO = '/__substituto/';

/**
 * O remendo que faz a aplicacao SUBIR numa maquina sem saida para a internet.
 *
 * POR QUE ELE PRECISA EXISTIR. O `map_sig.js` pendura toda a inicializacao no
 * evento `load` do MapLibre, e o estilo inicial e uma camada raster do
 * OpenStreetMap. Sem internet o pedido nao falha, fica PENDURADO: nao ha `load`,
 * a tela de carregamento nunca sai, e o 360 nunca abre. Nao ha erro no console.
 *
 * O QUE ELE FAZ. Injetado antes de qualquer codigo da aplicacao, ele desvia para
 * a propria fachada tudo que apontaria para fora. Tile de imagem vira um
 * quadrado cinza; glifo vira corpo vazio; o resto vira 404, que o MapLibre trata
 * como camada faltando e segue adiante.
 *
 * ISTO E FERRAMENTA DE INSPECAO, e nunca vai para producao: ele so entra quando
 * quem sobe a fachada pede `substituirExterno`. O que se ve com ele e o 360 de
 * verdade sobre um mapa de fundo falso, e nao o sistema inteiro.
 */
const REMENDO_EXTERNO = `<script>
(function () {
  var LOCAL = ${JSON.stringify(CAMINHO_EXTERNO)};
  function desviar(u) {
    var s = String(u);
    if (s.indexOf('http') !== 0) return null;
    if (s.indexOf(location.origin) === 0) return null;
    return LOCAL + (s.indexOf('.pbf') >= 0 ? 'vazio.pbf' : 'tile.png');
  }
  var fetchOriginal = window.fetch;
  window.fetch = function (entrada, opcoes) {
    var url = typeof entrada === 'string' ? entrada : (entrada && entrada.url);
    var novo = desviar(url);
    return fetchOriginal.call(this, novo || entrada, novo ? undefined : opcoes);
  };
  var descritor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
  Object.defineProperty(HTMLImageElement.prototype, 'src', {
    configurable: true,
    get: function () { return descritor.get.call(this); },
    set: function (v) { descritor.set.call(this, desviar(v) || v); }
  });
})();
</script>`;

/** Um PNG cinza de 256x256, o menor que o zlib deixa. Gerado uma vez. */
let pngCinza = null;

function servirSubstituto(req, res) {
  if (req.url.endsWith('.pbf')) {
    // Corpo VAZIO e um protobuf valido sem glifo. Um 404 aqui faria o MapLibre
    // repetir o pedido, e a repeticao apareceria como pedido em dobro.
    res.writeHead(200, { 'content-type': 'application/x-protobuf', 'content-length': 0 });
    res.end();
    return;
  }
  if (!pngCinza) pngCinza = tileCinza();
  res.writeHead(200, {
    'content-type': 'image/png',
    'content-length': pngCinza.length,
    'cache-control': 'public, max-age=31536000, immutable',
  });
  res.end(pngCinza);
}

/**
 * Um PNG 256x256 cinza chapado, montado a mao.
 *
 * CHAPADO DE PROPOSITO: um mapa de fundo com desenho competiria com a
 * panoramica pela atencao de quem esta olhando, e o que se quer ver aqui e o
 * 360.
 */
function tileCinza() {
  const lado = 256;
  const linhas = Buffer.alloc((lado * 3 + 1) * lado);
  for (let y = 0; y < lado; y++) {
    const base = y * (lado * 3 + 1);
    linhas[base] = 0;
    for (let x = 0; x < lado; x++) {
      linhas[base + 1 + x * 3] = 214;
      linhas[base + 2 + x * 3] = 214;
      linhas[base + 3 + x * 3] = 210;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(lado, 0);
  ihdr.writeUInt32BE(lado, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    pedaco('IHDR', ihdr),
    pedaco('IDAT', deflateSync(linhas)),
    pedaco('IEND', Buffer.alloc(0)),
  ]);
}

function pedaco(tipo, dados) {
  const cabeca = Buffer.alloc(4);
  cabeca.writeUInt32BE(dados.length, 0);
  const corpo = Buffer.concat([Buffer.from(tipo, 'ascii'), dados]);
  const cauda = Buffer.alloc(4);
  cauda.writeUInt32BE(crc32(corpo) >>> 0, 0);
  return Buffer.concat([cabeca, corpo, cauda]);
}

const TABELA_CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = TABELA_CRC[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return c ^ -1;
}

function servirEstatico(req, res, raizAbs, substituirExterno = false) {
  const semQuery = req.url.split('?')[0];
  // `normalize` mais a checagem de prefixo barram `..` saindo da raiz.
  const relativo = normalize(decodeURIComponent(semQuery)).replace(/^[\\/]+/, '');
  let caminho = join(raizAbs, relativo);
  if (!caminho.startsWith(raizAbs + sep) && caminho !== raizAbs) {
    res.writeHead(403); res.end('fora da raiz'); return;
  }
  if (res.destroyed) return;
  if (existsSync(caminho) && statSync(caminho).isDirectory()) caminho = join(caminho, 'index.html');
  if (!existsSync(caminho)) {
    // A aplicacao e uma pagina so: qualquer caminho desconhecido cai no
    // index.html, como o `try_files` do nginx.
    caminho = join(raizAbs, 'index.html');
    if (!existsSync(caminho)) { res.writeHead(404); res.end('nao achei'); return; }
  }
  const tipo = TIPOS[extname(caminho).toLowerCase()] || 'application/octet-stream';

  // O remendo entra no `index.html`, e no primeiro lugar possivel: ele precisa
  // valer ANTES de qualquer modulo da aplicacao pedir alguma coisa.
  if (substituirExterno && caminho.endsWith('index.html')) {
    const html = readFileSync(caminho, 'utf8').replace('<head>', `<head>${REMENDO_EXTERNO}`);
    const corpo = Buffer.from(html, 'utf8');
    res.writeHead(200, { 'content-type': tipo, 'content-length': corpo.length, 'cache-control': 'no-cache' });
    res.end(corpo);
    return;
  }

  res.writeHead(200, {
    'content-type': tipo,
    'content-length': statSync(caminho).size,
    // O pacote construido tem hash no nome, entao cache longo e o que a producao
    // faz. O `index.html` nao tem hash e nao pode ser cacheado, ou a medida
    // "fria" leria uma versao velha do arquivo que aponta os pacotes.
    'cache-control': caminho.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable',
  });
  const fluxo = createReadStream(caminho);
  fluxo.on('error', () => { try { res.destroy(); } catch { /* ja foi */ } });
  res.on('close', () => fluxo.destroy());
  fluxo.pipe(res);
}
