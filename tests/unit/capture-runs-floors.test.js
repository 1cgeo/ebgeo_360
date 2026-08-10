/**
 * @module tests/unit/capture-runs-floors
 * @description O padrao de nome do disparo unico, e a faixa que vira andar num
 * levantamento indoor.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import {
  parseCaptureRun,
  captureTimeFromName,
  runLabel,
  groupPhotosIntoRuns,
} from '../../scripts/lib/capture-runs.js';

test('o disparo unico PIC_<data>_<hora>_<costura> e reconhecido', () => {
  // Antes deste padrao, os 266 nomes assim do Beira-Rio caiam em `unmatched`.
  const r = parseCaptureRun('PIC_20260520_104137_20260521163900');

  assert.ok(r, 'nome nao reconhecido');
  assert.equal(r.sessionKey, 'ss:20260521163900');
  assert.equal(r.startedAt, null);
  assert.equal(r.shotAt, '2026-05-20T10:41:37');
});

test('o disparo unico nao e confundido com o lote costurado', () => {
  const costurado = parseCaptureRun('PIC_20260521_154731_26_05_21_17_05_06_output_318');

  assert.equal(costurado.sessionKey, 'ts:2026-05-21T15:47:31');
  assert.equal(costurado.frame, 318);
  assert.equal(costurado.shotAt, undefined);
});

test('a hora do disparo unico e o proprio nome, sem cadencia a somar', () => {
  assert.equal(captureTimeFromName('PIC_20260520_104137_20260521163900'), '2026-05-20T10:41:37');
  // O costurado continua somando 4 s por quadro: 09:08:36 + 5 x 4 s.
  assert.equal(
    captureTimeFromName('PIC_20260427_090836_26_05_05_16_46_57_output_005'),
    '2026-04-27T09:08:56'
  );
});

test('o rotulo da costura cabe na lista', () => {
  assert.equal(runLabel('ss:20260521163900'), '21/05 16:39');
});

/** Fotos de tres andares, com nomes de disparo unico. */
function fotosIndoor() {
  return [
    { id: 'a', originalName: 'PIC_20260520_104137_20260521163900', floorLevel: 1, floorLabel: '1º andar' },
    { id: 'b', originalName: 'PIC_20260520_104224_20260521163900', floorLevel: 1, floorLabel: '1º andar' },
    { id: 'c', originalName: 'PIC_20260520_112643_20260521163900', floorLevel: 0, floorLabel: 'Campo' },
    { id: 'd', originalName: 'PIC_20260521_152135_20260521163901', floorLevel: 6, floorLabel: '6º andar' },
    { id: 'e', originalName: 'PIC_20260521_152220_20260521163901', floorLevel: 6, floorLabel: '6º andar' },
    { id: 'f', originalName: 'PIC_20260520_104318_20260521163900', floorLevel: 1, floorLabel: '1º andar' },
  ];
}

test('byFloor da uma faixa por andar, nao uma por costura', () => {
  const { runs, unmatched } = groupPhotosIntoRuns(fotosIndoor(), { byFloor: true });

  assert.equal(unmatched.length, 0);
  assert.equal(runs.length, 3);
  assert.deepEqual(runs.map(r => r.sessionKey), ['fl:0', 'fl:1', 'fl:6']);
  assert.deepEqual(runs.map(r => r.label), ['Campo', '1º andar', '6º andar']);
  assert.deepEqual(runs.map(r => r.photoCount), [1, 3, 2]);
});

test('sem byFloor as MESMAS fotos dao a faixa errada', () => {
  // Este e o teste que REPROVA o estado anterior: por costura, os 6 disparos
  // viram 2 faixas que misturam terreo, primeiro e sexto andar.
  const { runs } = groupPhotosIntoRuns(fotosIndoor());

  assert.equal(runs.length, 2);
  assert.ok(
    runs.some(r => r.photoCount === 4),
    'esperava uma faixa juntando andares diferentes pela costura'
  );
});

test('a ordem das faixas por andar sobe o predio', () => {
  const { runs } = groupPhotosIntoRuns(fotosIndoor(), { byFloor: true });
  assert.deepEqual(runs.map(r => r.ordinal), [1, 2, 3]);
  assert.deepEqual(runs.map(r => r.level), [0, 1, 6]);
});

test('dentro da faixa a ordem e cronologica mesmo sem captured_at', () => {
  // O instante do disparo entra como numero de quadro, entao a ordenacao sai
  // certa sem depender do import-captured-at ter rodado.
  const { runs } = groupPhotosIntoRuns(fotosIndoor(), { byFloor: true });
  const andar1 = runs.find(r => r.sessionKey === 'fl:1');

  assert.deepEqual(andar1.photos, ['a', 'b', 'f']);
});

test('nome irreconhecivel nao perde a faixa quando ha andar', () => {
  const { runs, unmatched } = groupPhotosIntoRuns(
    [{ id: 'x', originalName: 'FOTO_SEM_PADRAO', floorLevel: 2, floorLabel: '2º andar' }],
    { byFloor: true }
  );

  assert.equal(unmatched.length, 0);
  assert.equal(runs[0].sessionKey, 'fl:2');
});

test('projeto sem andar segue no comportamento antigo', () => {
  const fotos = [
    { id: 'a', originalName: 'MULTICAPTURA_9468_005109' },
    { id: 'b', originalName: 'MULTICAPTURA_9468_005110' },
    { id: 'c', originalName: 'MULTICAPTURA_4809_000001' },
  ];
  const { runs, unmatched } = groupPhotosIntoRuns(fotos);

  assert.equal(unmatched.length, 0);
  assert.equal(runs.length, 2);
  assert.equal(runs[0].photoCount, 2);
});
