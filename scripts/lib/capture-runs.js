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
 * Sao DUAS datas. A primeira (`20260427_090836`) e o processamento; a segunda
 * (`26_05_05_16_46_57`, aa_mm_dd_hh_mm_ss) e o inicio da sessao. Verificado no
 * faxinal: as 50 sessoes tem uma unica data de processamento cada, e a segunda
 * data e constante dentro do grupo — 2026-05-05, das 14:47:14 as 19:24:13.
 */
const RE_PIC = /^PIC_\d{8}_\d{6}_(\d{2})_(\d{2})_(\d{2})_(\d{2})_(\d{2})_(\d{2})_output_(\d+)$/;

/**
 * O seculo assumido ao expandir o ano de dois digitos dos nomes PIC_.
 *
 * O acervo vai de 2025 a 2026. Um `26` e 2026, nao 1926; nao ha data anterior a
 * 2000 no material, entao a expansao e incondicional.
 */
const SECULO = '20';

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
    // data. Fica NULL ate o time_img da fonte ser importado.
    return { sessionKey: `mc:${multi[1]}`, startedAt: null, frame: Number(multi[2]) };
  }

  const pic = RE_PIC.exec(originalName);
  if (pic) {
    const [, aa, mm, dd, hh, mi, ss] = pic;
    const startedAt = `${SECULO}${aa}-${mm}-${dd}T${hh}:${mi}:${ss}`;
    // O prefixo `ts:` evita colisao com `mc:` nos projetos que misturam os dois
    // padroes de nome (blumenau, santiago, tubarao).
    return { sessionKey: `ts:${startedAt}`, startedAt, frame: Number(pic[7]) };
  }

  return null;
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
  return sessionKey;
}

/**
 * Agrupa as fotos de UM projeto em faixas, ja ordenadas e posicionadas.
 *
 * A ordem das faixas (`ordinal`) e cronologica quando TODAS tem `startedAt`, e
 * por tamanho decrescente caso contrario. O criterio e por projeto, e nao por
 * faixa, porque uma lista meio cronologica meio por tamanho nao teria ordem
 * nenhuma. Nos 14 projetos MULTICAPTURA nunca ha hora — e os ids (9468, 4809,
 * 0913) NAO sao cronologicos, entao ordena-los daria uma sequencia arbitraria
 * com aparencia de significado.
 *
 * A ordem DENTRO da faixa sai de `capturedAt` quando todas as fotos da faixa o
 * tem, e do numero do quadro caso contrario. O quadro acerta o corpo da
 * distribuicao (passo p50 14,3 m / p90 18,0 m em santana) mas erra na cauda
 * (p99 de 192 m no AMAN), que e o que o time_img vem consertar.
 *
 * @param {Array<{id: string, originalName: string, capturedAt?: string|null}>} photos
 * @returns {{runs: Array<Object>, unmatched: Array<string>}}
 *   `runs`: faixas com `sessionKey`, `label`, `startedAt`, `ordinal`,
 *   `photoCount` e `photos` (ids em ordem de captura).
 *   `unmatched`: ids das fotos cujo nome nao casou com padrao algum.
 */
export function groupPhotosIntoRuns(photos) {
  const porSessao = new Map();
  const unmatched = [];

  for (const foto of photos) {
    const parsed = parseCaptureRun(foto.originalName);
    if (!parsed) {
      unmatched.push(foto.id);
      continue;
    }
    let faixa = porSessao.get(parsed.sessionKey);
    if (!faixa) {
      faixa = { sessionKey: parsed.sessionKey, startedAt: parsed.startedAt, itens: [] };
      porSessao.set(parsed.sessionKey, faixa);
    }
    faixa.itens.push({ id: foto.id, frame: parsed.frame, capturedAt: foto.capturedAt ?? null });
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
    return {
      sessionKey: faixa.sessionKey,
      label: runLabel(faixa.sessionKey),
      startedAt: faixa.startedAt,
      photoCount: ordenadas.length,
      photos: ordenadas.map(i => i.id),
    };
  });

  const todasComHora = runs.length > 0 && runs.every(r => r.startedAt);
  runs.sort((a, b) => {
    if (todasComHora) return a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0;
    // Tamanho decrescente, com a chave como desempate para ser deterministico
    // entre execucoes quando duas faixas tem o mesmo numero de fotos.
    return b.photoCount - a.photoCount
      || (a.sessionKey < b.sessionKey ? -1 : a.sessionKey > b.sessionKey ? 1 : 0);
  });
  runs.forEach((r, i) => { r.ordinal = i + 1; });

  return { runs, unmatched };
}
