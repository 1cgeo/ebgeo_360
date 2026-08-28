/**
 * @module tests/unit/tracks.test
 * @description Unit tests for scripts/lib/tracks.js — a guarda do tracado que a
 * Fase 5 usa para nao ligar duas fotos atraves de uma parede.
 *
 * A geometria e montada a mao, com uma linha reta no meridiano, onde um grau de
 * latitude vale 111.320 m e a conta de metro por grau e exata por construcao.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Tracado } from '../../scripts/lib/tracks.js';

const LAT0 = -26.0;
const M_LAT = 111320;
const M_LON = 111320 * Math.cos(LAT0 * Math.PI / 180);
/** Deslocamento em graus de longitude que vale `m` metros nesta latitude. */
const leste = m => m / M_LON;
/** Deslocamento em graus de latitude que vale `m` metros. */
const norte = m => m / M_LAT;

/** Uma reta de 100 m no meridiano, subindo de LAT0. */
function retaNorte() {
  return new Tracado([{
    geometry: { type: 'LineString', coordinates: [[-53.0, LAT0], [-53.0, LAT0 + norte(100)]] },
  }]);
}

describe('Tracado, construcao', () => {
  it('le LineString e MultiLineString, e ignora feicao sem geometria', () => {
    const t = new Tracado([
      { geometry: { type: 'LineString', coordinates: [[-53.0, LAT0], [-53.0, LAT0 + norte(10)]] } },
      { geometry: { type: 'MultiLineString', coordinates: [[[-53.0, LAT0], [-53.0, LAT0 + norte(10)]], [[-52.9, LAT0], [-52.9, LAT0 + norte(10)]]] } },
      { geometry: null },
      null,
    ]);
    assert.equal(t.segmentos.length, 3);
    assert.equal(t.vazio, false);
  });

  it('descarta vertice repetido, que daria segmento de comprimento zero', () => {
    const t = new Tracado([{
      geometry: { type: 'LineString', coordinates: [[-53.0, LAT0], [-53.0, LAT0], [-53.0, LAT0 + norte(10)]] },
    }]);
    assert.equal(t.segmentos.length, 1);
  });

  // Tracado vazio NAO pode virar "tudo passa": seria a guarda sumindo em
  // silencio. Ele devolve Infinity, e quem chama decide (o migrate.js pergunta
  // antes pelo `cobre`).
  it('tracado vazio devolve Infinity, em vez de aprovar tudo', () => {
    const t = new Tracado([]);
    assert.equal(t.vazio, true);
    assert.equal(t.distancia(LAT0, -53.0), Infinity);
    assert.equal(t.excesso(LAT0, -53.0, LAT0, -53.0), Infinity);
    assert.equal(t.cobre([{ lat: LAT0, lon: -53.0 }]), false);
  });
});

describe('Tracado.distancia', () => {
  it('ponto sobre a linha da zero', () => {
    assert.ok(retaNorte().distancia(LAT0 + norte(50), -53.0) < 0.01);
  });

  it('ponto ao lado da a distancia perpendicular', () => {
    const d = retaNorte().distancia(LAT0 + norte(50), -53.0 + leste(20));
    assert.ok(Math.abs(d - 20) < 0.5, `esperado ~20 m, veio ${d}`);
  });

  it('ponto alem da ponta mede ate a PONTA, e nao ate a reta infinita', () => {
    const d = retaNorte().distancia(LAT0 + norte(130), -53.0);
    assert.ok(Math.abs(d - 30) < 0.5, `esperado ~30 m, veio ${d}`);
  });

  // O indice de grade cresce o anel ate o melhor achado caber nele. Sem essa
  // condicao a busca pararia no primeiro anel com algum segmento, que pode nao
  // conter o mais proximo. Este caso poe um segmento longe e um perto.
  it('acha o segmento mais proximo mesmo com outro mais longe no caminho', () => {
    const t = new Tracado([
      { geometry: { type: 'LineString', coordinates: [[-53.0, LAT0], [-53.0, LAT0 + norte(100)]] } },
      { geometry: { type: 'LineString', coordinates: [[-53.0 + leste(500), LAT0], [-53.0 + leste(500), LAT0 + norte(100)]] } },
    ]);
    const d = t.distancia(LAT0 + norte(50), -53.0 + leste(10));
    assert.ok(Math.abs(d - 10) < 0.5, `esperado ~10 m, veio ${d}`);
  });
});

describe('Tracado.excesso', () => {
  it('corda que corre SOBRE o tracado da zero', () => {
    assert.equal(retaNorte().excesso(LAT0, -53.0, LAT0 + norte(100), -53.0), 0);
  });

  // A regua nao e o afastamento bruto. Duas fotos que estao a 20 m da linha
  // ligam-se entre si sem sair mais do que ja estao, e a conexao vale.
  it('corda paralela e afastada da zero, porque os extremos ja estao afastados', () => {
    const e = retaNorte().excesso(LAT0, -53.0 + leste(20), LAT0 + norte(100), -53.0 + leste(20));
    assert.equal(e, 0);
  });

  it('corda que cruza o tracado de um lado ao outro da zero', () => {
    const e = retaNorte().excesso(LAT0 + norte(50), -53.0 - leste(20), LAT0 + norte(50), -53.0 + leste(20));
    assert.equal(e, 0);
  });

  // O caso que motiva o modulo: duas fotos em ruas paralelas, ligadas pela
  // ponta, com a corda passando por fora do tracado. E o "atraves do pavilhao".
  it('corda que SAI do tracado acusa o excesso', () => {
    const t = new Tracado([{
      geometry: {
        type: 'LineString',
        coordinates: [
          [-53.0, LAT0],
          [-53.0, LAT0 + norte(100)],
          [-53.0 + leste(60), LAT0 + norte(100)],
          [-53.0 + leste(60), LAT0],
        ],
      },
    }]);
    // Dois pontos nas duas pernas verticais, na base: a corda corta o vao.
    const e = t.excesso(LAT0 + norte(10), -53.0, LAT0 + norte(10), -53.0 + leste(60));
    assert.ok(e > 20, `esperado excesso alto, veio ${e}`);
  });

  it('e simetrico nos dois sentidos', () => {
    const t = retaNorte();
    const a = t.excesso(LAT0 + norte(10), -53.0 + leste(30), LAT0 + norte(90), -53.0);
    const b = t.excesso(LAT0 + norte(90), -53.0, LAT0 + norte(10), -53.0 + leste(30));
    assert.ok(Math.abs(a - b) < 0.5, `${a} contra ${b}`);
  });

  it('nunca devolve negativo', () => {
    assert.ok(retaNorte().excesso(LAT0 + norte(50), -53.0 + leste(40), LAT0 + norte(51), -53.0 + leste(40)) >= 0);
  });
});

describe('Tracado.cobre', () => {
  it('reconhece a nuvem que fica sobre o tracado', () => {
    const t = retaNorte();
    const fotos = [10, 30, 50, 70, 90].map(m => ({ lat: LAT0 + norte(m), lon: -53.0 }));
    assert.equal(t.cobre(fotos), true);
  });

  // Um projeto cujo tracado nao veio nao pode ser filtrado por tracado alheio.
  it('recusa a nuvem que esta longe, para a guarda sair em vez de reprovar tudo', () => {
    const t = retaNorte();
    const fotos = [10, 30, 50].map(m => ({ lat: LAT0 + norte(m), lon: -53.0 + leste(5000) }));
    assert.equal(t.cobre(fotos), false);
  });

  it('lista vazia nao e cobertura', () => {
    assert.equal(retaNorte().cobre([]), false);
  });

  // Usa a MEDIANA, entao uma foto solta fora nao derruba o projeto inteiro.
  it('uma foto fora nao tira a cobertura do conjunto', () => {
    const t = retaNorte();
    const fotos = [10, 30, 50, 70].map(m => ({ lat: LAT0 + norte(m), lon: -53.0 }));
    fotos.push({ lat: LAT0 + norte(50), lon: -53.0 + leste(4000) });
    assert.equal(t.cobre(fotos), true);
  });
});
