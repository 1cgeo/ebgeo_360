/**
 * @module scripts/lib/externo
 * @description Decide o que acontece com o pedido que SAI DA MAQUINA.
 *
 * POR QUE ISTO PRECISOU EXISTIR. O estilo inicial do mapa 2D do ebgeo_web e uma
 * camada raster do OpenStreetMap, na internet
 * (src/js/baselayers/carta_topografica.js). O MapLibre so emite `load` quando as
 * fontes do estilo terminam de carregar, e o `map_sig.js` pendura TODA a
 * partida da aplicacao nesse evento, inclusive a abertura do 360 por link
 * compartilhado. Numa maquina sem saida para a internet o pedido do tile nao
 * falha: ele fica pendurado. Entao `load` nunca vem, a tela de carregamento
 * nunca sai, e nao ha erro nenhum no console. Medido aqui: `style.load` em
 * 272 ms, tres `sourcedata` de `osm`, e nenhum `load` ou `idle` em 35 s.
 *
 * ISSO E UM ACHADO SOBRE O SISTEMA, e nao so um obstaculo da medida: qualquer
 * cliente atras de um proxy que engula o OSM em silencio ve a mesma tela parada.
 *
 * O QUE ESTE MODULO FAZ. Ele torna a decisao EXPLICITA, em vez de deixar a
 * medida depender de a maquina ter internet naquele dia:
 *
 *   local     entrega um substituto local no lugar do recurso externo. E o
 *             padrao, porque e o unico modo deterministico: a latencia do OSM
 *             entraria como ruido em toda medida de tile de panoramica.
 *   passa     deixa sair. Mede o que o operador com internet realmente recebe.
 *   bloqueia  reprova o pedido. Mede o caso degradado de proposito.
 *
 * SO `https://` E INTERCEPTADO, e a razao e o custo: o dominio `Fetch` do CDP
 * faz cada pedido dar uma volta ate o Node, e a fachada fala `http://127.0.0.1`.
 * Interceptar tudo poria essa volta no caminho de cada tile de panoramica, que e
 * exatamente o que se esta cronometrando. Nada no ebgeo_web busca recurso
 * externo por `http://` sem TLS.
 */

import sharp from 'sharp';

export const MODOS = ['local', 'passa', 'bloqueia'];

/**
 * O tile substituto: cinza chapado.
 *
 * CHAPADO DE PROPOSITO. Um mapa de fundo com desenho mudaria pixel a cada
 * movimento do minimapa, e a medida de "a tela parou de mudar" passaria a
 * responder pelo mapa, e nao pela panoramica.
 */
async function tileSubstituto() {
  return sharp({
    create: { width: 256, height: 256, channels: 3, background: { r: 214, g: 214, b: 210 } },
  }).png().toBuffer();
}

/**
 * Liga a politica de recurso externo numa sessao CDP.
 *
 * @param {import('./cdp.js').Cdp} cdp
 * @param {string} modo um de MODOS
 * @returns {Promise<Object>} contador do que foi interceptado
 */
export async function tratarExterno(cdp, modo) {
  const conta = { substituidos: 0, bloqueados: 0, passaram: 0, semResposta: 0 };
  if (modo === 'passa') return conta;

  const png = modo === 'local' ? await tileSubstituto() : null;
  const pngB64 = png ? png.toString('base64') : null;

  cdp.ao('Fetch.requestPaused', async (p) => {
    const url = p.request.url;
    try {
      if (modo === 'bloqueia') {
        conta.bloqueados++;
        await cdp.enviar('Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' });
        return;
      }
      const caminho = new URL(url).pathname.toLowerCase();
      if (/\.(png|jpe?g|webp|gif)$/.test(caminho) || /\/\d+\/\d+\/\d+$/.test(caminho)) {
        conta.substituidos++;
        await cdp.enviar('Fetch.fulfillRequest', {
          requestId: p.requestId,
          responseCode: 200,
          responseHeaders: [
            { name: 'content-type', value: 'image/png' },
            { name: 'cache-control', value: 'public, max-age=31536000' },
            { name: 'access-control-allow-origin', value: '*' },
          ],
          body: pngB64,
        });
        return;
      }
      if (caminho.endsWith('.pbf')) {
        // Corpo vazio e um protobuf valido e sem glifo. Devolver 404 faria o
        // MapLibre repetir o pedido, e a repeticao apareceria na conta de rede
        // como se a aplicacao pedisse duas vezes.
        conta.substituidos++;
        await cdp.enviar('Fetch.fulfillRequest', {
          requestId: p.requestId,
          responseCode: 200,
          responseHeaders: [
            { name: 'content-type', value: 'application/x-protobuf' },
            { name: 'access-control-allow-origin', value: '*' },
          ],
          body: '',
        });
        return;
      }
      conta.semResposta++;
      await cdp.enviar('Fetch.fulfillRequest', {
        requestId: p.requestId,
        responseCode: 404,
        responseHeaders: [{ name: 'access-control-allow-origin', value: '*' }],
        body: '',
      });
    } catch {
      // REPROVA, e nunca deixa passar. A versao anterior chamava
      // `Fetch.continueRequest` aqui, na ideia de que soltar o pedido era o
      // caminho conservador. E o oposto: solto, ele vai para a internet de
      // verdade, que nesta maquina nao existe, e ali ele nao FALHA, ele fica
      // pendurado. Um unico tile pendurado impede o MapLibre de emitir `load`, e
      // o ebgeo_web pendura a partida inteira nesse evento: a tela de
      // carregamento nunca sai e o 360 nunca abre, sem um erro no console.
      //
      // Foi assim que uma rodada de quatro combinacoes travou na segunda, com
      // `emVoo` vazio (o pedido some da contabilidade do dominio Network quando
      // fica preso no dominio Fetch) e nenhum erro em lugar nenhum. Falhar e
      // ruidoso e verdadeiro; pendurar e silencioso e mentiroso.
      conta.bloqueados++;
      await cdp.enviar('Fetch.failRequest', {
        requestId: p.requestId, errorReason: 'BlockedByClient',
      }).catch(() => {});
    }
  });

  await cdp.enviar('Fetch.enable', { patterns: [{ urlPattern: 'https://*' }] });
  return conta;
}
