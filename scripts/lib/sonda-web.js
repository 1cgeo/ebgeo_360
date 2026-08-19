/**
 * @module scripts/lib/sonda-web
 * @description A sonda que o medidor injeta na pagina ANTES de qualquer codigo
 * da aplicacao (`Page.addScriptToEvaluateOnNewDocument`).
 *
 * O QUE ELA MEDE, E POR QUE DE FORA. Tudo aqui e instrumentacao do NAVEGADOR, e
 * nao da aplicacao: nenhum arquivo do `ebgeo_web` sabe que ela existe, e nenhum
 * numero sai de uma variavel que a propria aplicacao mantem. A razao e a de
 * sempre: numero que o sistema publica sobre si mesmo e eco, e eco nao serve de
 * prova. Se o contador do carregador de tiles estiver errado, a sonda ainda
 * conta certo, porque ela conta chamada de WebGL e evento de rede.
 *
 * AS QUATRO FAMILIAS DE MEDIDA:
 *
 * 1. TEXTURA. `texImage2D`, `texSubImage2D` e `texStorage2D` embrulhados POR
 *    CONTEXTO, e nao no prototipo. A pagina tem mais de um contexto WebGL (a
 *    panoramica e o minimapa MapLibre), e somar os dois num numero so esconderia
 *    de quem e o custo. Cada chamada e cronometrada: o tempo DENTRO da chamada e
 *    a thread principal parada no driver, copiando e invertendo o canvas. Foi
 *    esse numero, e nao a taxa de quadros, que explicou a travada do giro.
 *
 * 2. QUADROS. `clear` conta quadro desenhado, porque o three.js limpa uma vez
 *    por render. NAO ha laco de `requestAnimationFrame` proprio aqui, e a
 *    ausencia e deliberada: o visualizador so desenha quando esta sujo, entao um
 *    laco da sonda o obrigaria a desenhar sempre e destruiria justamente a
 *    propriedade que se quer medir.
 *
 * 3. TRAVADA. `long-animation-frame` (LoAF) e `longtask`, que o proprio Chrome
 *    publica. LoAF so relata quadro acima de 50 ms, que e exatamente a travada
 *    que se sente. `blockingDuration` separa o que travou o dedo do que so
 *    demorou a desenhar.
 *
 * 4. RESPOSTA AO DEDO. `PerformanceObserver` de `event`: `processingStart` menos
 *    `startTime` e a espera do evento na fila, e o resto e o trabalho dele.
 *
 * A sonda NAO conta bytes de rede. Isso vem do CDP, que ve o que a pilha de rede
 * entregou, incluindo cabecalho e o que veio do cache de disco. Um `fetch`
 * embrulhado veria o corpo e mentiria sobre o resto.
 */

/**
 * O texto-fonte da sonda. Vai como esta para dentro da pagina.
 *
 * `String.raw` para a barra invertida das expressoes regulares sobreviver, e sem
 * crase nem `${` no corpo, porque o proprio literal usa crase.
 */
export const SONDA_WEB = String.raw`
(function () {
  if (window.__sonda) return;

  var BPP = {};
  BPP[0x1908] = 4; // RGBA
  BPP[0x1907] = 3; // RGB
  BPP[0x1909] = 1; // LUMINANCE
  BPP[0x1906] = 1; // ALPHA
  BPP[0x190A] = 2; // LUMINANCE_ALPHA
  BPP[0x8227] = 2; // RG
  BPP[0x1903] = 1; // RED

  function bytesPorPixel(formato, tipo) {
    var canais = BPP[formato] !== undefined ? BPP[formato] : 4;
    // UNSIGNED_BYTE e o caso do canvas e do ImageBitmap, que e tudo que o 360
    // sobe. Os demais tipos entram por seguranca, para nao subestimar.
    if (tipo === 0x1406) return canais * 4;       // FLOAT
    if (tipo === 0x8D61) return canais * 2;       // HALF_FLOAT_OES
    if (tipo === 0x1403) return canais * 2;       // UNSIGNED_SHORT
    if (tipo === 0x8033 || tipo === 0x8034 || tipo === 0x8363) return 2; // 4444/5551/565
    return canais;
  }

  function tamanhoDaFonte(fonte) {
    if (!fonte) return { w: 0, h: 0 };
    var w = fonte.width || fonte.videoWidth || fonte.displayWidth || 0;
    var h = fonte.height || fonte.videoHeight || fonte.displayHeight || 0;
    return { w: w, h: h };
  }

  function zeroChamada() {
    return { n: 0, bytes: 0, ms: 0, msMax: 0, maiorBytes: 0 };
  }

  function zeroContexto(nome) {
    return {
      nome: nome,
      texImage2D: zeroChamada(),
      texSubImage2D: zeroChamada(),
      texStorage2D: zeroChamada(),
      compressedTexImage2D: zeroChamada(),
      generateMipmap: { n: 0, ms: 0, msMax: 0 },
      // A PILHA DE QUEM ALOCOU. Alocar textura e raro (uma por canvas novo),
      // entao guardar a pilha das primeiras custa nada e responde a pergunta
      // que nenhuma contagem responde: QUEM pediu esta textura. Sem ela, duas
      // alocacoes do mesmo tamanho no mesmo salto viram deducao, e deducao
      // sobre codigo empacotado erra.
      pilhas: [],
      // A SEQUENCIA DE TAMANHOS DA TEXTURA, e nao so o total de bytes. E ela
      // que responde "o canvas foi refeito quantas vezes, e de que tamanho para
      // que tamanho". Sem isso, 369 MB num zoom podem ser uma textura enorme ou
      // seis medianas, e as duas pedem conserto diferente.
      tamanhos: [],
      readPixels: { n: 0, ms: 0, msMax: 0 },
      quadros: 0,
      draws: 0
    };
  }

  var contextos = [];   // { ctx, contas }
  // Decodificar e compor sao dois trabalhos diferentes, e num PC fraco o tempo
  // total nao diz qual dos dois manda. O createImageBitmap decodifica o WebP
  // (fora da thread principal, mas gastando CPU da maquina), e o drawImage
  // compoe o tile no canvas (na thread principal). Sem separar, a unica saida
  // seria adivinhar onde mexer.
  var decodifica = { n: 0, ms: 0, msMax: 0, emVoo: 0 };
  var compoe = { n: 0, ms: 0, msMax: 0, pixels: 0 };
  var loaf = [];
  var longtask = [];
  var eventos = [];
  var marcas = [];
  var inicio = performance.now();

  // ---------------------------------------------------------------- textura

  function anotarTamanho(contas, chave, w, h) {
    if (!w || !h) return;
    var ultimo = contas.tamanhos[contas.tamanhos.length - 1];
    if (ultimo && ultimo.w === w && ultimo.h === h && ultimo.chamada === chave) { ultimo.n++; return; }
    if (contas.tamanhos.length >= 60) return;
    contas.tamanhos.push({ chamada: chave, w: w, h: h, n: 1, t: Math.round(performance.now() - inicio) });
  }

  function cronometrar(contas, chave, original, ctx, args, bytes) {
    var t = performance.now();
    var r = original.apply(ctx, args);
    var d = performance.now() - t;
    var c = contas[chave];
    c.n++;
    c.ms += d;
    if (d > c.msMax) c.msMax = d;
    if (bytes) {
      c.bytes += bytes;
      if (bytes > c.maiorBytes) c.maiorBytes = bytes;
    }
    return r;
  }

  function embrulharContexto(ctx) {
    if (!ctx || ctx.__sondaEmbrulhado) return;
    ctx.__sondaEmbrulhado = true;
    var contas = zeroContexto('?');
    contextos.push({ ctx: ctx, contas: contas });

    var oTexImage = ctx.texImage2D;
    ctx.texImage2D = function () {
      var bytes = 0;
      if (arguments.length >= 9) {
        bytes = (arguments[3] | 0) * (arguments[4] | 0) * bytesPorPixel(arguments[6], arguments[7]);
        anotarTamanho(contas, 'texImage2D', arguments[3] | 0, arguments[4] | 0);
      } else if (arguments.length >= 6) {
        var t = tamanhoDaFonte(arguments[5]);
        bytes = t.w * t.h * bytesPorPixel(arguments[3], arguments[4]);
        anotarTamanho(contas, 'texImage2D', t.w, t.h);
      }
      return cronometrar(contas, 'texImage2D', oTexImage, this, arguments, bytes);
    };

    var oTexSub = ctx.texSubImage2D;
    ctx.texSubImage2D = function () {
      var bytes = 0;
      if (arguments.length >= 9) {
        bytes = (arguments[4] | 0) * (arguments[5] | 0) * bytesPorPixel(arguments[6], arguments[7]);
        anotarTamanho(contas, 'texSubImage2D', arguments[4] | 0, arguments[5] | 0);
      } else if (arguments.length >= 7) {
        var t = tamanhoDaFonte(arguments[6]);
        bytes = t.w * t.h * bytesPorPixel(arguments[4], arguments[5]);
        anotarTamanho(contas, 'texSubImage2D', t.w, t.h);
      }
      return cronometrar(contas, 'texSubImage2D', oTexSub, this, arguments, bytes);
    };

    // O three.js aloca textura imutavel em WebGL2 (texStorage2D) e so depois
    // sobe pixel com texSubImage2D. Sem contar a alocacao, uma troca de nivel
    // da piramide pareceria de graca ate o primeiro tile chegar.
    if (ctx.texStorage2D) {
      var oTexStorage = ctx.texStorage2D;
      ctx.texStorage2D = function () {
        var niveis = arguments[1] | 0;
        var bytes = (arguments[3] | 0) * (arguments[4] | 0) * 4;
        // Mipmap completo custa 1/3 a mais que o nivel base.
        if (niveis > 1) bytes = Math.round(bytes * 1.34);
        anotarTamanho(contas, 'texStorage2D', arguments[3] | 0, arguments[4] | 0);
        if (contas.pilhas.length < 8) {
          // fromCharCode(10) em vez da sequencia de escape: este arquivo passa
          // por heredoc e por script de edicao, e a barra-n ja virou quebra de
          // linha de verdade uma vez, truncando a sonda inteira.
          var linhas = (new Error().stack || '').split(String.fromCharCode(10)).slice(1, 7);
          contas.pilhas.push({
            t: Math.round(performance.now() - inicio),
            wh: (arguments[3] | 0) + 'x' + (arguments[4] | 0),
            pilha: linhas.map(function (l) { return l.trim(); })
          });
        }
        return cronometrar(contas, 'texStorage2D', oTexStorage, this, arguments, bytes);
      };
    }

    if (ctx.compressedTexImage2D) {
      var oComp = ctx.compressedTexImage2D;
      ctx.compressedTexImage2D = function () {
        var d = arguments[6];
        var bytes = d && d.byteLength ? d.byteLength : 0;
        return cronometrar(contas, 'compressedTexImage2D', oComp, this, arguments, bytes);
      };
    }

    var oMip = ctx.generateMipmap;
    ctx.generateMipmap = function () {
      var t = performance.now();
      var r = oMip.apply(this, arguments);
      var d = performance.now() - t;
      contas.generateMipmap.n++;
      contas.generateMipmap.ms += d;
      if (d > contas.generateMipmap.msMax) contas.generateMipmap.msMax = d;
      return r;
    };

    // readPixels e sincrono e esvazia a fila da GPU. Um por quadro basta para
    // derrubar a taxa, e o apanhador de clique do 360 e um candidato natural.
    var oRead = ctx.readPixels;
    ctx.readPixels = function () {
      var t = performance.now();
      var r = oRead.apply(this, arguments);
      var d = performance.now() - t;
      contas.readPixels.n++;
      contas.readPixels.ms += d;
      if (d > contas.readPixels.msMax) contas.readPixels.msMax = d;
      return r;
    };

    var oClear = ctx.clear;
    ctx.clear = function () { contas.quadros++; return oClear.apply(this, arguments); };

    var oDrawE = ctx.drawElements;
    ctx.drawElements = function () { contas.draws++; return oDrawE.apply(this, arguments); };
    var oDrawA = ctx.drawArrays;
    ctx.drawArrays = function () { contas.draws++; return oDrawA.apply(this, arguments); };
  }

  if (typeof createImageBitmap === 'function') {
    var oCriar = createImageBitmap;
    window.createImageBitmap = function () {
      var t = performance.now();
      decodifica.emVoo++;
      return oCriar.apply(this, arguments).then(function (r) {
        var d = performance.now() - t;
        decodifica.n++;
        decodifica.ms += d;
        decodifica.emVoo--;
        if (d > decodifica.msMax) decodifica.msMax = d;
        return r;
      }, function (e) { decodifica.emVoo--; throw e; });
    };
  }

  if (typeof CanvasRenderingContext2D !== 'undefined') {
    var oDraw = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function () {
      var t = performance.now();
      var r = oDraw.apply(this, arguments);
      var d = performance.now() - t;
      compoe.n++;
      compoe.ms += d;
      if (d > compoe.msMax) compoe.msMax = d;
      // Area de DESTINO, que e a que custa preenchimento. Com 8 argumentos ela
      // vem explicita; com menos, e o tamanho da fonte.
      if (arguments.length >= 8) compoe.pixels += (arguments[6] || 0) * (arguments[7] || 0);
      else if (arguments.length >= 5) compoe.pixels += (arguments[3] || 0) * (arguments[4] || 0);
      return r;
    };
  }

  var oGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (tipo) {
    var ctx = oGetContext.apply(this, arguments);
    if (ctx && (tipo === 'webgl' || tipo === 'webgl2' || tipo === 'experimental-webgl')) {
      try { embrulharContexto(ctx); } catch (e) { /* nao pode derrubar a pagina */ }
    }
    return ctx;
  };
  if (typeof OffscreenCanvas !== 'undefined' && OffscreenCanvas.prototype.getContext) {
    var oGetContextOff = OffscreenCanvas.prototype.getContext;
    OffscreenCanvas.prototype.getContext = function (tipo) {
      var ctx = oGetContextOff.apply(this, arguments);
      if (ctx && (tipo === 'webgl' || tipo === 'webgl2')) {
        try { embrulharContexto(ctx); } catch (e) { /* idem */ }
      }
      return ctx;
    };
  }

  // ---------------------------------------------------------------- travada

  function observar(tipo, alvo, extras) {
    try {
      var po = new PerformanceObserver(function (lista) {
        var es = lista.getEntries();
        for (var i = 0; i < es.length; i++) {
          var e = es[i];
          var reg = { t: e.startTime, dur: e.duration };
          if (extras) extras(e, reg);
          alvo.push(reg);
          if (alvo.length > 5000) alvo.shift();
        }
      });
      po.observe({ type: tipo, buffered: true });
      return po;
    } catch (e) { return null; }
  }

  var temLoaf = !!observar('long-animation-frame', loaf, function (e, reg) {
    reg.bloqueio = e.blockingDuration || 0;
    reg.render = e.renderStart ? (e.startTime + e.duration - e.renderStart) : 0;
    // QUEM gastou o quadro, e nao so quanto. O LoAF atribui o tempo a scripts,
    // com o tipo de invocacao e a posicao no arquivo. Em pacote empacotado o
    // nome da funcao vem embaralhado, mas o TIPO de invocacao nao: ele separa
    // um laco de animacao de um ouvinte de ponteiro de um temporizador, que e
    // exatamente a divisao que decide onde mexer.
    reg.scripts = [];
    var lista = e.scripts || [];
    for (var s = 0; s < lista.length && s < 4; s++) {
      reg.scripts.push({
        tipo: lista[s].invokerType || '?',
        quem: String(lista[s].invoker || '').slice(0, 60),
        fonte: String(lista[s].sourceURL || '').split('/').pop().slice(0, 40),
        funcao: String(lista[s].sourceFunctionName || '').slice(0, 40),
        ms: Math.round(lista[s].duration || 0),
        estiloMs: Math.round(lista[s].forcedStyleAndLayoutDuration || 0)
      });
    }
  });
  observar('longtask', longtask);
  observar('event', eventos, function (e, reg) {
    reg.nome = e.name;
    reg.fila = (e.processingStart || e.startTime) - e.startTime;
    reg.trabalho = (e.processingEnd || e.startTime) - (e.processingStart || e.startTime);
  });

  // ---------------------------------------------------------------- leitura

  function nomeDoContexto(ctx) {
    try {
      var c = ctx.canvas;
      if (!c) return 'sem-canvas';
      if (c.closest && c.closest('#street-view-container')) {
        return c === telaDaPanoramica() ? 'panorama' : 'panorama-sobreposicao';
      }
      if (c.closest && c.closest('.maplibregl-map')) return 'mapa';
      if (c.id) return 'canvas#' + c.id;
      if (c.className) return 'canvas.' + String(c.className).split(' ')[0];
      return 'solto';
    } catch (e) { return 'erro'; }
  }

  function somar(destino, origem) {
    destino.n += origem.n;
    destino.bytes += origem.bytes || 0;
    destino.ms += origem.ms;
    if (origem.msMax > destino.msMax) destino.msMax = origem.msMax;
    if ((origem.maiorBytes || 0) > destino.maiorBytes) destino.maiorBytes = origem.maiorBytes;
  }

  function recorte(lista, desde) {
    var fora = [];
    for (var i = 0; i < lista.length; i++) if (lista[i].t >= desde) fora.push(lista[i]);
    return fora;
  }

  /**
   * A tela da panoramica e a MAIOR do container, e nao a primeira.
   *
   * O container do 360 guarda mais de um canvas: o do three.js e o da
   * sobreposicao de navegacao, que nasce com zero de tamanho ate a primeira
   * pintura. Perguntar por querySelector pega a primeira da arvore, e a
   * primeira veio 0x0 numa medida inteira: o medidor esperou 60 s por uma tela
   * que ja estava na frente do operador desde o segundo 1.
   */
  function telaDaPanoramica() {
    var todas = document.querySelectorAll('#street-view-container canvas');
    var melhor = null, maior = -1;
    for (var i = 0; i < todas.length; i++) {
      var a = todas[i].clientWidth * todas[i].clientHeight;
      if (a > maior) { maior = a; melhor = todas[i]; }
    }
    return melhor;
  }

  window.__sonda = {
    /** Zera o relogio e as contas. Chamado no comeco de cada cenario. */
    zerar: function () {
      inicio = performance.now();
      marcas = [];
      decodifica = { n: 0, ms: 0, msMax: 0, emVoo: decodifica.emVoo };
      compoe = { n: 0, ms: 0, msMax: 0, pixels: 0 };
      // ZERA POR DENTRO, e nunca troca o objeto. Os embrulhos de WebGL guardam
      // a referencia da conta na closure: trocar o objeto os deixa escrevendo
      // num orfao, e a partir do primeiro zerar TODA medida de textura e de
      // quadro sai zero. Aconteceu, e o sintoma foi cruel de ler, porque zero
      // e um numero plausivel: a abertura media 301 MB de GPU e todos os
      // cenarios seguintes mediam 0 MB, o que parecia um visualizador
      // eficientissimo em vez de um contador quebrado.
      for (var i = 0; i < contextos.length; i++) {
        var c = contextos[i].contas;
        var limpo = zeroContexto(c.nome);
        for (var k in limpo) if (Object.prototype.hasOwnProperty.call(limpo, k)) c[k] = limpo[k];
      }
      return inicio;
    },

    /**
     * Um numero que muda quando a panoramica trabalha: quadro desenhado mais
     * textura subida. Serve de batimento barato para quem espera a cena parar,
     * sem trazer o objeto inteiro de estatistica a cada 80 ms.
     * @returns {number}
     */
    pulso: function () {
      var q = 0, u = 0;
      for (var i = 0; i < contextos.length; i++) {
        var nome = nomeDoContexto(contextos[i].ctx);
        if (nome !== 'panorama') continue;
        q += contextos[i].contas.quadros;
        u += contextos[i].contas.texImage2D.n + contextos[i].contas.texSubImage2D.n;
      }
      return q * 1000000 + u;
    },

    marcar: function (nome) {
      marcas.push({ nome: nome, t: performance.now() - inicio });
      return marcas.length;
    },

    /** @returns {boolean} o 360 esta aberto e com canvas de tamanho util */
    pronto: function () {
      if (!document.body.classList.contains('streetview-active')) return false;
      var c = telaDaPanoramica();
      return !!c && c.clientWidth > 0 && c.clientHeight > 0;
    },

    /** @returns {Object|null} retangulo do canvas da panoramica, em CSS px */
    retangulo: function () {
      var c = telaDaPanoramica();
      if (!c) return null;
      var r = c.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
    },

    ler: function () {
      var agora = performance.now();
      var porContexto = {};
      var total = {
        texImage2D: zeroChamada(),
        texSubImage2D: zeroChamada(),
        texStorage2D: zeroChamada(),
        compressedTexImage2D: zeroChamada()
      };
      for (var i = 0; i < contextos.length; i++) {
        var c = contextos[i];
        c.contas.nome = nomeDoContexto(c.ctx);
        var chave = c.contas.nome + (porContexto[c.contas.nome] ? '#' + i : '');
        porContexto[chave] = JSON.parse(JSON.stringify(c.contas));
        somar(total.texImage2D, c.contas.texImage2D);
        somar(total.texSubImage2D, c.contas.texSubImage2D);
        somar(total.texStorage2D, c.contas.texStorage2D);
        somar(total.compressedTexImage2D, c.contas.compressedTexImage2D);
      }

      var lo = recorte(loaf, inicio);
      var lt = recorte(longtask, inicio);
      var ev = recorte(eventos, inicio);

      var bloqueioTotal = 0, piorQuadro = 0, quadrosLentos = 0, quadrosMuitoLentos = 0;
      for (var j = 0; j < lo.length; j++) {
        bloqueioTotal += lo[j].bloqueio || 0;
        if (lo[j].dur > piorQuadro) piorQuadro = lo[j].dur;
        if (lo[j].dur >= 50) quadrosLentos++;
        if (lo[j].dur >= 100) quadrosMuitoLentos++;
      }
      var tarefaTotal = 0, piorTarefa = 0;
      for (var k = 0; k < lt.length; k++) {
        tarefaTotal += lt[k].dur;
        if (lt[k].dur > piorTarefa) piorTarefa = lt[k].dur;
      }
      var piorEvento = 0, piorFila = 0;
      for (var m = 0; m < ev.length; m++) {
        if (ev[m].dur > piorEvento) piorEvento = ev[m].dur;
        if (ev[m].fila > piorFila) piorFila = ev[m].fila;
      }

      var mem = null;
      if (performance.memory) {
        mem = {
          heapUsadoMB: performance.memory.usedJSHeapSize / 1048576,
          heapTotalMB: performance.memory.totalJSHeapSize / 1048576
        };
      }

      return {
        msDecorrido: agora - inicio,
        temLoaf: temLoaf,
        marcas: marcas,
        contextos: porContexto,
        textura: total,
        decodifica: {
          n: decodifica.n,
          ms: Math.round(decodifica.ms),
          msMax: Math.round(decodifica.msMax),
          emVoo: decodifica.emVoo
        },
        compoe: {
          n: compoe.n,
          ms: Math.round(compoe.ms),
          msMax: Math.round(compoe.msMax),
          megapixels: Math.round(compoe.pixels / 1048576)
        },
        travada: {
          quadrosLoaf: lo.length,
          quadrosLentos: quadrosLentos,
          quadrosMuitoLentos: quadrosMuitoLentos,
          piorQuadroMs: piorQuadro,
          bloqueioTotalMs: bloqueioTotal,
          tarefasLongas: lt.length,
          tarefaTotalMs: tarefaTotal,
          piorTarefaMs: piorTarefa,
          piorEventoMs: piorEvento,
          piorFilaMs: piorFila,
          eventos: ev.length,
          // Os tres piores quadros do periodo, com quem os gastou. E o unico
          // canal que responde "onde mexer" quando o total ja disse "doi".
          piores: lo.slice().sort(function (a, b) { return b.dur - a.dur; }).slice(0, 3)
            .map(function (q) {
              return { ms: Math.round(q.dur), bloqueio: Math.round(q.bloqueio || 0),
                render: Math.round(q.render || 0), scripts: q.scripts || [] };
            })
        },
        memoria: mem
      };
    }
  };
})();
`;

// A SONDA E COMPILADA AQUI, na importacao do modulo, e nao la na pagina.
//
// A primeira versao desta guarda conferia MARCADOR: procurava a abertura de
// `window.__sonda` e o fecho da funcao. Ela passou com a sonda quebrada, porque
// um `.split()` teve a barra-n virada em quebra de linha de verdade por um
// script de edicao, e os dois marcadores continuavam la. A pagina recebeu um
// programa que nao compila, `window.__sonda` nunca existiu, e o medidor morreu
// em "Cannot read properties of undefined" quatro camadas adiante.
//
// Verificacao que nao pode reprovar nao e verificacao. `new Function` compila o
// texto de verdade, custa menos de um milissegundo, roda uma vez por processo, e
// reprova exatamente o que precisa reprovar. As duas maneiras conhecidas de
// quebrar este literal sao a crase num comentario e a sequencia de escape
// mastigada por heredoc; ambas caem aqui.
try {
  new Function(SONDA_WEB); // eslint-disable-line no-new-func
} catch (err) {
  throw new Error(
    `A sonda nao compila: ${err.message}. As duas causas conhecidas sao crase `
    + 'dentro do literal e barra-n virada em quebra de linha por script de edicao. '
    + 'Use String.fromCharCode(10) em vez da sequencia de escape.',
  );
}
