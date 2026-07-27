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
} from '../../scripts/lib/capture-runs.js';

describe('parseCaptureRun', () => {
  it('le a sessao e o quadro de um nome MULTICAPTURA', () => {
    const r = parseCaptureRun('MULTICAPTURA_9468_005109');
    assert.deepEqual(r, { sessionKey: 'mc:9468', startedAt: null, frame: 5109 });
  });

  // As duas datas do nome PIC_ sao diferentes: a primeira e o processamento, a
  // segunda o inicio da sessao. Pegar a errada agruparia por lote de exportacao.
  it('usa a SEGUNDA data do nome PIC_, que e o inicio da sessao', () => {
    const r = parseCaptureRun('PIC_20260427_090836_26_05_05_16_46_57_output_005');
    assert.equal(r.sessionKey, 'ts:2026-05-05T16:46:57');
    assert.equal(r.startedAt, '2026-05-05T16:46:57');
    assert.equal(r.frame, 5);
  });

  it('expande o ano de dois digitos para o seculo 21', () => {
    assert.equal(parseCaptureRun('PIC_20251205_114053_25_12_08_08_47_46_output_1').startedAt,
      '2025-12-08T08:47:46');
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

describe('runLabel', () => {
  it('mostra so a hora nas sessoes com data', () => {
    assert.equal(runLabel('ts:2026-05-05T16:46:57'), '16:46:57');
  });

  it('mostra o id cru nas sessoes MULTICAPTURA', () => {
    assert.equal(runLabel('mc:9468'), '9468');
  });
});

describe('groupPhotosIntoRuns', () => {
  const pic = (hhmmss, frame) =>
    `PIC_20260427_090836_26_05_05_${hhmmss}_output_${frame}`;

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
      { id: 'a', originalName: pic('19_24_13', 1) },
      { id: 'b', originalName: pic('14_47_14', 1) },
      { id: 'c', originalName: pic('14_47_14', 2) },
    ]);
    // A faixa das 14:47 vem primeiro mesmo tendo mais fotos que a das 19:24.
    assert.deepEqual(runs.map(r => r.label), ['14:47:14', '19:24:13']);
  });

  // Uma lista meio cronologica meio por tamanho nao teria ordem nenhuma, entao
  // o criterio e do PROJETO inteiro: basta uma faixa sem hora para cair no
  // tamanho. Cobre blumenau/santiago/tubarao, que misturam os padroes.
  it('cai para tamanho se ao menos uma faixa do projeto nao tem hora', () => {
    const { runs } = groupPhotosIntoRuns([
      { id: 'a', originalName: pic('14_47_14', 1) },
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
