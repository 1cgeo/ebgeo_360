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
import { createReadStream, existsSync, statSync } from 'node:fs';
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
 * @returns {Promise<{porta: number, url: string, fechar: Function, erros: Array}>}
 */
export async function subirFachada({ raiz, prefixo, destino, porta = 0 }) {
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
      servirEstatico(req, res, raizAbs);
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

function servirEstatico(req, res, raizAbs) {
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
