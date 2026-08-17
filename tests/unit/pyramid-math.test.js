/**
 * @module tests/unit/pyramid-math.test
 * @description Testes da UNICA verdade da piramide 360:
 * public/calibration/js/pyramid-math.js.
 *
 * POR QUE ESTE ARQUIVO EXISTE. O modulo nasceu para acabar com tres escadas
 * divergentes e dois frustums divergentes, e entrou sem teste nenhum. Ele agora
 * e a conta de QUATRO consumidores (gerador, rota, cliente e benchmark), entao
 * um arredondamento que mude aqui muda o dado gravado, a grade publicada, o
 * pedido do navegador e o numero do piloto de uma vez so.
 *
 * Os numeros deste arquivo sao MEDIDOS, e nao deduzidos da formula:
 *   - as duas escadas saem das duas resolucoes reais do acervo, 7680x3840 e
 *     5760x2880, com o tile de 512 que o piloto usa;
 *   - os 6119 px e os 4264 px de largura necessaria foram medidos em Chrome, e
 *     ancoram a conta pela fov HORIZONTAL. Uma conta pela vertical daria 4728 na
 *     primeira tela, e escolheria um nivel abaixo do necessario.
 *
 * O teste nao repete a formula que deveria estar conferindo. Onde a conta antiga
 * errava, este arquivo escreve a conta antiga a mao e exige que ela DISCORDE.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  LARGURA_MINIMA_NIVEL,
  RAZAO_PADRAO,
  montarEscada,
  custoDaEscada,
  fovHorizontal,
  larguraNecessaria,
  escolherNivel,
  tilesVisiveis,
} from '../../public/calibration/js/pyramid-math.js';

const TILE = 512;

/** As duas resolucoes reais do acervo, na escada que o piloto gera. */
const ESCADA_7680 = montarEscada(7680, 3840, TILE);
const ESCADA_5760 = montarEscada(5760, 2880, TILE);

/** A escada fina de 7680, que e o conserto do vao entre 3840 e 7680. */
const ESCADA_7680_R16 = montarEscada(7680, 3840, TILE, 1.6);

/**
 * As duas telas MEDIDAS em Chrome, que ancoram a escolha de nivel.
 * O notebook e quem expoe o defeito: 4264 cai dentro do vao da razao 2.
 */
const NOTEBOOK = larguraNecessaria(1350, 673, 75);
const MONITOR = larguraNecessaria(1904, 985, 75);

/** O nivel nativo de cada escada, que e onde a borda parcial aparece. */
const NATIVO_7680 = ESCADA_7680[ESCADA_7680.length - 1];
const NATIVO_5760 = ESCADA_5760[ESCADA_5760.length - 1];

/**
 * Colunas distintas de uma lista de tiles, em ordem crescente.
 * @param {Array<{x:number,y:number,d:number}>} lista - Saida de tilesVisiveis.
 * @returns {number[]} Colunas sem repeticao.
 */
function colunasDe(lista) {
  return [...new Set(lista.map(t => t.x))].sort((a, b) => a - b);
}

/**
 * Linhas distintas de uma lista de tiles, em ordem crescente.
 * @param {Array<{x:number,y:number,d:number}>} lista - Saida de tilesVisiveis.
 * @returns {number[]} Linhas sem repeticao.
 */
function linhasDe(lista) {
  return [...new Set(lista.map(t => t.y))].sort((a, b) => a - b);
}

/**
 * Conjunto de chaves "x,y", que e como se compara um frustum com outro.
 * @param {Array<{x:number,y:number,d:number}>} lista - Saida de tilesVisiveis.
 * @returns {Set<string>} Chaves unicas.
 */
function paresDe(lista) {
  return new Set(lista.map(t => `${t.x},${t.y}`));
}

describe('montarEscada', () => {
  it('monta 3 niveis para a panoramica de 7680x3840', () => {
    // A escada para de descer em 1920 porque 1920 nao passa de 2048. Os numeros
    // estao escritos inteiros de proposito: o ceil da coluna e da linha e a
    // conta que o descritor publica, e o teste que a recalcula nao confere nada.
    assert.deepEqual(ESCADA_7680, [
      { level: 0, width: 1920, height: 960, cols: 4, rows: 2 },
      { level: 1, width: 3840, height: 1920, cols: 8, rows: 4 },
      { level: 2, width: 7680, height: 3840, cols: 15, rows: 8 },
    ]);
  });

  it('monta 3 niveis para a panoramica de 5760x2880', () => {
    assert.deepEqual(ESCADA_5760, [
      { level: 0, width: 1440, height: 720, cols: 3, rows: 2 },
      { level: 1, width: 2880, height: 1440, cols: 6, rows: 3 },
      { level: 2, width: 5760, height: 2880, cols: 12, rows: 6 },
    ]);
  });

  it('para de descer no piso de largura, e nunca abaixo dele sem precisar', () => {
    // O nivel 0 e o unico que pode ficar abaixo do piso, porque ele e o degrau
    // seguinte ao ultimo que ainda passava de 2048.
    for (const escada of [ESCADA_7680, ESCADA_5760]) {
      for (const nivel of escada.slice(1)) {
        assert.ok(nivel.width > LARGURA_MINIMA_NIVEL, `nivel ${nivel.level} abaixo do piso`);
      }
    }
  });

  it('numera do mais grosso ao nativo, dobrando a cada degrau', () => {
    for (const escada of [ESCADA_7680, ESCADA_5760]) {
      escada.forEach((nivel, i) => {
        assert.equal(nivel.level, i);
        if (i > 0) {
          assert.equal(nivel.width, escada[i - 1].width * 2);
          assert.equal(nivel.height, escada[i - 1].height * 2);
        }
      });
    }
  });

  it('nao desce quando a nativa ja cabe no piso', () => {
    const escada = montarEscada(2048, 1024, TILE);
    assert.deepEqual(escada, [{ level: 0, width: 2048, height: 1024, cols: 4, rows: 2 }]);
  });

  it('recorta a borda: a ultima coluna de 5760 mede 128 px, e nao 512', () => {
    // Este e o fato que quebra a conta por indice de tile. 11 colunas cheias
    // somam 5632 px, e sobram 128 px na coluna 12. Metade do acervo e assim.
    const { cols, width } = NATIVO_5760;
    assert.equal(cols, 12);
    assert.equal(width - (cols - 1) * TILE, 128);

    // Em 7680 a largura fecha exata: 15 colunas cheias. E o caso que esconde o
    // defeito, porque ali `cols * tileSize == width`.
    assert.equal(NATIVO_7680.cols * TILE, NATIVO_7680.width);
  });
});

describe('montarEscada: a razao', () => {
  it('monta 4 niveis em 7680 com razao 1,6', () => {
    // OS NUMEROS SAO O ORCAMENTO, e nao a formula reescrita. Eles saem de
    // custoDaEscada() rodado antes de gerar um byte, e sao o que decide a razao
    // do acervo. Escrever inteiros aqui e o unico jeito de o teste reprovar uma
    // mudanca de arredondamento.
    assert.deepEqual(ESCADA_7680_R16, [
      { level: 0, width: 1875, height: 938, cols: 4, rows: 2 },
      { level: 1, width: 3000, height: 1500, cols: 6, rows: 3 },
      { level: 2, width: 4800, height: 2400, cols: 10, rows: 5 },
      { level: 3, width: 7680, height: 3840, cols: 15, rows: 8 },
    ]);
  });

  it('nao regride a razao 2 quando ela vem explicita', () => {
    // O parametro novo nao pode mexer no acervo ja gerado. O museu_cms tem
    // 12160 tiles gravados na escada classica, e outra escada nao daria erro:
    // daria tile faltando.
    assert.deepEqual(montarEscada(7680, 3840, TILE, 2), ESCADA_7680);
    assert.deepEqual(montarEscada(7680, 3840, TILE, RAZAO_PADRAO), ESCADA_7680);
    assert.deepEqual(montarEscada(5760, 2880, TILE, 2), ESCADA_5760);
  });

  it('a escada de 1,6 e OUTRA grade, e nao um refinamento da de 2', () => {
    // POR QUE A RAZAO SE GRAVA JUNTO DA PIRAMIDE. Reconstruir com a razao errada
    // nao estoura: produz uma grade diferente, e o cliente pede um tile que
    // ninguem gravou. O nivel 1 da escada fina tem 6 colunas, e nenhum nivel da
    // escada classica tem essa largura.
    const largurasClassicas = ESCADA_7680.map(n => n.width);
    assert.ok(!largurasClassicas.includes(3000), 'a escada de 2 passou a conter 3000');
    assert.ok(!largurasClassicas.includes(4800), 'a escada de 2 passou a conter 4800');
    assert.notEqual(ESCADA_7680_R16.length, ESCADA_7680.length);
  });

  it('cai em RAZAO_PADRAO para razao invalida, sem travar', () => {
    // Razao <= 1 nunca desce, e um laco que espera descer nao termina. A guarda
    // troca o valor pela escada classica em vez de estourar, porque quem chama e
    // o gerador no meio de um lote: parar um acervo por um parametro torto e
    // pior que gerar a escada de sempre.
    //
    // O 1 exato tem de cair aqui tambem. Sem o `> 1` ele passaria pela guarda e
    // pararia no primeiro degrau, devolvendo uma escada de um nivel so.
    for (const razao of [0, 1, -3, NaN, undefined, Infinity]) {
      assert.deepEqual(montarEscada(7680, 3840, TILE, razao), ESCADA_7680,
        `razao ${razao} nao caiu em RAZAO_PADRAO`);
    }
  });

  it('para quando a razao arredonda para a mesma largura', () => {
    // 2100 dividido por 1,0001 da 2099,79, e o round devolve 2100. Sem a guarda
    // `proximaW >= w` o laco empilharia 2100 para sempre.
    assert.deepEqual(montarEscada(2100, 1050, TILE, 1.0001), [
      { level: 0, width: 2100, height: 1050, cols: 5, rows: 3 },
    ]);
  });

  it('termina mesmo com razao absurda, e para no ponto de empate', () => {
    // Em 7680 a razao 1,0001 ainda desce, um pixel por degrau, e so empata perto
    // de 5000: abaixo disso a diferenca cai de meio pixel e o round nao mexe
    // mais. A escada sai com 2681 niveis, o que e inutil, mas TERMINA. E a
    // diferenca entre um parametro ruim e um servico travado.
    const escada = montarEscada(7680, 3840, TILE, 1.0001);
    assert.equal(escada.length, 2681);
    assert.equal(escada[0].width, 5000);
    assert.equal(escada[escada.length - 1].width, 7680);

    for (let i = 1; i < escada.length; i++) {
      assert.ok(escada[i].width > escada[i - 1].width,
        `largura nao cresceu na posicao ${i}`);
    }

    // MEDIDO, e nao desejado: a altura NAO acompanha. 3840 dividido por 1,0001
    // arredonda de volta para 3840, entao a proporcao se perde. Mais um motivo
    // para a razao util ficar entre 1,4 e 2.
    assert.equal(escada[0].height, 3840);
  });
});

describe('custoDaEscada', () => {
  it('da 1 para a escada de um nivel so', () => {
    // Um nivel e o proprio nativo, entao nao ha nada acima do custo de servir a
    // foto inteira.
    assert.equal(custoDaEscada(montarEscada(2048, 1024, TILE)), 1);
  });

  it('bate com a soma de areas dividida pela area nativa', () => {
    // A definicao, conferida contra a implementacao numa escada de 4 niveis.
    const soma = ESCADA_7680_R16.reduce((total, n) => total + n.width * n.height, 0);
    assert.equal(soma, 47269950);
    assert.equal(custoDaEscada(ESCADA_7680_R16), soma / (7680 * 3840));
  });

  it('cobra 1,31x na razao 2 e 1,60x na razao 1,6', () => {
    // O 1,3125 e exato: 1/4 + 1/16 + 1 na progressao geometrica de area. O custo
    // MEDIDO e maior, porque tile pequeno comprime pior por pixel (no museu_cms
    // a razao 2 deu 1,55 medido contra 1,3125 teorico).
    assert.equal(custoDaEscada(ESCADA_7680), 1.3125);
    assert.ok(Math.abs(custoDaEscada(ESCADA_7680_R16) - 1.6028) < 1e-4);
  });

  it('cresce quando a razao encolhe', () => {
    const custos = [2, 1.6, 1.5, 1.4].map(r => custoDaEscada(montarEscada(7680, 3840, TILE, r)));
    for (let i = 1; i < custos.length; i++) {
      assert.ok(custos[i] > custos[i - 1], `razao menor nao custou mais na posicao ${i}`);
    }
  });
});

describe('a escada contra as telas medidas: o defeito do vao', () => {
  it('a razao 2 manda o notebook ao nativo, 80% acima do necessario', () => {
    // O DEFEITO. As duas telas reais pedem 4264 e 6119, e as duas caem no vao
    // entre 3840 e 7680. Todo viewport satura no nativo, entao a escada de tres
    // niveis nao economiza nada para quem esta olhando.
    assert.ok(NOTEBOOK > 3840 && NOTEBOOK < 7680, `4264 saiu do vao: ${NOTEBOOK}`);
    assert.ok(MONITOR > 3840 && MONITOR < 7680, `6119 saiu do vao: ${MONITOR}`);

    const nivel = escolherNivel(ESCADA_7680, NOTEBOOK);
    assert.equal(nivel, 2);
    assert.equal(ESCADA_7680[nivel].width, 7680);
    assert.ok(7680 / NOTEBOOK > 1.8, `desperdicio de largura menor que 80%: ${7680 / NOTEBOOK}`);
  });

  it('a razao 1,6 leva o notebook a 4800, e nao ao nativo', () => {
    // O CONSERTO, e este e o teste que o prova. O degrau de 4800 cobre os 4264
    // pedidos com 13% de folga, contra os 80% da escada classica. Em area isso e
    // 2,56 vezes menos pixel para a mesma tela.
    const nivel = escolherNivel(ESCADA_7680_R16, NOTEBOOK);
    assert.equal(nivel, 2);
    assert.equal(ESCADA_7680_R16[nivel].width, 4800);
    assert.notEqual(ESCADA_7680_R16[nivel].width, 7680);
    assert.ok(4800 / NOTEBOOK < 1.13, `folga acima de 13%: ${4800 / NOTEBOOK}`);
  });

  it('o monitor de 1904x985 continua no nativo, e esta certo', () => {
    // 4800 nao cobre 6119, entao a tela grande pede mesmo o nivel 3. A escada
    // fina conserta o notebook sem mentir para o monitor.
    const nivel = escolherNivel(ESCADA_7680_R16, MONITOR);
    assert.equal(nivel, 3);
    assert.equal(ESCADA_7680_R16[nivel].width, 7680);
  });

  it('a razao 1,6 DOMINA a 1,5 e a 1,4: escolhe melhor e custa menos', () => {
    // A comparacao que decidiu o parametro. Dominar quer dizer ganhar nos dois
    // eixos ao mesmo tempo, e nao trocar um pelo outro.
    for (const razao of [1.5, 1.4]) {
      const outra = montarEscada(7680, 3840, TILE, razao);
      const larguraOutra = outra[escolherNivel(outra, NOTEBOOK)].width;

      assert.ok(larguraOutra > 4800,
        `razao ${razao} escolheu ${larguraOutra}, que nao e pior que 4800`);
      assert.ok(custoDaEscada(outra) > custoDaEscada(ESCADA_7680_R16),
        `razao ${razao} nao custou mais que 1,6`);
    }
  });

  it('nos 5760 do acervo a escada classica ja casa, e nao ha o que consertar', () => {
    // O problema e SO dos 7680. Em 5760 o nivel 1 mede 2880 e o nativo 5760, e o
    // monitor de 6119 satura no nativo porque a foto acabou, e nao porque a
    // escada e grossa. Mudar a razao aqui so gastaria disco.
    assert.equal(escolherNivel(ESCADA_5760, MONITOR), 2);
    assert.equal(ESCADA_5760[2].width, 5760);
    assert.ok(MONITOR > 5760, 'o monitor deixou de pedir mais que a foto inteira');
  });
});

describe('fovHorizontal', () => {
  it('devolve a propria fov numa tela quadrada', () => {
    assert.ok(Math.abs(fovHorizontal(75, 1) - 75) < 1e-9);
  });

  it('abre com a tela larga e fecha com a tela alta', () => {
    assert.ok(fovHorizontal(75, 1.93) > 75);
    assert.ok(fovHorizontal(75, 0.5) < 75);
  });

  it('nunca alcanca 180 graus, por mais larga que seja a tela', () => {
    // O limite do atan e 90 graus de meia fov. Passar de 180 faria a volta
    // inteira valer menos que o campo, e o frustum pediria coluna repetida.
    assert.ok(fovHorizontal(75, 1000) < 180);
  });
});

describe('larguraNecessaria', () => {
  it('da 6119 px no monitor de 1904x985 com fov 75', () => {
    // MEDIDO EM CHROME. E a ancora do modulo, e nao um valor de regressao: a
    // conta pela vertical daria 4728 na mesma tela, e escolheria um nivel
    // abaixo do necessario.
    const medido = larguraNecessaria(1904, 985, 75);
    assert.ok(Math.abs(medido - 6119) <= 2, `esperava ~6119, veio ${medido}`);
  });

  it('da 4264 px na janela de 1350x673 com fov 75', () => {
    const medido = larguraNecessaria(1350, 673, 75);
    assert.ok(Math.abs(medido - 4264) <= 2, `esperava ~4264, veio ${medido}`);
  });

  it('cresce quando a tela cresce, na mesma fov', () => {
    assert.ok(larguraNecessaria(1904, 985, 75) > larguraNecessaria(1350, 673, 75));
  });

  it('devolve 0 para largura, altura ou fov zerada', () => {
    // O DEFEITO DO NaN. Tela oculta ou container de largura zero davam NaN, e
    // toda comparacao com NaN e falsa: a escolha caia no nivel NATIVO, o mais
    // caro, justamente para quem nao esta vendo nada.
    assert.equal(larguraNecessaria(0, 985, 75), 0);
    assert.equal(larguraNecessaria(1904, 0, 75), 0);
    assert.equal(larguraNecessaria(1904, 985, 0), 0);
    assert.equal(larguraNecessaria(0, 0, 0), 0);
  });

  it('devolve 0 para entrada negativa ou nao numerica', () => {
    assert.equal(larguraNecessaria(-1904, 985, 75), 0);
    assert.equal(larguraNecessaria(1904, 985, -75), 0);
    assert.equal(larguraNecessaria(NaN, 985, 75), 0);
    assert.equal(larguraNecessaria(undefined, 985, 75), 0);
  });
});

describe('escolherNivel', () => {
  it('devolve 0, e nao o nativo, quando a largura necessaria e 0', () => {
    // A outra metade do defeito do NaN. Se a tela nao tem area, o barato e o
    // certo: o nivel mais grosso. Cair no nativo era pagar o tile caro para
    // uma aba de fundo.
    assert.equal(escolherNivel(ESCADA_7680, 0), 0);
    assert.equal(escolherNivel(ESCADA_7680, larguraNecessaria(0, 0, 75)), 0);
  });

  it('devolve 0 para qualquer valor nao finito ou negativo', () => {
    // A guarda e `Number.isFinite`, entao Infinity cai no nivel 0 junto com o
    // NaN. E o lado seguro: valor nao finito quer dizer que a medida da tela
    // falhou, e medida que falhou nao pode pedir o tile mais caro.
    assert.equal(escolherNivel(ESCADA_7680, NaN), 0);
    assert.equal(escolherNivel(ESCADA_7680, Infinity), 0);
    assert.equal(escolherNivel(ESCADA_7680, -Infinity), 0);
    assert.equal(escolherNivel(ESCADA_7680, -100), 0);
  });

  it('escolhe o nativo quando a tela medida pede 6119 px', () => {
    // 3840 nao cobre 6119, entao a tela de 1904x985 pede mesmo o nivel 2.
    assert.equal(escolherNivel(ESCADA_7680, larguraNecessaria(1904, 985, 75)), 2);
  });

  it('escolhe o menor nivel que cobre, e nao o primeiro que passa perto', () => {
    assert.equal(escolherNivel(ESCADA_7680, 1000), 0);
    assert.equal(escolherNivel(ESCADA_7680, 1920), 0);
    assert.equal(escolherNivel(ESCADA_7680, 1921), 1);
    assert.equal(escolherNivel(ESCADA_7680, 3840), 1);
    assert.equal(escolherNivel(ESCADA_7680, 3841), 2);
  });

  it('satura no nativo em vez de pedir nivel que nao existe', () => {
    // Monitor 5K com fov estreita pede mais pixel do que a foto tem. A resposta
    // e o nativo, nunca um level fora da escada, que viraria 400 na rota.
    assert.equal(escolherNivel(ESCADA_5760, 99999), 2);
    assert.equal(escolherNivel(ESCADA_5760, ESCADA_5760[2].width + 1), 2);
  });
});

describe('tilesVisiveis: a coluna parcial', () => {
  it('mede a coluna em PIXEL, e reprova a conta antiga (lon/360)*cols', () => {
    // O CASO QUE EXPOE O DEFEITO. Em 5760 a coluna 10 vai de 5120 a 5632 px, ou
    // seja de 320 a 352 graus. A camera em lon 340 esta dentro dela.
    //
    // A conta antiga distribuia a volta pelas 12 colunas como se todas medissem
    // 512 px. Como a 12a mede 128, ela comprime a escala e joga 340 graus para a
    // coluna 11, que na verdade so comeca em 352 graus. O cliente pedia o tile
    // errado, e o buraco aparecia na tela.
    const camera = { lon: 340, lat: 0, fov: 1, largura: 1000, altura: 1000 };
    const colunas = colunasDe(tilesVisiveis(NATIVO_5760, TILE, camera, 0));
    assert.deepEqual(colunas, [10]);

    // A conta antiga, escrita a mao aqui para o teste REPROVAR ela. Se alguem
    // reintroduzir o indice de tile no lugar do pixel, esta linha passa a
    // concordar com a de cima e o teste cai.
    const colunaAntiga = Math.floor((340 / 360) * NATIVO_5760.cols);
    assert.equal(colunaAntiga, 11);
    assert.ok(!colunas.includes(colunaAntiga), 'a conta por indice de tile voltou');
  });

  it('acumula 0,7 tile de erro em lon 355, que e onde o desvio foi medido', () => {
    // O numero do relato: em alegrete, lon 355, a conta por indice errava 0,7
    // tile. Aqui as duas contas coincidem na coluna, e por isso o defeito
    // passava despercebido: o que diverge e a POSICAO dentro da volta, e ela
    // vaza para a borda do arco assim que a fov abre.
    const indiceAntigo = (355 / 360) * NATIVO_5760.cols;
    const indiceNovo = ((355 / 360) * NATIVO_5760.width) / TILE;
    assert.ok(Math.abs(indiceAntigo - indiceNovo) > 0.7,
      `desvio ${Math.abs(indiceAntigo - indiceNovo)} menor que os 0,7 tile medidos`);

    const camera = { lon: 355, lat: 0, fov: 1, largura: 1000, altura: 1000 };
    assert.deepEqual(colunasDe(tilesVisiveis(NATIVO_5760, TILE, camera, 0)), [11]);
  });

  it('nunca devolve coluna fora da grade, nem na emenda da coluna parcial', () => {
    // Varre a volta inteira: x = cols e 400 na rota, e um off-by-one na coluna
    // parcial e exatamente onde ele apareceria.
    for (let lon = 0; lon < 360; lon += 5) {
      const camera = { lon, lat: 0, fov: 75, largura: 1904, altura: 985 };
      for (const tile of tilesVisiveis(NATIVO_5760, TILE, camera, 1)) {
        assert.ok(tile.x >= 0 && tile.x < NATIVO_5760.cols, `x ${tile.x} fora em lon ${lon}`);
        assert.ok(tile.y >= 0 && tile.y < NATIVO_5760.rows, `y ${tile.y} fora em lon ${lon}`);
      }
    }
  });
});

describe('tilesVisiveis: cobertura e repeticao', () => {
  it('devolve todas as colunas, sem repetir, quando a fov cobre tudo', () => {
    // Tela larga com fov 170 perto do zenite: o campo passa dos 360 graus. A
    // resposta e a grade inteira UMA vez. Repetir coluna seria pedir os mesmos
    // pixels duas vezes e dobrar o cache.
    const camera = { lon: 0, lat: 0, fov: 170, largura: 4000, altura: 1000 };
    const lista = tilesVisiveis(NATIVO_5760, TILE, camera, 0);

    assert.deepEqual(colunasDe(lista), [...Array(NATIVO_5760.cols).keys()]);
    assert.equal(paresDe(lista).size, lista.length, 'tile repetido na lista');
    assert.equal(lista.length, NATIVO_5760.cols * NATIVO_5760.rows);
  });

  it('nunca repete tile numa camera estreita', () => {
    const camera = { lon: 120, lat: 10, fov: 60, largura: 1904, altura: 985 };
    const lista = tilesVisiveis(NATIVO_5760, TILE, camera, 1);
    assert.equal(paresDe(lista).size, lista.length);
    assert.ok(lista.length < NATIVO_5760.cols * NATIVO_5760.rows, 'fov de 60 pediu a grade inteira');
  });
});

describe('tilesVisiveis: a margem', () => {
  it('margem 0 e subconjunto PROPRIO da margem 1', () => {
    // O benchmark mede o conjunto ideal (margem 0) e o que a producao pede
    // (margem 1). Se um nao contiver o outro, os dois numeros do piloto medem
    // coisas diferentes, e foi assim que a divergencia de 2,2x nasceu.
    const camera = { lon: 120, lat: 10, fov: 60, largura: 1904, altura: 985 };
    const sem = paresDe(tilesVisiveis(NATIVO_5760, TILE, camera, 0));
    const com = paresDe(tilesVisiveis(NATIVO_5760, TILE, camera, 1));

    for (const par of sem) {
      assert.ok(com.has(par), `margem 1 perdeu o tile ${par} que margem 0 pedia`);
    }
    assert.ok(com.size > sem.size, 'margem 1 nao acrescentou nada');
  });

  it('a margem cresce em coluna E em linha', () => {
    const camera = { lon: 120, lat: 10, fov: 60, largura: 1904, altura: 985 };
    const sem = tilesVisiveis(NATIVO_5760, TILE, camera, 0);
    const com = tilesVisiveis(NATIVO_5760, TILE, camera, 1);

    assert.ok(colunasDe(com).length > colunasDe(sem).length);
    assert.ok(linhasDe(com).length > linhasDe(sem).length);
  });

  it('a margem nao inventa coluna quando a grade inteira ja esta dentro', () => {
    const camera = { lon: 0, lat: 0, fov: 170, largura: 4000, altura: 1000 };
    const lista = tilesVisiveis(NATIVO_5760, TILE, camera, 2);
    assert.equal(paresDe(lista).size, lista.length);
    assert.deepEqual(colunasDe(lista), [...Array(NATIVO_5760.cols).keys()]);
  });
});

describe('tilesVisiveis: a ordem', () => {
  it('sai do centro da tela para a borda', () => {
    // O cliente busca na ordem em que recebe. O que o olho esta olhando tem de
    // chegar primeiro, senao a panoramica preenche pelas quinas.
    const camera = { lon: 120, lat: 10, fov: 60, largura: 1904, altura: 985 };
    const lista = tilesVisiveis(NATIVO_5760, TILE, camera, 1);
    assert.ok(lista.length > 1);

    for (let i = 1; i < lista.length; i++) {
      assert.ok(lista[i - 1].d <= lista[i].d,
        `distancia caiu de ${lista[i - 1].d} para ${lista[i].d} na posicao ${i}`);
    }
  });

  it('poe no topo o tile que contem o centro da camera', () => {
    const camera = { lon: 120, lat: 0, fov: 60, largura: 1904, altura: 985 };
    const lista = tilesVisiveis(NATIVO_5760, TILE, camera, 1);

    const colunaCentro = Math.floor(((120 / 360) * NATIVO_5760.width) / TILE);
    const linhaCentro = Math.floor(((90 - 0) / 180) * NATIVO_5760.height / TILE);
    assert.equal(lista[0].x, colunaCentro);
    assert.equal(lista[0].y, linhaCentro);
  });
});

describe('tilesVisiveis: o wrap na emenda', () => {
  it('pega os dois lados da emenda em lon 0', () => {
    // A emenda da equirretangular fica entre a ultima coluna e a coluna 0. Uma
    // implementacao que recorte o arco em [0, width] em vez de dar a volta perde
    // metade do campo, e a foto abre com meia tela preta.
    const camera = { lon: 0, lat: 0, fov: 60, largura: 1904, altura: 985 };
    const colunas = colunasDe(tilesVisiveis(NATIVO_7680, TILE, camera, 0));

    assert.ok(colunas.includes(0), 'faltou a coluna 0');
    assert.ok(colunas.includes(NATIVO_7680.cols - 1), 'faltou a ultima coluna');
  });

  it('pega os dois lados da emenda em lon 359', () => {
    const camera = { lon: 359, lat: 0, fov: 60, largura: 1904, altura: 985 };
    const colunas = colunasDe(tilesVisiveis(NATIVO_7680, TILE, camera, 0));

    assert.ok(colunas.includes(0), 'faltou a coluna 0');
    assert.ok(colunas.includes(NATIVO_7680.cols - 1), 'faltou a ultima coluna');
  });

  it('trata lon negativa e lon acima de 360 como a mesma direcao', () => {
    const base = { lat: 0, fov: 60, largura: 1904, altura: 985 };
    const referencia = paresDe(tilesVisiveis(NATIVO_5760, TILE, { ...base, lon: 30 }, 1));

    for (const lon of [-330, 390, 750]) {
      const outra = paresDe(tilesVisiveis(NATIVO_5760, TILE, { ...base, lon }, 1));
      assert.deepEqual([...outra].sort(), [...referencia].sort(), `lon ${lon} divergiu de 30`);
    }
  });

  it('a emenda em lon 355 usa a coluna parcial e a coluna 0', () => {
    // Aqui as duas dificuldades se somam: a volta acontece EM CIMA da coluna de
    // 128 px. E o pedaco de codigo que o cliente e o benchmark tinham escrito
    // cada um do seu jeito.
    const camera = { lon: 355, lat: 0, fov: 60, largura: 1904, altura: 985 };
    const colunas = colunasDe(tilesVisiveis(NATIVO_5760, TILE, camera, 0));

    assert.ok(colunas.includes(11), 'faltou a coluna parcial');
    assert.ok(colunas.includes(0), 'faltou a coluna 0 do outro lado da emenda');
  });
});

describe('tilesVisiveis: a latitude', () => {
  it('abre mais colunas perto do zenite que na linha do horizonte', () => {
    // Um grau de longitude encurta com o cosseno da latitude. Perto do topo o
    // mesmo campo cobre mais coluna, e ignorar isso deixa buraco no ceu.
    const base = { lon: 120, fov: 60, largura: 1904, altura: 985 };
    const horizonte = colunasDe(tilesVisiveis(NATIVO_5760, TILE, { ...base, lat: 0 }, 0));
    const alto = colunasDe(tilesVisiveis(NATIVO_5760, TILE, { ...base, lat: 75 }, 0));
    assert.ok(alto.length > horizonte.length, 'a fov nao abriu com a latitude');
  });

  it('nao pede linha fora da grade nos polos', () => {
    for (const lat of [-90, -89, 89, 90]) {
      const camera = { lon: 120, lat, fov: 75, largura: 1904, altura: 985 };
      for (const tile of tilesVisiveis(NATIVO_5760, TILE, camera, 1)) {
        assert.ok(tile.y >= 0 && tile.y < NATIVO_5760.rows, `y ${tile.y} fora em lat ${lat}`);
      }
    }
  });
});
