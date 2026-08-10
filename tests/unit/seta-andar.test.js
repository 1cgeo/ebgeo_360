/**
 * @module tests/unit/seta-andar
 * @description A seta que marca troca de andar no marcador de navegacao.
 *
 * POR QUE ESTE TESTE EXISTE. A primeira versao desenhava a cabeca da seta na
 * ponta errada da haste: a ligacao do 5o para o 6o andar apontava para BAIXO.
 * Sinal trocado nao aparece em lint, nem em teste de rota, nem em contagem de
 * testes verdes. So apareceu no olho do chefe, olhando a tela.
 *
 * A cura foi tirar a geometria do desenho e po-la numa funcao pura. O que e
 * dado, se testa.
 *
 * Convencao de tela: `y` cresce para BAIXO, entao subir e y negativo.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { pontosDaSeta } from '../../public/calibration/js/renderer.js';

const R = 20;

describe('pontosDaSeta', () => {
  test('subindo, a PONTA fica acima da cauda', () => {
    const p = pontosDaSeta(R, true);
    assert.ok(p.ponta.y < p.cauda.y,
      `seta de subida com a ponta abaixo da cauda: ponta ${p.ponta.y}, cauda ${p.cauda.y}`);
  });

  test('descendo, a PONTA fica abaixo da cauda', () => {
    const p = pontosDaSeta(R, false);
    assert.ok(p.ponta.y > p.cauda.y,
      `seta de descida com a ponta acima da cauda: ponta ${p.ponta.y}, cauda ${p.cauda.y}`);
  });

  test('as asas ficam JUNTO DA PONTA, e nao junto da cauda', () => {
    // Esta e a asercao que pega o sinal trocado, e a primeira versao dela NAO
    // pegava. Eu tinha exigido so que a asa ficasse "entre a ponta e a cauda",
    // e a versao com o defeito satisfazia isso: as asas caiam perto da CAUDA,
    // ainda dentro do intervalo. A regua util e a comparacao de distancias.
    for (const sobe of [true, false]) {
      const p = pontosDaSeta(R, sobe);
      for (const [nome, asa] of [['esquerda', p.asaEsq], ['direita', p.asaDir]]) {
        const aPonta = Math.abs(asa.y - p.ponta.y);
        const aCauda = Math.abs(asa.y - p.cauda.y);
        assert.ok(aPonta < aCauda,
          `asa ${nome} mais perto da cauda que da ponta (sobe=${sobe}): `
          + `${aPonta.toFixed(2)} contra ${aCauda.toFixed(2)}`);
      }
    }
  });

  test('a seta e simetrica no eixo vertical e centrada em x=0', () => {
    const p = pontosDaSeta(R, true);
    assert.equal(p.cauda.x, 0);
    assert.equal(p.ponta.x, 0);
    assert.equal(p.asaEsq.x, -p.asaDir.x);
    assert.ok(p.asaDir.x > 0, 'a asa direita tem de ficar em x positivo');
  });

  test('subir e descer sao espelhos exatos', () => {
    const cima = pontosDaSeta(R, true);
    const baixo = pontosDaSeta(R, false);
    for (const k of ['cauda', 'ponta', 'asaEsq', 'asaDir']) {
      assert.equal(cima[k].x, baixo[k].x, `${k}: x tem de ser igual nos dois sentidos`);
      assert.equal(cima[k].y, -baixo[k].y, `${k}: y tem de ser espelhado`);
    }
  });

  test('escala com o raio, para sumir junto com o icone na fila', () => {
    const pequena = pontosDaSeta(10, true);
    const grande = pontosDaSeta(30, true);
    assert.ok(Math.abs(grande.ponta.y) > Math.abs(pequena.ponta.y));
    assert.equal(grande.ponta.y / pequena.ponta.y, 3);
  });
});
