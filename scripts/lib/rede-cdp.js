/**
 * @module scripts/lib/rede-cdp
 * @description Grava o trafego da pagina pelo CDP e o classifica por PAPEL.
 *
 * POR QUE PELO CDP, E NAO POR `fetch` EMBRULHADO. O corpo que o `fetch` devolve
 * nao tem cabecalho, nao tem o custo do TLS, nao diz se a resposta veio do
 * cache de disco e nao ve o que o MapLibre pede de dentro de um worker. O CDP ve
 * tudo isso, e `encodedDataLength` e o byte que passou no fio, e nao o corpo
 * depois de descompactado.
 *
 * POR QUE CLASSIFICAR. Um total de bytes nao decide nada. A pergunta util e
 * "quanto foi tile de panoramica, quanto foi o pacote da aplicacao, e quanto
 * saiu da maquina". Sem separar, uma regressao no 360 some dentro do custo de
 * carregar a aplicacao inteira, que e uma ordem de grandeza maior na abertura.
 *
 * O NIVEL DA PIRAMIDE SAI DAQUI, e nao de perguntar ao carregador. A URL do tile
 * carrega o nivel (`/tiles/<nivel>/<x>/<y>.webp`), entao o maior nivel pedido E
 * o nivel que o visualizador escolheu, observado de fora. Foi assim que a troca
 * de escada de 2026-08-18 mostrou 277 respostas 404 numa foto que a interface
 * pintava sem um erro no console.
 */

const RE_TILE = /\/photos\/([0-9a-f-]{36})\/tiles\/(\d+)\/(\d+)\/(\d+)\.webp/i;
const RE_DESCRITOR = /\/photos\/([0-9a-f-]{36})\/tiles\.json/i;
const RE_IMAGEM = /\/photos\/([0-9a-f-]{36})\/image/i;
const RE_META = /\/photos\/([0-9a-f-]{36})(\?|$)/i;
const RE_VETORIAL = /\/tiles\/[a-z_]+\/\d+\/\d+\/\d+/i;

/**
 * Classifica uma URL no papel que ela cumpre.
 * @param {string} url
 * @param {string} origem a origem da propria pagina
 * @returns {{classe: string, nivel: number|null, uuid: string|null}}
 */
export function classificar(url, origem) {
  let m = RE_TILE.exec(url);
  if (m) return { classe: 'tile', nivel: Number(m[2]), uuid: m[1] };
  m = RE_DESCRITOR.exec(url);
  if (m) return { classe: 'descritor', nivel: null, uuid: m[1] };
  m = RE_IMAGEM.exec(url);
  // A imagem inteira foi aposentada em 2026-08-19. Ela continua classificada de
  // proposito: se ela reaparecer, o numero tem de gritar, e nao se diluir em
  // "outro".
  if (m) return { classe: 'imagem-cheia', nivel: null, uuid: m[1] };
  if (RE_VETORIAL.test(url)) return { classe: 'tile-vetorial', nivel: null, uuid: null };
  if (/\/floors(\?|$)/.test(url)) return { classe: 'planta', nivel: null, uuid: null };
  if (/\/tracks(\?|$)/.test(url)) return { classe: 'tracado', nivel: null, uuid: null };
  m = RE_META.exec(url);
  if (m) return { classe: 'foto-meta', nivel: null, uuid: m[1] };
  if (!url.startsWith(origem) && /^https?:/.test(url)) return { classe: 'externo', nivel: null, uuid: null };
  if (/\.(js|css|html)(\?|$)/.test(url)) return { classe: 'aplicacao', nivel: null, uuid: null };
  // `webp` PRECISA estar aqui. O tile de panoramica tambem e webp e ja foi
  // capturado por `RE_TILE` bem acima, entao nao ha ambiguidade; sem ele, o
  // logo e as miniaturas da aplicacao caiam em "outro" e a coluna de recurso
  // subestimava. O teste unitario pegou isto, e nenhuma medida pegaria: as duas
  // classes somam o mesmo total.
  if (/glyphs|sprite|\.(png|jpe?g|webp|gif|ico|svg|woff2?|ttf|otf)(\?|$)/.test(url)) return { classe: 'recurso', nivel: null, uuid: null };
  return { classe: 'outro', nivel: null, uuid: null };
}

/**
 * Liga a gravacao de rede numa sessao CDP.
 *
 * @param {import('./cdp.js').Cdp} cdp
 * @param {string} origem origem da pagina, para separar externo de interno
 * @returns {Promise<Object>} o gravador
 */
export async function gravarRede(cdp, origem) {
  const porId = new Map();
  let pedidos = [];

  cdp.ao('Network.requestWillBeSent', (p) => {
    porId.set(p.requestId, {
      url: p.request.url,
      // DOIS RELOGIOS, de proposito. `p.timestamp` e monotonico do CDP e presta
      // para medir duracao; `Date.now()` e o relogio de parede e presta para
      // dizer ha quanto tempo um pedido esta pendurado. Misturar os dois deu
      // "o mais velho ha 1.786.532.252.907 ms" numa mensagem de diagnostico.
      t0: p.timestamp * 1000,
      t0Parede: Date.now(),
      tipo: p.type,
      ...classificar(p.request.url, origem),
    });
  });

  cdp.ao('Network.responseReceived', (p) => {
    const r = porId.get(p.requestId);
    if (!r) return;
    r.status = p.response.status;
    r.doCache = !!p.response.fromDiskCache;
    r.protocolo = p.response.protocol;
    r.tipoMime = p.response.mimeType;
  });

  cdp.ao('Network.loadingFinished', (p) => {
    const r = porId.get(p.requestId);
    if (!r) return;
    r.t1 = p.timestamp * 1000;
    r.ms = r.t1 - r.t0;
    r.bytes = p.encodedDataLength;
    pedidos.push(r);
    porId.delete(p.requestId);
  });

  cdp.ao('Network.loadingFailed', (p) => {
    const r = porId.get(p.requestId);
    if (!r) return;
    r.t1 = p.timestamp * 1000;
    r.ms = r.t1 - r.t0;
    r.bytes = 0;
    r.falhou = p.errorText;
    r.cancelado = !!p.canceled;
    pedidos.push(r);
    porId.delete(p.requestId);
  });

  await cdp.enviar('Network.enable');

  return {
    /** Descarta o gravado e recomeca. Chamado no inicio de cada cenario. */
    zerar() { pedidos = []; porId.clear(); },

    /** @returns {Array} copia dos pedidos concluidos ate agora */
    ler() { return pedidos.slice(); },

    /**
     * Quantos pedidos ainda estao em voo, SEM contar `blob:` e `data:`.
     *
     * A exclusao nao e cosmetica. O MapLibre cria o worker dele de um blob
     * (`URL.createObjectURL`), e o CDP anuncia esse blob como um pedido que
     * NUNCA emite `loadingFinished`, porque o worker fica vivo enquanto o mapa
     * existir. Contando-o, "a cena assentou" jamais acontece: toda medida batia
     * no teto de 25 s com a foto pronta desde o primeiro segundo.
     */
    emVoo() {
      let n = 0;
      for (const r of porId.values()) if (!/^(blob|data):/.test(r.url)) n++;
      return n;
    },

    /**
     * Quem esta em voo, para explicar uma espera que nao termina.
     * @returns {Array<{classe: string, url: string, ms: number}>}
     */
    emVooDetalhe() {
      const agora = Date.now();
      return [...porId.values()]
        .filter(r => !/^(blob|data):/.test(r.url))
        .map(r => ({
          classe: r.classe,
          url: r.url.length > 110 ? `${r.url.slice(0, 110)}...` : r.url,
          ms: Math.round(agora - r.t0Parede),
        }));
    },

    /**
     * Espera um pedido que case com o predicado. Vale tanto o ja concluido
     * quanto o em voo: um descritor que chegou rapido demais nao pode escapar
     * entre duas verificacoes.
     * @param {Function} casa recebe o registro do pedido
     * @param {number} msLimite
     * @returns {Promise<boolean>}
     */
    async esperarPedido(casa, msLimite = 20000) {
      const fim = Date.now() + msLimite;
      while (Date.now() < fim) {
        if (pedidos.some(casa)) return true;
        for (const r of porId.values()) if (casa(r)) return true;
        await new Promise(ok => setTimeout(ok, 40));
      }
      return false;
    },

    /**
     * Resume o que foi gravado, por classe.
     *
     * `naoConcluidos` NAO e detalhe: um pedido que ficou em voo quando o cenario
     * acabou nao entra em nenhuma soma, e sem essa contagem o total pareceria
     * completo. Ele e comum e legitimo (o carregador aborta o lote quando a
     * camera anda), mas precisa aparecer.
     */
    resumir() {
      const porClasse = {};
      const niveis = {};
      let bytes = 0;
      let falhas = 0;
      let doCache = 0;
      let statusRuim = 0;

      for (const p of pedidos) {
        const c = porClasse[p.classe] || (porClasse[p.classe] = { n: 0, bytes: 0, ms: [], doCache: 0, falhas: 0, statusRuim: 0 });
        c.n++;
        c.bytes += p.bytes || 0;
        if (Number.isFinite(p.ms)) c.ms.push(p.ms);
        if (p.doCache) { c.doCache++; doCache++; }
        if (p.falhou) { c.falhas++; falhas++; }
        if (p.status && p.status >= 400) { c.statusRuim++; statusRuim++; }
        bytes += p.bytes || 0;
        if (p.classe === 'tile' && p.nivel !== null) niveis[p.nivel] = (niveis[p.nivel] || 0) + 1;
      }

      for (const c of Object.values(porClasse)) {
        c.msP50 = medianaDe(c.ms);
        c.msMax = c.ms.length ? Math.max(...c.ms) : null;
        delete c.ms;
      }

      const nivelMax = Object.keys(niveis).length ? Math.max(...Object.keys(niveis).map(Number)) : null;
      return {
        pedidos: pedidos.length,
        bytes,
        falhas,
        doCache,
        statusRuim,
        naoConcluidos: [...porId.values()].filter(r => !/^(blob|data):/.test(r.url)).length,
        porClasse,
        tilesPorNivel: niveis,
        nivelMax,
      };
    },
  };
}

function medianaDe(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
