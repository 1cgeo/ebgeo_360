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

import {
  pontosDaSeta, rotuloDeAndar, drawArmillarySphere,
} from '../../public/calibration/js/renderer.js';

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

describe('rotuloDeAndar', () => {
  // Os rotulos abaixo NAO sao inventados: sao os sete valores medidos em
  // photos.floor_label do beira_rio, com a contagem de fotos de cada um.
  test('andar numerado entrega o algarismo', () => {
    assert.equal(rotuloDeAndar(6, '6º andar'), '6');
    assert.equal(rotuloDeAndar(5, '5º andar'), '5');
    assert.equal(rotuloDeAndar(1, '1º andar'), '1');
  });

  test('o nivel 0 do Beira-Rio nao e terreo, e sao DOIS lugares', () => {
    // 86 fotos "Externo" (o anel de fora) e 8 fotos "Campo" (o gramado), ambas
    // com floor_level 0. Um mapa fixo 0 -> "E" apagaria o gramado.
    assert.equal(rotuloDeAndar(0, 'Externo'), 'E');
    assert.equal(rotuloDeAndar(0, 'Campo'), 'C');
  });

  test('sem rotulo, o numero do nivel e o que sobra', () => {
    assert.equal(rotuloDeAndar(5, null), '5');
    assert.equal(rotuloDeAndar(0, null), '0');
    assert.equal(rotuloDeAndar(0, '   '), '0');
  });

  test('o nivel ZERO se escreve, e nao se confunde com ausencia', () => {
    // Tratar 0 como ausente e o erro classico do `if (nivel)`.
    assert.equal(rotuloDeAndar(0), '0');
  });

  test('sem nivel e sem rotulo nao ha texto, e sobra a seta sozinha', () => {
    for (const vazio of [null, undefined, NaN]) {
      assert.equal(rotuloDeAndar(vazio), null, `${String(vazio)} devia dar null`);
      assert.equal(rotuloDeAndar(vazio, null), null, `${String(vazio)} devia dar null`);
    }
  });
});

/**
 * Contexto de canvas falso, que so ANOTA o que foi pedido.
 *
 * Existe porque a regra util nao e a geometria da seta, e sim a decisao de
 * DESENHAR ou nao o texto. Essa decisao mora dentro do `drawArmillarySphere`,
 * e sem um espiao ela so apareceria no olho de quem usa, que foi exatamente
 * como o erro de sinal da seta escapou da primeira vez.
 */
function ctxFalso() {
  const textos = [];
  const linhas = [];
  const ctx = {
    textos, linhas,
    save() {}, restore() {}, beginPath() {}, stroke() {}, fill() {},
    arc() {}, ellipse() {}, setLineDash() {},
    moveTo(x, y) { linhas.push({ x, y }); },
    lineTo(x, y) { linhas.push({ x, y }); },
    fillText(t, x, y) { textos.push({ t, x, y }); },
    strokeText(t, x, y) { textos.push({ t, x, y }); },
  };
  return ctx;
}

describe('o texto do andar no marcador', () => {
  test('marcador grande que troca de andar escreve o andar de DESTINO', () => {
    const ctx = ctxFalso();
    drawArmillarySphere(ctx, 30, { floorDelta: 1, floorLevel: 5, floorLabel: '5º andar' });
    assert.ok(ctx.textos.length > 0, 'nenhum texto desenhado');
    assert.ok(ctx.textos.every(d => d.t === '5'),
      `o texto tinha de ser o destino '5': ${JSON.stringify(ctx.textos)}`);
  });

  test('descer do 6o para o Externo escreve E, e nao 0 nem -6', () => {
    // O caso que o chefe pegou na tela: nivel 0 aqui e "Externo", nao terreo.
    const ctx = ctxFalso();
    drawArmillarySphere(ctx, 30, { floorDelta: -6, floorLevel: 0, floorLabel: 'Externo' });
    assert.ok(ctx.textos.length > 0, 'nenhum texto desenhado');
    assert.ok(ctx.textos.every(d => d.t === 'E'),
      `esperado 'E': ${JSON.stringify(ctx.textos)}`);
  });

  test('o texto e o do ALVO, nunca o salto', () => {
    // Descer do 6o para o 4o e delta -2, e o que se le no icone e 4.
    const ctx = ctxFalso();
    drawArmillarySphere(ctx, 30, { floorDelta: -2, floorLevel: 4, floorLabel: '4º andar' });
    // O `length > 0` nao e zelo: sem ele o `every` de lista VAZIA devolve
    // true, e o teste passa num renderizador que nao escreve texto nenhum.
    assert.ok(ctx.textos.length > 0, 'nenhum texto desenhado');
    assert.ok(ctx.textos.every(d => d.t === '4'),
      `escreveu o salto em vez do destino: ${JSON.stringify(ctx.textos)}`);
  });

  test('mesmo andar nao escreve nada, que e o acervo externo inteiro', () => {
    const ctx = ctxFalso();
    drawArmillarySphere(ctx, 30, { floorDelta: 0, floorLevel: 1, floorLabel: '1º andar' });
    assert.equal(ctx.textos.length, 0,
      `marcador de mesmo andar ganhou texto: ${JSON.stringify(ctx.textos)}`);
  });

  test('marcador pequeno abandona o texto e recentra a seta', () => {
    // A regua que decide o texto e a MESMA que decide o lugar da seta: se o
    // texto nao cabe, a seta nao pode ficar deslocada para um vazio.
    const ctx = ctxFalso();
    drawArmillarySphere(ctx, 6, { floorDelta: 1, floorLevel: 5, floorLabel: '5º andar' });
    assert.equal(ctx.textos.length, 0, 'texto ilegivel foi desenhado');
    assert.ok(ctx.linhas.some(p => p.x === 0),
      'a seta sozinha tem de voltar ao centro do marcador');
  });

  test('alvo oculto nao ganha texto', () => {
    const ctx = ctxFalso();
    drawArmillarySphere(ctx, 30, {
      floorDelta: 1, floorLevel: 5, floorLabel: '5º andar', hidden: true,
    });
    assert.equal(ctx.textos.length, 0, 'alvo desligado ganhou texto');
  });
});
