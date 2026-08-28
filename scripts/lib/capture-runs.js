/**
 * @module scripts/lib/capture-runs
 * @description Deriva a FAIXA DE COLETA de cada foto a partir do nome de origem.
 *
 * Uma faixa e uma SESSAO DE GRAVACAO: uma corrida continua do veiculo, do
 * momento em que o operador iniciou a captura ate parar. E a granularidade em
 * que a calibracao e constante, porque e a granularidade em que a montagem da
 * camera nao muda — medido no faxinal, desvio de mesh_rotation_y de 0,60 grau
 * dentro da faixa contra 8,40 entre as medias das faixas.
 *
 * A fronteira sai do identificador que o proprio equipamento gravou no nome, e
 * NAO de um corte por intervalo de tempo. As fotos sao disparadas por distancia
 * (passo mediano 13,5 m), entao um veiculo parado num semaforo gera um intervalo
 * temporal longo sem deslocamento nenhum: um corte por gap partiria a faixa no
 * sinal vermelho, e o limiar teria de ser diferente para transito urbano e para
 * area militar. O id de sessao nao tem esse problema — ele muda quando o
 * operador para e recomeca a gravacao, que e a fronteira que interessa.
 *
 * Os dois padroes abaixo cobrem o acervo inteiro: 90.433 fotos em 27 projetos,
 * zero nomes nao reconhecidos.
 */

/** `MULTICAPTURA_9468_005109` — 9468 e a sessao, 005109 o quadro. */
const RE_MULTICAPTURA = /^MULTICAPTURA_(\d+)_(\d+)$/;

/**
 * `PIC_20260427_090836_26_05_05_16_46_57_output_005`
 *
 * Sao DUAS datas, e a PRIMEIRA (`20260427_090836`) e o inicio da captura. A
 * segunda (`26_05_05_16_46_57`) e o processamento, isto e, a hora em que o lote
 * foi costurado.
 *
 * Isto ja esteve invertido aqui. O EXIF das imagens do faxinal decidiu, em
 * 5.672 fotos: `primeira data + quadro * 4 s` cai a 2 s da hora real, com 100%
 * dentro de 5 s; a segunda data erra de 8 a 9 DIAS. Uma faixa gravada como
 * 2026-05-05T14:47:14 foi capturada em 2026-04-26T13:37:35.
 *
 * As duas sao 1 para 1 (45 sessoes por qualquer uma das duas no faxinal), entao
 * o AGRUPAMENTO saia certo mesmo com a data errada. O que saia errado era o
 * `startedAt`, o rotulo e, no saica, a ordem das faixas.
 */
const RE_PIC = /^PIC_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})_\d{2}_\d{2}_\d{2}_\d{2}_\d{2}_\d{2}_output_(\d+)$/;

/**
 * `PIC_20260520_104137_20260521163900` — DISPARO UNICO, sem `_output_`.
 *
 * A primeira data e a hora do disparo; a segunda, com 14 digitos, e a costura
 * do lote. Cada nome desses tem uma pasta propria em `dados_brutos`, com as 6
 * imagens de lente daquele unico disparo.
 *
 * Este padrao chegou com o levantamento a pe do Beira-Rio, 266 fotos, e e o
 * primeiro que nao descreve corrida de veiculo nenhuma. Agrupar por ele da uma
 * faixa POR FOTO, que nao serve para nada. Por isso ele agrupa pela COSTURA, e
 * por isso existe o modo `byFloor` la embaixo, que e o que um levantamento
 * indoor realmente quer.
 */
const RE_PIC_SINGLE = /^PIC_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})_(\d{14})$/;

/**
 * Intervalo do timelapse, em segundos. PADRAO, e nao constante da natureza.
 *
 * Fonte primaria: o `pro.prj` que a propria camera grava traz
 * `interval="4000" type="timelapse"`, unanime nos 163 arquivos das tres missoes
 * Insta360 (51 no faxinal, 41 no saica, 71 no santiago).
 *
 * **A CADENCIA MUDA POR MISSAO, e tratar isto como constante erra em silencio.**
 * O lote de Cascavel (2026-08) traz `interval="2000"` nos 58 `pro.prj`, ou seja
 * METADE. Medida contra o `datetime` que a camera carimba em cada foto, a
 * cadencia real la fica entre 2,00 e 2,17 s por quadro nas 55 sessoes. Com o
 * padrao de 4 s a hora reconstruida corre ADIANTE do real, e o erro cresce com o
 * numero do quadro: mediana de 72 a 259 s por projeto, e 1.028 s no pior caso.
 *
 * Dezessete minutos movem o sol, entao isto envenena a calibracao solar sem
 * produzir erro nenhum. Quem reconstroi hora de um lote novo LE o `interval` do
 * `pro.prj` daquela missao e passa em `cadenciaS`, ou usa o carimbo por foto,
 * que nao precisa reconstruir nada.
 */
const INTERVALO_TIMELAPSE_S = 4;

/**
 * Extrai a sessao de gravacao e o numero do quadro de um nome de origem.
 *
 * @param {string} originalName - Nome do arquivo de origem
 * @returns {{sessionKey: string, startedAt: string|null, frame: number}|null}
 *   `null` quando o nome nao casa com nenhum padrao conhecido.
 */
export function parseCaptureRun(originalName) {
  if (typeof originalName !== 'string') return null;

  const multi = RE_MULTICAPTURA.exec(originalName);
  if (multi) {
    // Sem hora: o id do MULTICAPTURA e opaco (9468, 4809, 0913) e nao carrega
    // data. Quem preenche e `groupPhotosIntoRuns`, a partir do `capturedAt` que
    // o `import-captured-at` traz da fonte.
    return { sessionKey: `mc:${multi[1]}`, startedAt: null, frame: Number(multi[2]) };
  }

  const pic = RE_PIC.exec(originalName);
  if (pic) {
    const [, aaaa, mm, dd, hh, mi, ss] = pic;
    const startedAt = `${aaaa}-${mm}-${dd}T${hh}:${mi}:${ss}`;
    // O prefixo `ts:` evita colisao com `mc:` nos projetos que misturam os dois
    // padroes de nome (blumenau, santiago, tubarao).
    return { sessionKey: `ts:${startedAt}`, startedAt, frame: Number(pic[7]) };
  }

  const single = RE_PIC_SINGLE.exec(originalName);
  if (single) {
    const [, aaaa, mm, dd, hh, mi, ss, costura] = single;
    const shotAt = `${aaaa}-${mm}-${dd}T${hh}:${mi}:${ss}`;
    return {
      sessionKey: `ss:${costura}`,
      // Null como no MULTICAPTURA, de proposito: `startedAt` aqui e a hora
      // DESTA foto, nao do inicio da costura, e a faixa herda o menor
      // `capturedAt` das suas fotos. Devolver a hora do disparo faria o inicio
      // da faixa depender de qual foto o loop viu primeiro.
      startedAt: null,
      // O instante do disparo em segundos serve de numero de quadro: e
      // monotonico, entao a ordenacao dentro da faixa sai cronologica mesmo sem
      // `captured_at` no banco.
      frame: Math.floor(Date.parse(`${shotAt}Z`) / 1000),
      shotAt,
    };
  }

  return null;
}

/**
 * Hora de captura de uma foto, deduzida so do nome.
 *
 * Vale para o padrao PIC_, onde o nome traz o inicio da sessao e o numero do
 * quadro, e a camera dispara em cadencia fixa. Medido contra o EXIF de 5.672
 * fotos do faxinal: 100% dentro de 5 s, mediana de 2 s.
 *
 * O MULTICAPTURA nao tem hora no nome e devolve null: la o id da sessao e opaco.
 *
 * ESTA E RECONSTRUCAO, e nao medida. Ela so acerta se `cadenciaS` for a da
 * missao (ver `INTERVALO_TIMELAPSE_S`). Havendo carimbo por foto, use o carimbo.
 *
 * @param {string} originalName - Nome do arquivo de origem
 * @param {number} [cadenciaS] - Intervalo do timelapse da MISSAO, em segundos
 * @returns {string|null} `AAAA-MM-DDTHH:MM:SS` local, ou null
 */
export function captureTimeFromName(originalName, cadenciaS = INTERVALO_TIMELAPSE_S) {
  const parsed = parseCaptureRun(originalName);
  // Disparo unico: a hora do disparo E o proprio nome, sem cadencia a somar.
  if (parsed?.shotAt) return parsed.shotAt;
  if (!parsed?.startedAt) return null;
  const t = new Date(`${parsed.startedAt}Z`).getTime() + parsed.frame * cadenciaS * 1000;
  return new Date(t).toISOString().slice(0, 19);
}

/**
 * Rotulo curto e legivel de uma faixa, para a interface.
 *
 * @param {string} sessionKey - Chave namespaced da sessao
 * @returns {string} `16:46:57` para sessoes com hora, `9468` para MULTICAPTURA
 */
export function runLabel(sessionKey) {
  if (sessionKey.startsWith('ts:')) {
    // So a hora: a data e a mesma para o projeto todo na pratica, e o rotulo
    // precisa caber na lista lateral.
    return sessionKey.slice(3).split('T')[1] ?? sessionKey.slice(3);
  }
  if (sessionKey.startsWith('mc:')) return sessionKey.slice(3);
  if (sessionKey.startsWith('ss:')) {
    // `20260521163900` -> `21/05 16:39`. O ano fica de fora pelo mesmo motivo
    // que a data fica de fora no `ts:`: o rotulo precisa caber na lista.
    const c = sessionKey.slice(3);
    return `${c.slice(6, 8)}/${c.slice(4, 6)} ${c.slice(8, 10)}:${c.slice(10, 12)}`;
  }
  return sessionKey;
}

/**
 * Agrupa as fotos de UM projeto em faixas, ja ordenadas e posicionadas.
 *
 * A ordem das faixas (`ordinal`) e cronologica quando TODAS tem `startedAt`, e
 * por tamanho decrescente caso contrario. O criterio e por projeto, e nao por
 * faixa, porque uma lista meio cronologica meio por tamanho nao teria ordem
 * nenhuma.
 *
 * Faixa cujo NOME nao carrega hora (o id do MULTICAPTURA e opaco: 9468, 4809,
 * 0913) herda o `startedAt` da foto datada mais antiga da propria faixa. E o que
 * tira 12 projetos da ordem por tamanho: sem isso eles ficavam com uma lista
 * ordenada por numero de fotos, porque os ids NAO sao cronologicos e ordena-los
 * daria uma sequencia arbitraria com aparencia de significado. Basta UMA foto
 * datada por faixa, e nao a faixa inteira.
 *
 * A ordem DENTRO da faixa sai de `capturedAt` quando todas as fotos da faixa o
 * tem, e do numero do quadro caso contrario. Na pratica as duas coincidem: o
 * numero do quadro ja e um contador de tempo (`MULTICAPTURA_0913_000037` ->
 * 1742330126, `_000041` -> 1742330130, com os mesmos saltos). Medido em quatro
 * projetos com cobertura total de hora (46.266 fotos), reordenar por `capturedAt`
 * move de 0,00% a 0,01% das fotos e deixa a distribuicao de passo identica.
 * O `capturedAt` continua na ordenacao por ser a fonte mais direta, nao porque
 * conserte alguma coisa.
 *
 * As duas horas usam o mesmo formato local `AAAA-MM-DDTHH:MM:SS`, sem fuso: o
 * nome PIC_ traz hora local e o `import-captured-at` converte o epoch da fonte
 * para local antes de gravar. Fossem formatos diferentes, a comparacao de
 * string abaixo misturaria escalas.
 *
 * NUM LEVANTAMENTO INDOOR A FAIXA E O ANDAR (`options.byFloor`). Ali nao existe
 * corrida continua para agrupar: o operador anda e dispara foto a foto, cada
 * uma com pasta propria na fonte. Mas a razao de ser da faixa continua valendo,
 * e ate melhor — o andar E a granularidade em que a montagem da camera e o piso
 * nao mudam, entao e nele que a calibracao em lote faz sentido e que a
 * navegacao de revisao nao fica pulando de contexto.
 *
 * @param {Array<{id: string, originalName: string, capturedAt?: string|null,
 *                floorLevel?: number|null, floorLabel?: string|null}>} photos
 * @param {Object} [options] - Opcoes
 * @param {boolean} [options.byFloor=false] - Agrupar por andar, nao pelo nome
 * @returns {{runs: Array<Object>, unmatched: Array<string>}}
 *   `runs`: faixas com `sessionKey`, `label`, `startedAt`, `ordinal`,
 *   `photoCount` e `photos` (ids em ordem de captura).
 *   `unmatched`: ids das fotos cujo nome nao casou com padrao algum.
 */
export function groupPhotosIntoRuns(photos, options = {}) {
  const byFloor = options.byFloor === true;
  const porSessao = new Map();
  const unmatched = [];

  for (const foto of photos) {
    const parsed = parseCaptureRun(foto.originalName);

    // No modo por andar, o nome ainda e lido — so que para ORDENAR dentro da
    // faixa, nao para formar a faixa. Nome irreconhecivel nao descarta a foto
    // aqui: ela tem andar, entao tem faixa. Ela so perde o criterio fino de
    // ordem, e cai no desempate por id.
    const chave = byFloor ? `fl:${foto.floorLevel ?? 0}` : parsed?.sessionKey;
    if (chave == null) {
      unmatched.push(foto.id);
      continue;
    }

    let faixa = porSessao.get(chave);
    if (!faixa) {
      faixa = {
        sessionKey: chave,
        // O andar nao tem hora propria: herda o menor `capturedAt` das fotos.
        startedAt: byFloor ? null : parsed.startedAt,
        level: byFloor ? (foto.floorLevel ?? 0) : null,
        floorLabel: byFloor ? (foto.floorLabel ?? null) : null,
        itens: [],
      };
      porSessao.set(chave, faixa);
    }
    faixa.itens.push({
      id: foto.id,
      frame: parsed?.frame ?? 0,
      capturedAt: foto.capturedAt ?? null,
    });
  }

  const runs = [...porSessao.values()].map(faixa => {
    const temHoraEmTodas = faixa.itens.every(i => i.capturedAt);
    const ordenadas = [...faixa.itens].sort((a, b) => {
      if (temHoraEmTodas && a.capturedAt !== b.capturedAt) {
        return a.capturedAt < b.capturedAt ? -1 : 1;
      }
      // Desempate pelo id mantem a ordem estavel entre execucoes quando dois
      // quadros colidem — sem isso o run_position mudaria a cada derivacao.
      return a.frame - b.frame || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    });
    // O MENOR `capturedAt` da faixa, e nao o da primeira foto ordenada: assim o
    // inicio nao depende do criterio de ordenacao interna nem de a faixa ter
    // hora em todas as fotos.
    const herdado = faixa.itens.reduce(
      (menor, i) => (i.capturedAt && (!menor || i.capturedAt < menor) ? i.capturedAt : menor),
      null,
    );
    return {
      sessionKey: faixa.sessionKey,
      label: faixa.floorLabel ?? runLabel(faixa.sessionKey),
      startedAt: faixa.startedAt ?? herdado,
      level: faixa.level,
      photoCount: ordenadas.length,
      photos: ordenadas.map(i => i.id),
    };
  });

  if (byFloor) {
    // Do chao para cima, e nao por hora nem por tamanho. A revisao sobe o
    // predio andar a andar, e essa e a unica ordem que o operador consegue
    // prever. Ordenar 7 andares por numero de fotos daria uma lista com
    // aparencia de significado e nenhum.
    runs.sort((a, b) => a.level - b.level);
  } else {
    const todasComHora = runs.length > 0 && runs.every(r => r.startedAt);
    runs.sort((a, b) => {
      if (todasComHora) return a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0;
      // Tamanho decrescente, com a chave como desempate para ser deterministico
      // entre execucoes quando duas faixas tem o mesmo numero de fotos.
      return b.photoCount - a.photoCount
        || (a.sessionKey < b.sessionKey ? -1 : a.sessionKey > b.sessionKey ? 1 : 0);
    });
  }
  runs.forEach((r, i) => { r.ordinal = i + 1; });

  return { runs, unmatched };
}
