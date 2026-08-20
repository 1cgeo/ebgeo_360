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
 *   - as tres escadas saem das tres resolucoes reais do acervo, 7680x3840,
 *     5760x2880 e 2048x1024, com o tile de 512 que o piloto usa;
 *   - os 6119 px e os 4264 px de largura necessaria foram medidos em Chrome, e
 *     ancoram a conta pela fov HORIZONTAL. Uma conta pela vertical daria 4728 na
 *     primeira tela, e escolheria um nivel abaixo do necessario.
 *
 * O teste nao repete a formula que deveria estar conferindo. Onde a conta antiga
 * errava, este arquivo escreve a conta antiga a mao e exige que ela DISCORDE.
 *
 * A ESCADA MUDOU EM 2026-08-18, e este arquivo mudou junto. Ate aqui ela parava
 * em LARGURA_MINIMA_NIVEL, e o primeiro quadro vinha do `preview_webp`, um
 * segundo dado ao lado da piramide. Agora ela desce ate o nivel caber em UM
 * TILE, entao o nivel 0 E o preview e a piramide basta sozinha. Os testes que
 * fixavam 3 e 4 niveis nao estavam errados: eles registravam a decisao antiga.
 *
 * O EFEITO COLATERAL QUE ASSUSTA. Niveis novos entram POR BAIXO, entao a
 * numeracao anda: o que era level 0 em 7680 agora e level 3. O contrato nao
 * mudou, porque level 0 continua sendo o mais grosso. O que nao pode mudar e a
 * LARGURA que cada tela escolhe, e ha teste so para isso.
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

/** As tres resolucoes reais do acervo, na escada que o piloto gera. */
const ESCADA_7680 = montarEscada(7680, 3840, TILE);
const ESCADA_5760 = montarEscada(5760, 2880, TILE);
const ESCADA_2048 = montarEscada(2048, 1024, TILE);

/** A escada fina de 7680, que e o conserto do vao entre 3840 e 7680. */
const ESCADA_7680_R16 = montarEscada(7680, 3840, TILE, 1.6);

/**
 * A escada que o dado ANTIGO tem, com a condicao de parada de antes.
 *
 * Escrita a mao de proposito. Ela e a conta que o gerador rodava ate
 * 2026-08-18, e o migrador precisa dela para saber quantos niveis entraram por
 * baixo de cada piramide ja gravada. Se `montarEscada` a reproduzisse, o teste
 * nao conferiria nada: compararia a funcao com ela mesma.
 *
 * @param {number} width - Largura nativa em pixels.
 * @param {number} height - Altura nativa em pixels.
 * @param {number} tileSize - Lado do tile em pixels.
 * @param {number} [razao=2] - Fator entre um nivel e o proximo.
 * @returns {Array<{level:number,width:number,height:number,cols:number,rows:number}>}
 */
function escadaAntiga(width, height, tileSize, razao = 2) {
  const niveis = [{ width, height }];
  let w = width;
  let h = height;
  // A UNICA diferenca para a escada de hoje: o piso e a largura minima, e nao
  // o tile. Tudo o mais, inclusive o arredondamento, tem de ser igual.
  while (w > LARGURA_MINIMA_NIVEL) {
    const proximaW = Math.max(1, Math.round(w / razao));
    const proximaH = Math.max(1, Math.round(h / razao));
    if (proximaW >= w) break;
    w = proximaW;
    h = proximaH;
    niveis.push({ width: w, height: h });
  }
  niveis.reverse();
  return niveis.map((nivel, level) => ({
    level,
    width: nivel.width,
    height: nivel.height,
    cols: Math.ceil(nivel.width / tileSize),
    rows: Math.ceil(nivel.height / tileSize),
  }));
}

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
  it('monta 5 niveis para a panoramica de 7680x3840', () => {
    // A escada desce ate 480x240, que cabe em um tile de 512. Os numeros estao
    // escritos inteiros de proposito: o ceil da coluna e da linha e a conta que
    // o descritor publica, e o teste que a recalcula nao confere nada.
    //
    // Os dois primeiros niveis SAO NOVOS. Antes a escada parava em 1920, e o
    // primeiro quadro vinha do `preview_webp`. Eles custam 9 tiles por foto.
    assert.deepEqual(ESCADA_7680, [
      { level: 0, width: 480, height: 240, cols: 1, rows: 1 },
      { level: 1, width: 960, height: 480, cols: 2, rows: 1 },
      { level: 2, width: 1920, height: 960, cols: 4, rows: 2 },
      { level: 3, width: 3840, height: 1920, cols: 8, rows: 4 },
      { level: 4, width: 7680, height: 3840, cols: 15, rows: 8 },
    ]);
  });

  it('monta 5 niveis para a panoramica de 5760x2880', () => {
    assert.deepEqual(ESCADA_5760, [
      { level: 0, width: 360, height: 180, cols: 1, rows: 1 },
      { level: 1, width: 720, height: 360, cols: 2, rows: 1 },
      { level: 2, width: 1440, height: 720, cols: 3, rows: 2 },
      { level: 3, width: 2880, height: 1440, cols: 6, rows: 3 },
      { level: 4, width: 5760, height: 2880, cols: 12, rows: 6 },
    ]);
  });

  it('monta 3 niveis para a panoramica de 2048x1024', () => {
    // O TERCEIRO FORMATO do acervo, com 828 fotos. Ele e o caso extremo da
    // decisao: pela regra antiga ele tinha UM nivel so, e agora tem tres. E
    // tambem o unico formato cujo nivel 0 mede o tile exato, 512x256.
    assert.deepEqual(ESCADA_2048, [
      { level: 0, width: 512, height: 256, cols: 1, rows: 1 },
      { level: 1, width: 1024, height: 512, cols: 2, rows: 1 },
      { level: 2, width: 2048, height: 1024, cols: 4, rows: 2 },
    ]);
  });

  it('desce ate o nivel 0 caber em UM TILE, em todo formato e toda razao', () => {
    // O TESTE QUE FIXA A DECISAO NOVA. A piramide tem de bastar sozinha para o
    // `full_webp` e o `preview_webp` serem apagados, e bastar sozinha quer dizer
    // ter um nivel que entra numa requisicao so. Nivel 0 com cols 1 e rows 1 e a
    // definicao disso.
    //
    // Ele REPROVA a parada antiga, e o formato que o prova e o 2048: pela regra
    // de LARGURA_MINIMA_NIVEL a escada de 2048 tinha um nivel so, de 4 por 2
    // tiles. Oito tiles nao sao um preview.
    const casos = [
      ['7680 razao 2', ESCADA_7680],
      ['5760 razao 2', ESCADA_5760],
      ['2048 razao 2', ESCADA_2048],
      ['7680 razao 1,6', ESCADA_7680_R16],
      ['5760 razao 1,6', montarEscada(5760, 2880, TILE, 1.6)],
      ['2048 razao 1,6', montarEscada(2048, 1024, TILE, 1.6)],
    ];
    for (const [nome, escada] of casos) {
      assert.equal(escada[0].cols, 1, `${nome}: nivel 0 com ${escada[0].cols} colunas`);
      assert.equal(escada[0].rows, 1, `${nome}: nivel 0 com ${escada[0].rows} linhas`);
      assert.ok(escada[0].width <= TILE, `${nome}: nivel 0 mede ${escada[0].width} px`);
    }

    // A regra antiga, escrita a mao, para o teste REPROVAR ela. Em 2048 ela para
    // no proprio nativo, que ocupa 8 tiles. Se alguem devolver o piso de largura
    // ao lugar do tile, esta linha passa a concordar com a de cima e o teste cai.
    const antiga2048 = escadaAntiga(2048, 1024, TILE);
    assert.equal(antiga2048.length, 1);
    assert.equal(antiga2048[0].cols * antiga2048[0].rows, 8, 'a parada antiga cabia em um tile');
  });

  it('a parada acompanha o TILE, e nao um numero solto', () => {
    // POR QUE A CONDICAO E `w > tileSize`. Se ela fosse uma constante nova, a
    // escada continuaria certa hoje e erraria no dia em que o tile mudasse. Com
    // tile de 256 a escada desce mais, com tile de 1024 desce menos, e isso vale
    // nos tres formatos. Uma constante escondida daria sempre a mesma escada.
    const alturas = { 7680: 3840, 5760: 2880, 2048: 1024 };
    const razoes = { 7680: 1.6, 5760: 2, 2048: 2 };

    for (const largura of [7680, 5760, 2048]) {
      const altura = alturas[largura];
      const razao = razoes[largura];
      const fino = montarEscada(largura, altura, 256, razao);
      const medio = montarEscada(largura, altura, 512, razao);
      const grosso = montarEscada(largura, altura, 1024, razao);

      assert.ok(fino.length > medio.length, `tile 256 nao desceu mais em ${largura}`);
      assert.ok(grosso.length < medio.length, `tile 1024 nao desceu menos em ${largura}`);

      // Quantos degraus entram nao e livre: e o quanto o tile andou, na razao da
      // escada. Halvar o tile vale um degrau na razao 2 e dois na razao 1,6, e
      // por isso a contagem exata nao serve de asercao geral.
      const passos = Math.log(2) / Math.log(razao);
      assert.equal(fino.length - medio.length, Math.ceil(passos),
        `tile 256 em ${largura} nao andou os degraus da razao ${razao}`);

      // E o nivel 0 continua cabendo em um tile nos tres tamanhos, que e a
      // propriedade, e nao a contagem de niveis.
      for (const [tile, escada] of [[256, fino], [512, medio], [1024, grosso]]) {
        assert.equal(escada[0].cols, 1, `tile ${tile} em ${largura}: nivel 0 nao coube`);
        assert.equal(escada[0].rows, 1, `tile ${tile} em ${largura}: nivel 0 nao coube`);
        assert.ok(escada[0].width <= tile, `tile ${tile} em ${largura}: nivel 0 passou do tile`);
      }
    }

    // Os numeros medidos de 7680 com razao 1,6, para o teste falhar com um
    // numero na mao em vez de so com uma contagem. A cauda de 1875 para cima e
    // a MESMA nos tres tiles: mexer no tile so acrescenta degrau por baixo.
    assert.deepEqual(montarEscada(7680, 3840, 256, 1.6).map(n => n.width),
      [179, 286, 458, 733, 1172, 1875, 3000, 4800, 7680]);
    assert.deepEqual(montarEscada(7680, 3840, 512, 1.6).map(n => n.width),
      [458, 733, 1172, 1875, 3000, 4800, 7680]);
    assert.deepEqual(montarEscada(7680, 3840, 1024, 1.6).map(n => n.width),
      [733, 1172, 1875, 3000, 4800, 7680]);
  });

  it('numera do mais grosso ao nativo, dobrando a cada degrau', () => {
    for (const escada of [ESCADA_7680, ESCADA_5760, ESCADA_2048]) {
      escada.forEach((nivel, i) => {
        assert.equal(nivel.level, i);
        if (i > 0) {
          assert.equal(nivel.width, escada[i - 1].width * 2);
          assert.equal(nivel.height, escada[i - 1].height * 2);
        }
      });
    }
  });

  it('nao desce quando a nativa ja cabe no tile', () => {
    // O piso continua existindo: uma foto que ja entra num tile nao ganha nivel
    // nenhum. E o caso degenerado da regra nova, e ele fecha o intervalo.
    assert.deepEqual(montarEscada(512, 256, TILE),
      [{ level: 0, width: 512, height: 256, cols: 1, rows: 1 }]);
    assert.deepEqual(montarEscada(300, 150, TILE),
      [{ level: 0, width: 300, height: 150, cols: 1, rows: 1 }]);
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
  it('monta 7 niveis em 7680 com razao 1,6', () => {
    // OS NUMEROS SAO O ORCAMENTO, e nao a formula reescrita. Eles saem de
    // custoDaEscada() rodado antes de gerar um byte, e sao o que decide a razao
    // do acervo. Escrever inteiros aqui e o unico jeito de o teste reprovar uma
    // mudanca de arredondamento.
    //
    // Os tres primeiros niveis SAO NOVOS, e custam 9 tiles por foto. A cauda de
    // 1875 para cima e byte a byte a do piloto ja gerado: acrescentar por baixo
    // nao pode mexer no que ja esta gravado.
    assert.deepEqual(ESCADA_7680_R16, [
      { level: 0, width: 458, height: 229, cols: 1, rows: 1 },
      { level: 1, width: 733, height: 366, cols: 2, rows: 1 },
      { level: 2, width: 1172, height: 586, cols: 3, rows: 2 },
      { level: 3, width: 1875, height: 938, cols: 4, rows: 2 },
      { level: 4, width: 3000, height: 1500, cols: 6, rows: 3 },
      { level: 5, width: 4800, height: 2400, cols: 10, rows: 5 },
      { level: 6, width: 7680, height: 3840, cols: 15, rows: 8 },
    ]);

    // Os 9 tiles novos, contados. E o custo do preview embutido, por foto.
    const novos = ESCADA_7680_R16.slice(0, 3);
    assert.equal(novos.reduce((soma, n) => soma + n.cols * n.rows, 0), 9);
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

describe('LARGURA_MINIMA_NIVEL: ler o dado ANTIGO', () => {
  // POR QUE A CONSTANTE SOBREVIVE A DECISAO QUE A APOSENTOU. O acervo tem
  // piramides gravadas com a parada antiga, e o migrador precisa saber quantos
  // niveis entram por baixo de cada uma. Sem este numero ele teria de adivinhar,
  // e adivinhar errado nao da erro: da tile pedido no nivel errado.

  it('continua exportado, com o valor que o dado antigo usou', () => {
    assert.equal(LARGURA_MINIMA_NIVEL, 2048);
  });

  it('reproduz a escada velha: 4 niveis em 7680, 3 em 5760, 1 em 2048', () => {
    // As tres escadas do dado ja gravado, escritas inteiras. Elas sao o ALVO da
    // migracao, e nao um historico decorativo.
    assert.deepEqual(escadaAntiga(7680, 3840, TILE, 1.6).map(n => n.width),
      [1875, 3000, 4800, 7680]);
    assert.deepEqual(escadaAntiga(5760, 2880, TILE, 2).map(n => n.width),
      [1440, 2880, 5760]);
    assert.deepEqual(escadaAntiga(2048, 1024, TILE, 2).map(n => n.width),
      [2048]);

    // A razao 2 em 7680 tambem existe no acervo, do primeiro piloto.
    assert.deepEqual(escadaAntiga(7680, 3840, TILE, 2).map(n => n.width),
      [1920, 3840, 7680]);
  });

  it('a escada velha e SUFIXO da nova, entao a migracao e so um deslocamento', () => {
    // O FATO QUE O MIGRADOR USA. Os niveis novos entram por baixo, e nenhum
    // nivel antigo muda de largura, de cols ou de rows: so muda o NUMERO. Entao
    // `level novo = level antigo + deslocamento`, e o deslocamento e a diferenca
    // de tamanho das duas escadas.
    //
    // Se a escada nova deixasse de conter a velha, esta asercao cai, e ela tem
    // de cair: seria uma grade diferente, e o dado gravado viraria lixo.
    const casos = [
      ['7680 razao 1,6', 7680, 3840, 1.6, 3],
      ['5760 razao 2', 5760, 2880, 2, 2],
      ['2048 razao 2', 2048, 1024, 2, 2],
      ['7680 razao 2', 7680, 3840, 2, 2],
    ];

    for (const [nome, w, h, razao, deslocamentoEsperado] of casos) {
      const velha = escadaAntiga(w, h, TILE, razao);
      const nova = montarEscada(w, h, TILE, razao);
      const deslocamento = nova.length - velha.length;

      assert.equal(deslocamento, deslocamentoEsperado, `${nome}: deslocamento ${deslocamento}`);

      velha.forEach((antigo, i) => {
        const novo = nova[i + deslocamento];
        assert.equal(novo.level, antigo.level + deslocamento, `${nome}: nivel ${i} nao andou junto`);
        assert.equal(novo.width, antigo.width, `${nome}: largura mudou no nivel ${i}`);
        assert.equal(novo.height, antigo.height, `${nome}: altura mudou no nivel ${i}`);
        assert.equal(novo.cols, antigo.cols, `${nome}: cols mudou no nivel ${i}`);
        assert.equal(novo.rows, antigo.rows, `${nome}: rows mudou no nivel ${i}`);
      });
    }
  });

  it('o nativo continua sendo o ULTIMO nivel nas duas escadas', () => {
    // O contrato nao mudou: level 0 e o mais grosso e o ultimo e o nativo. O que
    // mudou foi quantos degraus existem antes do nativo.
    for (const [w, h, razao] of [[7680, 3840, 1.6], [5760, 2880, 2], [2048, 1024, 2]]) {
      const velha = escadaAntiga(w, h, TILE, razao);
      const nova = montarEscada(w, h, TILE, razao);
      assert.equal(velha[velha.length - 1].width, w);
      assert.equal(nova[nova.length - 1].width, w);
      assert.equal(nova[0].level, 0);
    }
  });
});

describe('custoDaEscada', () => {
  it('da 1 para a escada de um nivel so', () => {
    // Um nivel e o proprio nativo, entao nao ha nada acima do custo de servir a
    // foto inteira. A foto de um nivel so agora e a que ja cabe num tile: pela
    // regra antiga era a de 2048, e ela passou a ter tres niveis.
    assert.equal(custoDaEscada(montarEscada(512, 256, TILE)), 1);
  });

  it('bate com a soma de areas dividida pela area nativa', () => {
    // A definicao, conferida contra a implementacao na escada de 7 niveis.
    const soma = ESCADA_7680_R16.reduce((total, n) => total + n.width * n.height, 0);
    assert.equal(soma, 48329902);
    assert.equal(custoDaEscada(ESCADA_7680_R16), soma / (7680 * 3840));
  });

  it('cobra 1,33x na razao 2 e 1,64x na razao 1,6', () => {
    // O 1,33203125 e exato: 1 + 1/4 + 1/16 + 1/64 + 1/256 na progressao
    // geometrica de area. O custo MEDIDO e maior, porque tile pequeno comprime
    // pior por pixel (no museu_cms a razao 2 deu 1,55 medido contra 1,3125
    // teorico, na escada de tres niveis).
    assert.equal(custoDaEscada(ESCADA_7680), 1.33203125);
    assert.equal(custoDaEscada(ESCADA_5760), 1.33203125);
    assert.equal(custoDaEscada(ESCADA_2048), 1.3125);
    assert.ok(Math.abs(custoDaEscada(ESCADA_7680_R16) - 1.63879) < 1e-5);
  });

  it('cobra o orcamento que autorizou a descida: +2,2%, +1,5% e +31,3%', () => {
    // O NUMERO QUE O CHEFE APROVOU, medido antes de gerar. Descer ate um tile
    // custa area a mais, e o orcamento e por formato porque cada um ganha um
    // numero diferente de degraus. Em 2048 sao 31,3% porque aquele formato tinha
    // UM nivel so, e o denominador e pequeno; sao 828 fotos.
    const acrescimo = (w, h, razao) =>
      custoDaEscada(montarEscada(w, h, TILE, razao))
      / custoDaEscada(escadaAntiga(w, h, TILE, razao)) - 1;

    assert.ok(Math.abs(acrescimo(7680, 3840, 1.6) - 0.022) < 5e-4,
      `7680 razao 1,6: ${acrescimo(7680, 3840, 1.6)}`);
    assert.ok(Math.abs(acrescimo(5760, 2880, 2) - 0.015) < 5e-4,
      `5760 razao 2: ${acrescimo(5760, 2880, 2)}`);
    assert.ok(Math.abs(acrescimo(2048, 1024, 2) - 0.3125) < 5e-4,
      `2048 razao 2: ${acrescimo(2048, 1024, 2)}`);
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
    // entre 3840 e 7680. Todo viewport satura no nativo, entao os degraus
    // grossos da escada nao economizam nada para quem esta olhando.
    assert.ok(NOTEBOOK > 3840 && NOTEBOOK < 7680, `4264 saiu do vao: ${NOTEBOOK}`);
    assert.ok(MONITOR > 3840 && MONITOR < 7680, `6119 saiu do vao: ${MONITOR}`);

    const nivel = escolherNivel(ESCADA_7680, NOTEBOOK);
    assert.equal(nivel, 4);
    assert.equal(ESCADA_7680[nivel].width, 7680);
    assert.ok(7680 / NOTEBOOK > 1.8, `desperdicio de largura menor que 80%: ${7680 / NOTEBOOK}`);
  });

  it('a razao 1,6 leva o notebook a 4800, e nao ao nativo', () => {
    // O CONSERTO, e este e o teste que o prova. O degrau de 4800 cobre os 4264
    // pedidos com 13% de folga, contra os 80% da escada classica. Em area isso e
    // 2,56 vezes menos pixel para a mesma tela.
    //
    // O NIVEL VIROU 5, e antes era 2: os tres degraus novos empurraram a
    // numeracao. A LARGURA continua 4800, e e ela que decide o que o navegador
    // baixa. O teste abaixo, "a numeracao anda, a largura nao", guarda isso.
    const nivel = escolherNivel(ESCADA_7680_R16, NOTEBOOK);
    assert.equal(nivel, 5);
    assert.equal(ESCADA_7680_R16[nivel].width, 4800);
    assert.notEqual(ESCADA_7680_R16[nivel].width, 7680);
    assert.ok(4800 / NOTEBOOK < 1.13, `folga acima de 13%: ${4800 / NOTEBOOK}`);
  });

  it('o monitor de 1904x985 continua no nativo, e esta certo', () => {
    // 4800 nao cobre 6119, entao a tela grande pede mesmo o nivel nativo. A
    // escada fina conserta o notebook sem mentir para o monitor.
    const nivel = escolherNivel(ESCADA_7680_R16, MONITOR);
    assert.equal(nivel, 6);
    assert.equal(ESCADA_7680_R16[nivel].width, 7680);
  });

  it('a numeracao anda, a LARGURA escolhida nao', () => {
    // O TESTE QUE PROTEGE O CLIENTE. Acrescentar nivel por baixo empurra o
    // indice, e quem confundir indice com resolucao passa a servir 458 px onde
    // servia 1875. Aqui a escada antiga e a nova escolhem para as mesmas telas, e
    // a asercao e sobre a LARGURA, nunca sobre o numero.
    const casos = [
      ['7680 razao 1,6', 7680, 3840, 1.6],
      ['5760 razao 2', 5760, 2880, 2],
      ['2048 razao 2', 2048, 1024, 2],
      ['7680 razao 2', 7680, 3840, 2],
    ];

    for (const [nome, w, h, razao] of casos) {
      const velha = escadaAntiga(w, h, TILE, razao);
      const nova = montarEscada(w, h, TILE, razao);

      for (const tela of [NOTEBOOK, MONITOR]) {
        const larguraVelha = velha[escolherNivel(velha, tela)].width;
        const larguraNova = nova[escolherNivel(nova, tela)].width;
        assert.equal(larguraNova, larguraVelha,
          `${nome}: a tela de ${Math.round(tela)} px mudou de ${larguraVelha} para ${larguraNova}`);
      }
    }

    // O caso nomeado, cravado: o notebook pede perto de 4264 px e cai em 4800 na
    // razao 1,6, antes e depois. So o indice mudou, de 2 para 5.
    assert.equal(ESCADA_7680_R16[escolherNivel(ESCADA_7680_R16, NOTEBOOK)].width, 4800);
    const velha7680 = escadaAntiga(7680, 3840, TILE, 1.6);
    assert.equal(velha7680[escolherNivel(velha7680, NOTEBOOK)].width, 4800);
    assert.equal(escolherNivel(velha7680, NOTEBOOK), 2);
    assert.equal(escolherNivel(ESCADA_7680_R16, NOTEBOOK), 5);
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
    // O problema e SO dos 7680. Em 5760 o degrau abaixo do nativo mede 2880, e o
    // monitor de 6119 satura no nativo porque a foto acabou, e nao porque a
    // escada e grossa. Mudar a razao aqui so gastaria disco.
    assert.equal(escolherNivel(ESCADA_5760, MONITOR), 4);
    assert.equal(ESCADA_5760[4].width, 5760);
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
    // 3840 nao cobre 6119, entao a tela de 1904x985 pede mesmo o nivel nativo.
    // O indice virou 4 com os dois degraus novos; a largura continua 7680.
    const nivel = escolherNivel(ESCADA_7680, larguraNecessaria(1904, 985, 75));
    assert.equal(nivel, 4);
    assert.equal(ESCADA_7680[nivel].width, 7680);
  });

  it('escolhe o menor nivel que cobre, e nao o primeiro que passa perto', () => {
    // As bordas de cada degrau da escada nova de 7680: 480, 960, 1920, 3840 e
    // 7680. A asercao anda de um em um pixel em volta de cada borda, porque um
    // `>` no lugar de `>=` erraria exatamente ali e em lugar nenhum mais.
    assert.equal(escolherNivel(ESCADA_7680, 1), 0);
    assert.equal(escolherNivel(ESCADA_7680, 480), 0);
    assert.equal(escolherNivel(ESCADA_7680, 481), 1);
    assert.equal(escolherNivel(ESCADA_7680, 960), 1);
    assert.equal(escolherNivel(ESCADA_7680, 961), 2);
    assert.equal(escolherNivel(ESCADA_7680, 1000), 2);
    assert.equal(escolherNivel(ESCADA_7680, 1920), 2);
    assert.equal(escolherNivel(ESCADA_7680, 1921), 3);
    assert.equal(escolherNivel(ESCADA_7680, 3840), 3);
    assert.equal(escolherNivel(ESCADA_7680, 3841), 4);
  });

  it('o nivel 0 responde a tela pequena, e ele cabe em um tile', () => {
    // O GANHO DA DECISAO, do lado do cliente. Uma tela minuscula, ou o primeiro
    // quadro antes de a camera assentar, pede pouco e recebe UM tile. Era isso
    // que o `preview_webp` fazia, e e por isso que ele pode ser apagado.
    assert.equal(escolherNivel(ESCADA_7680, 400), 0);
    assert.equal(escolherNivel(ESCADA_5760, 300), 0);
    assert.equal(escolherNivel(ESCADA_2048, 500), 0);

    for (const escada of [ESCADA_7680, ESCADA_5760, ESCADA_2048, ESCADA_7680_R16]) {
      assert.equal(escada[0].cols * escada[0].rows, 1);
    }
  });

  it('satura no nativo em vez de pedir nivel que nao existe', () => {
    // Monitor 5K com fov estreita pede mais pixel do que a foto tem. A resposta
    // e o nativo, nunca um level fora da escada, que viraria 400 na rota.
    const nativo = ESCADA_5760.length - 1;
    assert.equal(escolherNivel(ESCADA_5760, 99999), nativo);
    assert.equal(escolherNivel(ESCADA_5760, ESCADA_5760[nativo].width + 1), nativo);
    assert.equal(ESCADA_5760[nativo].width, 5760);
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
