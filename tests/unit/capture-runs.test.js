/**
 * @module tests/unit/capture-runs.test
 * @description Unit tests for scripts/lib/capture-runs.js — parsing de nome e
 * agrupamento em faixas, sem banco.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCaptureRun,
  runLabel,
  groupPhotosIntoRuns,
  captureTimeFromName,
} from '../../scripts/lib/capture-runs.js';

describe('parseCaptureRun', () => {
  it('le a sessao e o quadro de um nome MULTICAPTURA', () => {
    const r = parseCaptureRun('MULTICAPTURA_9468_005109');
    assert.deepEqual(r, { sessionKey: 'mc:9468', startedAt: null, frame: 5109 });
  });

  // As duas datas do nome PIC_ sao diferentes: a PRIMEIRA e o inicio da captura,
  // a segunda e a costura. Isto ja esteve invertido; o EXIF de 5.672 fotos do
  // faxinal decidiu, e a segunda data erra de 8 a 9 dias.
  it('usa a PRIMEIRA data do nome PIC_, que e o inicio da captura', () => {
    const r = parseCaptureRun('PIC_20260427_090836_26_05_05_16_46_57_output_005');
    assert.equal(r.sessionKey, 'ts:2026-04-27T09:08:36');
    assert.equal(r.startedAt, '2026-04-27T09:08:36');
    assert.equal(r.frame, 5);
  });

  it('le a segunda data sem confundir com a primeira', () => {
    assert.equal(parseCaptureRun('PIC_20251205_114053_25_12_08_08_47_46_output_1').startedAt,
      '2025-12-05T11:40:53');
  });

  it('devolve null em vez de adivinhar quando o nome nao casa', () => {
    assert.equal(parseCaptureRun('FOTO_QUALQUER_123'), null);
    assert.equal(parseCaptureRun(''), null);
    assert.equal(parseCaptureRun(null), null);
    assert.equal(parseCaptureRun(undefined), null);
  });

  // Os prefixos existem porque blumenau, santiago e tubarao misturam os dois
  // padroes: sem eles, uma sessao '9468' poderia colidir com outra coisa.
  it('separa os espacos de nome das duas origens', () => {
    assert.ok(parseCaptureRun('MULTICAPTURA_9468_1').sessionKey.startsWith('mc:'));
    assert.ok(parseCaptureRun('PIC_20260427_090836_26_05_05_16_46_57_output_1').sessionKey.startsWith('ts:'));
  });
});

describe('captureTimeFromName', () => {
  // 4 s por quadro, do `interval="4000"` que a camera grava no pro.prj.
  it('soma o quadro ao inicio da sessao', () => {
    assert.equal(captureTimeFromName('PIC_20260427_100639_26_05_05_16_46_57_output_340'),
      '2026-04-27T10:29:19');
    assert.equal(captureTimeFromName('PIC_20260427_100639_26_05_05_16_46_57_output_000'),
      '2026-04-27T10:06:39');
  });

  it('atravessa a virada de hora e de dia', () => {
    assert.equal(captureTimeFromName('PIC_20260427_235900_26_05_05_16_46_57_output_030'),
      '2026-04-28T00:01:00');
  });

  // O id do MULTICAPTURA e opaco: sem hora no nome, nao se inventa uma.
  it('devolve null quando o nome nao carrega hora', () => {
    assert.equal(captureTimeFromName('MULTICAPTURA_9468_005109'), null);
    assert.equal(captureTimeFromName('SEM_PADRAO.jpg'), null);
  });

  // A CADENCIA MUDA POR MISSAO. O faxinal, o saica e o santiago gravam
  // `interval="4000"`; o lote de Cascavel grava `interval="2000"` nos 58
  // pro.prj. Com o padrao errado a hora corre adiante, e o erro cresce com o
  // quadro: 1.028 s no pior caso medido, que move o sol e envenena a
  // calibracao sem produzir erro nenhum.
  it('aceita a cadencia da missao, em vez de assumir a do faxinal', () => {
    const nome = 'PIC_20260427_100639_26_05_05_16_46_57_output_340';
    assert.equal(captureTimeFromName(nome, 2), '2026-04-27T10:17:59');
    assert.equal(captureTimeFromName(nome, 4), '2026-04-27T10:29:19');
  });

  it('mantem 4 s como padrao, para o acervo ja importado nao mudar', () => {
    const nome = 'PIC_20260427_100639_26_05_05_16_46_57_output_340';
    assert.equal(captureTimeFromName(nome), captureTimeFromName(nome, 4));
  });

  // Disparo unico nao tem quadro a somar, entao a cadencia nao o alcanca.
  it('a cadencia nao move o disparo unico, que ja traz a hora no nome', () => {
    const nome = 'PIC_20260520_104137_20260521163900';
    assert.equal(captureTimeFromName(nome, 2), captureTimeFromName(nome, 4));
    assert.equal(captureTimeFromName(nome, 2), '2026-05-20T10:41:37');
  });
});

describe('runLabel', () => {
  it('mostra so a hora nas sessoes com data', () => {
    assert.equal(runLabel('ts:2026-05-05T16:46:57'), '16:46:57');
  });

  it('mostra o id cru nas sessoes MULTICAPTURA', () => {
    assert.equal(runLabel('mc:9468'), '9468');
  });
});

describe('groupPhotosIntoRuns', () => {
  // A hora que separa as faixas e a da PRIMEIRA data. A segunda (a costura)
  // fica fixa de proposito: variar ela nao pode criar faixa nenhuma.
  const pic = (hhmmss, frame) =>
    `PIC_20260427_${hhmmss}_26_05_05_16_46_57_output_${frame}`;

  it('agrupa por sessao e ordena por quadro dentro da faixa', () => {
    const { runs, unmatched } = groupPhotosIntoRuns([
      { id: 'b', originalName: 'MULTICAPTURA_9468_000002' },
      { id: 'c', originalName: 'MULTICAPTURA_9468_000003' },
      { id: 'a', originalName: 'MULTICAPTURA_9468_000001' },
      { id: 'd', originalName: 'MULTICAPTURA_4809_000001' },
    ]);
    assert.equal(unmatched.length, 0);
    assert.equal(runs.length, 2);
    const nove = runs.find(r => r.sessionKey === 'mc:9468');
    assert.deepEqual(nove.photos, ['a', 'b', 'c']);
    assert.equal(nove.photoCount, 3);
  });

  // Os ids do MULTICAPTURA (9468, 4809, 0913) nao sao cronologicos, entao
  // ordenar por eles daria uma sequencia arbitraria com cara de significado.
  it('ordena por tamanho decrescente quando nao ha hora', () => {
    const { runs } = groupPhotosIntoRuns([
      { id: 'a', originalName: 'MULTICAPTURA_9468_1' },
      { id: 'b', originalName: 'MULTICAPTURA_4809_1' },
      { id: 'c', originalName: 'MULTICAPTURA_4809_2' },
    ]);
    assert.deepEqual(runs.map(r => r.sessionKey), ['mc:4809', 'mc:9468']);
    assert.deepEqual(runs.map(r => r.ordinal), [1, 2]);
  });

  it('ordena cronologicamente quando TODAS as faixas tem hora', () => {
    const { runs } = groupPhotosIntoRuns([
      { id: 'a', originalName: pic('192413', 1) },
      { id: 'b', originalName: pic('144714', 1) },
      { id: 'c', originalName: pic('144714', 2) },
    ]);
    // A faixa das 14:47 vem primeiro mesmo tendo mais fotos que a das 19:24.
    assert.deepEqual(runs.map(r => r.label), ['14:47:14', '19:24:13']);
  });

  // Uma lista meio cronologica meio por tamanho nao teria ordem nenhuma, entao
  // o criterio e do PROJETO inteiro: basta uma faixa sem hora para cair no
  // tamanho. Cobre blumenau/santiago/tubarao, que misturam os padroes.
  it('cai para tamanho se ao menos uma faixa do projeto nao tem hora', () => {
    const { runs } = groupPhotosIntoRuns([
      { id: 'a', originalName: pic('144714', 1) },
      { id: 'b', originalName: 'MULTICAPTURA_9468_1' },
      { id: 'c', originalName: 'MULTICAPTURA_9468_2' },
    ]);
    assert.equal(runs[0].sessionKey, 'mc:9468');
    assert.equal(runs[0].photoCount, 2);
  });

  it('prefere captured_at ao numero do quadro quando toda a faixa o tem', () => {
    const { runs } = groupPhotosIntoRuns([
      // O quadro diz a ordem inversa da hora; a hora deve vencer.
      { id: 'tarde', originalName: 'MULTICAPTURA_9468_000001', capturedAt: '2026-05-05T10:00:10' },
      { id: 'cedo', originalName: 'MULTICAPTURA_9468_000002', capturedAt: '2026-05-05T10:00:01' },
    ]);
    assert.deepEqual(runs[0].photos, ['cedo', 'tarde']);
  });

  it('ignora captured_at parcial e usa o quadro', () => {
    const { runs } = groupPhotosIntoRuns([
      { id: 'x', originalName: 'MULTICAPTURA_9468_000002', capturedAt: '2026-05-05T10:00:01' },
      { id: 'y', originalName: 'MULTICAPTURA_9468_000001', capturedAt: null },
    ]);
    assert.deepEqual(runs[0].photos, ['y', 'x']);
  });

  // Sem isto os 18 projetos com faixa MULTICAPTURA ficavam ordenados por numero
  // de fotos, porque o id da sessao e opaco. Uma foto datada por faixa basta.
  it('herda o startedAt da foto datada mais antiga quando o nome nao traz hora', () => {
    const { runs } = groupPhotosIntoRuns([
      { id: 'a', originalName: 'MULTICAPTURA_9468_000002', capturedAt: '2025-03-18T15:07:04' },
      { id: 'b', originalName: 'MULTICAPTURA_9468_000001', capturedAt: '2025-03-18T15:06:00' },
    ]);
    assert.equal(runs[0].startedAt, '2025-03-18T15:06:00');
  });

  it('basta UMA foto datada na faixa para ela ganhar hora', () => {
    const { runs } = groupPhotosIntoRuns([
      { id: 'a', originalName: 'MULTICAPTURA_9468_000001', capturedAt: null },
      { id: 'b', originalName: 'MULTICAPTURA_9468_000002', capturedAt: '2025-03-18T15:06:00' },
      { id: 'c', originalName: 'MULTICAPTURA_9468_000003', capturedAt: null },
    ]);
    assert.equal(runs[0].startedAt, '2025-03-18T15:06:00');
  });

  // O menor capturedAt, e nao o da primeira foto ordenada: assim o inicio nao
  // depende do criterio de ordenacao interna.
  it('usa o MENOR capturedAt, nao o do primeiro quadro', () => {
    const { runs } = groupPhotosIntoRuns([
      { id: 'quadro1', originalName: 'MULTICAPTURA_9468_000001', capturedAt: '2025-03-18T15:09:00' },
      { id: 'quadro2', originalName: 'MULTICAPTURA_9468_000002', capturedAt: null },
      { id: 'quadro3', originalName: 'MULTICAPTURA_9468_000003', capturedAt: '2025-03-18T15:07:00' },
    ]);
    assert.deepEqual(runs[0].photos, ['quadro1', 'quadro2', 'quadro3']);
    assert.equal(runs[0].startedAt, '2025-03-18T15:07:00');
  });

  it('ordena faixas MULTICAPTURA por tempo, nao por tamanho, quando todas tem data', () => {
    const { runs } = groupPhotosIntoRuns([
      // A faixa 9468 e maior, mas comeca depois: a hora tem de vencer o tamanho.
      { id: 'a', originalName: 'MULTICAPTURA_9468_000001', capturedAt: '2025-03-18T16:00:00' },
      { id: 'b', originalName: 'MULTICAPTURA_9468_000002', capturedAt: '2025-03-18T16:01:00' },
      { id: 'c', originalName: 'MULTICAPTURA_4809_000001', capturedAt: '2025-03-18T09:00:00' },
    ]);
    assert.deepEqual(runs.map(r => r.sessionKey), ['mc:4809', 'mc:9468']);
    assert.deepEqual(runs.map(r => r.ordinal), [1, 2]);
  });

  it('volta ao tamanho se uma faixa do projeto nao tem nenhuma foto datada', () => {
    const { runs } = groupPhotosIntoRuns([
      { id: 'a', originalName: 'MULTICAPTURA_9468_000001', capturedAt: '2025-03-18T16:00:00' },
      { id: 'b', originalName: 'MULTICAPTURA_4809_000001', capturedAt: null },
      { id: 'c', originalName: 'MULTICAPTURA_4809_000002', capturedAt: null },
    ]);
    assert.equal(runs[0].sessionKey, 'mc:4809');
    assert.equal(runs[0].photoCount, 2);
  });

  // Sem desempate estavel, o run_position de quadros colididos mudaria a cada
  // execucao do derive-runs, embaralhando a navegacao sem motivo.
  it('e deterministico quando dois quadros colidem', () => {
    const entrada = [
      { id: 'zz', originalName: 'MULTICAPTURA_9468_000001' },
      { id: 'aa', originalName: 'MULTICAPTURA_9468_000001' },
    ];
    const primeira = groupPhotosIntoRuns(entrada).runs[0].photos;
    const segunda = groupPhotosIntoRuns([...entrada].reverse()).runs[0].photos;
    assert.deepEqual(primeira, ['aa', 'zz']);
    assert.deepEqual(primeira, segunda);
  });

  it('separa as fotos de nome desconhecido em vez de inventar faixa', () => {
    const { runs, unmatched } = groupPhotosIntoRuns([
      { id: 'ok', originalName: 'MULTICAPTURA_9468_1' },
      { id: 'estranho', originalName: 'SEM_PADRAO.jpg' },
    ]);
    assert.deepEqual(unmatched, ['estranho']);
    assert.equal(runs.length, 1);
  });

  it('devolve vazio para entrada vazia', () => {
    assert.deepEqual(groupPhotosIntoRuns([]), { runs: [], unmatched: [] });
  });
});

