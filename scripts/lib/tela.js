/**
 * @module scripts/lib/tela
 * @description Grava a TELA pelo CDP e mede, dos pixels, quando a panoramica
 * apareceu e quando ela parou de mudar.
 *
 * POR QUE OLHAR PIXEL. Todo o resto e proxy: byte de rede diz que o tile chegou,
 * chamada de WebGL diz que a textura subiu, e nenhum dos dois diz que a IMAGEM
 * ficou na tela. Os dois ja mentiram nesta obra. Em 2026-08-18 a escada nova
 * deixou o descritor pedir nivel que nao existia: a rede mostrava 404, a
 * aplicacao nao registrava erro nenhum, e a tela pintava um oitavo da
 * panoramica esticado sobre a esfera inteira. Um medidor que so somasse bytes
 * teria aprovado.
 *
 * COMO. `Page.startScreencast` entrega JPEG a cada composicao, com carimbo de
 * tempo. O `sharp`, que ja e dependencia do gerador de tiles, decodifica em
 * cinza pequeno. Dai saem duas curvas:
 *
 *   MUDANCA: diferenca media por pixel entre quadros vizinhos. Ela responde
 *   "quando algo apareceu" e "quando parou de mudar".
 *
 *   GRADIENTE: diferenca media entre pixels vizinhos DENTRO do quadro. E um
 *   proxy de nitidez: o fundo de nivel 0 tem 458 px de largura esticados sobre a
 *   tela inteira, e borrado ele tem gradiente baixo. Conforme os tiles finos
 *   pintam, o gradiente sobe e estabiliza. O tempo ate 90% do gradiente final e
 *   o "tempo ate ficar nitido" visto de fora.
 *
 * O QUE ELA CUSTA. Gravar a tela obriga o Chrome a codificar JPEG a cada
 * composicao, e isso ROUBA tempo da mesma thread que se esta medindo. Por isso o
 * medidor mede, uma vez por rodada, o mesmo cenario com e sem gravacao, e
 * publica a diferenca em vez de supor que ela e desprezivel.
 */

import sharp from 'sharp';

const LARGURA_ANALISE = 128;
const ALTURA_ANALISE = 72;

/**
 * Liga a gravacao de tela.
 *
 * @param {import('./cdp.js').Cdp} cdp
 * @param {Object} [opcoes]
 * @param {number} [opcoes.larguraMax] largura do quadro entregue pelo CDP
 * @param {number} [opcoes.qualidade] qualidade JPEG do quadro
 * @returns {Promise<Object>} o gravador
 */
export async function gravarTela(cdp, { larguraMax = 640, qualidade = 60 } = {}) {
  let quadros = [];
  let ligado = false;

  cdp.ao('Page.screencastFrame', (p) => {
    quadros.push({ ms: p.metadata.timestamp * 1000, b64: p.data });
    // Confirmar e obrigatorio: sem confirmacao o Chrome para de mandar quadro
    // depois do primeiro, e a medida sairia com uma amostra so, parecendo uma
    // tela que nunca mudou.
    cdp.enviar('Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => {});
  });

  return {
    async ligar() {
      if (ligado) return;
      await cdp.enviar('Page.startScreencast', {
        format: 'jpeg', quality: qualidade, maxWidth: larguraMax, everyNthFrame: 1,
      });
      ligado = true;
    },

    async desligar() {
      if (!ligado) return;
      await cdp.enviar('Page.stopScreencast').catch(() => {});
      ligado = false;
    },

    zerar() { quadros = []; },

    /** @returns {number} quantos quadros a tela produziu desde o `zerar` */
    contar() { return quadros.length; },

    /** @returns {number|null} carimbo do ultimo quadro, em ms de epoca */
    ultimoMs() { return quadros.length ? quadros[quadros.length - 1].ms : null; },

    /**
     * Decodifica e mede as duas curvas.
     *
     * @param {number} t0 instante de referencia, em ms de epoca
     * @param {Object} [limiares]
     * @param {number} [limiares.apareceu] diferenca media por pixel que conta
     *   como "algo mudou na tela" (0 a 255)
     * @param {number} [limiares.estavel] abaixo disto a tela conta como parada
     * @returns {Promise<Object>} as medidas
     */
    async analisar(t0, { apareceu = 6, estavel = 1.5 } = {}) {
      if (quadros.length < 2) {
        return { quadros: quadros.length, insuficiente: true };
      }

      const cinzas = [];
      for (const q of quadros) {
        const { data } = await sharp(Buffer.from(q.b64, 'base64'))
          .greyscale()
          .resize(LARGURA_ANALISE, ALTURA_ANALISE, { fit: 'fill' })
          .raw()
          .toBuffer({ resolveWithObject: true });
        cinzas.push({ ms: q.ms, px: data });
      }

      const serie = [];
      for (let i = 0; i < cinzas.length; i++) {
        const mudanca = i === 0 ? 0 : diferencaMedia(cinzas[i - 1].px, cinzas[i].px);
        serie.push({
          ms: cinzas[i].ms - t0,
          mudanca,
          gradiente: gradienteMedio(cinzas[i].px, LARGURA_ANALISE, ALTURA_ANALISE),
        });
      }

      const primeiraMudanca = serie.find(s => s.mudanca >= apareceu) || null;
      let ultimaMudanca = null;
      for (let i = serie.length - 1; i >= 1; i--) {
        if (serie[i].mudanca >= estavel) { ultimaMudanca = serie[i]; break; }
      }

      // A nitidez final e a mediana do ultimo quinto da serie, e nao o ultimo
      // quadro: um unico quadro pode cair no meio de uma repintura.
      const cauda = serie.slice(Math.max(1, Math.floor(serie.length * 0.8)));
      const gradienteFinal = mediana(cauda.map(s => s.gradiente));
      const alvo = gradienteFinal * 0.9;
      const chegouNitido = serie.find(s => s.gradiente >= alvo) || null;

      return {
        quadros: serie.length,
        msPrimeiraMudanca: primeiraMudanca ? Math.round(primeiraMudanca.ms) : null,
        msUltimaMudanca: ultimaMudanca ? Math.round(ultimaMudanca.ms) : null,
        msNitido: chegouNitido ? Math.round(chegouNitido.ms) : null,
        gradienteFinal: Number(gradienteFinal.toFixed(2)),
        gradienteInicial: Number(serie[0].gradiente.toFixed(2)),
        // O ganho de nitidez do primeiro quadro pintado ate o fim. Perto de 1
        // significa que a tela nunca ficou mais nitida do que ja era, e isso e
        // suspeito: ou a foto abriu ja pronta, ou os tiles finos nao chegaram.
        ganhoNitidez: Number((gradienteFinal / Math.max(serie[0].gradiente, 0.01)).toFixed(2)),
        serie,
      };
    },
  };
}

function diferencaMedia(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

/**
 * Media do modulo da diferenca entre pixels vizinhos na horizontal. Sobe com
 * detalhe e cai com borrao, e e insensivel a brilho, que e o que se quer: uma
 * foto escura nao pode parecer menos nitida por ser escura.
 */
function gradienteMedio(px, largura, altura) {
  let s = 0, n = 0;
  for (let y = 0; y < altura; y++) {
    const base = y * largura;
    for (let x = 1; x < largura; x++) {
      s += Math.abs(px[base + x] - px[base + x - 1]);
      n++;
    }
  }
  return n ? s / n : 0;
}

function mediana(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
