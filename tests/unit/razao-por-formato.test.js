/**
 * @module tests/unit/razao-por-formato.test
 * @description Testa a DECISAO 2: a escada boa e por FORMATO. Um projeto de
 * 7680 de largura nasce com razao 1,6, e um de 5760 nasce com razao 2. O
 * `--razao` da linha de comando vence os dois.
 *
 * POR QUE UM ARQUIVO PROPRIO, e nao mais um describe em pyramid-math.test.js.
 * Aquele arquivo testa a GEOMETRIA, que e pura e nao tem opiniao. Este testa uma
 * POLITICA, que muda quando o acervo mudar de camera: separados, uma revisao da
 * politica nao mexe no arquivo que guarda a conta.
 *
 * ONDE A FUNCAO TEM DE MORAR. Em `pyramid-math.js`, junto de `montarEscada`.
 * `scripts/generate-tiles.js` roda `principal()` no topo do modulo, entao
 * importa-lo de um teste dispararia a rodada de geracao: uma escolha escondida la
 * dentro NAO E TESTAVEL, e o valor que decide o acervo inteiro nao pode ser o
 * unico numero sem prova.
 *
 * O segundo bloco NAO depende dessa funcao. Ele mede, na propria escada, a
 * afirmacao que sustenta a decisao: nos 5760 a razao fina escolhe o MESMO nivel
 * que a classica para as duas telas medidas, e so custa armazenamento.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
// Import de NAMESPACE, e nao nomeado. A funcao de escolha ainda pode nao estar
// exportada, e um import nomeado de algo ausente estoura o arquivo inteiro no
// carregamento: os testes que NAO dependem dela deixariam de rodar junto.
import * as MATEMATICA from '../../public/calibration/js/pyramid-math.js';

const {
  RAZAO_PADRAO,
  montarEscada,
  custoDaEscada,
  larguraNecessaria,
  escolherNivel,
} = MATEMATICA;

const TILE = 512;

/** A razao que a decisao 2 manda usar nos 7680. @constant {number} */
const RAZAO_FINA = 1.6;

/**
 * Nomes sob os quais o teste aceita a funcao de escolha.
 *
 * A lista existe para uma diferenca de nome nao reprovar a politica certa. Ela
 * NAO e um fallback silencioso: se nenhum casar, o teste-porteira falha alto.
 * @constant {string[]}
 */
const NOMES_ACEITOS = ['razaoParaLargura', 'razaoDoFormato', 'escolherRazao', 'razaoPara'];

const NOME_ENCONTRADO = NOMES_ACEITOS.find(n => typeof MATEMATICA[n] === 'function') ?? null;
const escolherRazao = NOME_ENCONTRADO ? MATEMATICA[NOME_ENCONTRADO] : null;

/** Motivo do skip quando a funcao nao esta exportada, ou `false` quando esta. */
const SEM_FUNCAO = escolherRazao
  ? false
  : `pyramid-math.js nao exporta a escolha de razao (tentados: ${NOMES_ACEITOS.join(', ')})`;

/** Motivo do skip quando a funcao nao aceita a razao explicita. */
const SEM_EXPLICITA = SEM_FUNCAO || (escolherRazao.length >= 2
  ? false
  : `${NOME_ENCONTRADO} tem aridade ${escolherRazao.length}: a razao explicita nao passa por ela`);

describe('a escolha da razao por formato', () => {
  it('mora em pyramid-math.js e recebe a razao explicita', () => {
    // A PORTEIRA. Ela falha, e nao pula, porque a decisao 2 vale para o acervo
    // inteiro: um numero que decide quantos gigabytes serao gerados precisa de
    // prova, e prova exige alcance. Os casos abaixo pulam com motivo declarado
    // para o relatorio mostrar UMA falha acionavel, e nao quatro copias dela.
    assert.ok(
      escolherRazao,
      'A decisao 2 (escada por formato) nao esta testavel. Exporte de '
      + 'public/calibration/js/pyramid-math.js uma funcao `razaoParaLargura(largura, explicita)` '
      + 'que devolva 1.6 em 7680, RAZAO_PADRAO em 5760, e a explicita quando ela vier. '
      + 'Ela NAO pode ficar so em scripts/generate-tiles.js: aquele modulo roda '
      + 'principal() no topo, entao importa-lo de um teste dispara a geracao.',
    );
    assert.ok(
      escolherRazao.length >= 2,
      `${NOME_ENCONTRADO} precisa aceitar a razao explicita como segundo parametro. `
      + 'Com aridade 1 a precedencia fica dentro do parse da linha de comando, '
      + 'que nenhum teste alcanca sem rodar o gerador.',
    );
  });

  it('da 1,6 nos 7680, que e o formato do vao', { skip: SEM_FUNCAO }, () => {
    // O 7680 e o unico formato com defeito medido: as telas pedem entre 4264 e
    // 6119 px, e a escada de razao 2 so oferece 3840 ou 7680. Todo viewport
    // satura no nativo.
    assert.equal(escolherRazao(7680), RAZAO_FINA);
  });

  it('da 2 nos 5760, e nao a razao fina', { skip: SEM_FUNCAO }, () => {
    // Nos 5760 a escada classica ja casa com a largura util das telas. A razao
    // fina la nao escolheria nivel menor nenhum: so gastaria disco. O segundo
    // bloco deste arquivo mede isso.
    assert.equal(escolherRazao(5760), RAZAO_PADRAO);
    assert.equal(escolherRazao(5760), 2);
    assert.notEqual(escolherRazao(5760), RAZAO_FINA);
  });

  it('a razao explicita vence os DOIS formatos', { skip: SEM_EXPLICITA }, () => {
    // A PRECEDENCIA. Quem passa `--razao 1.4` esta orcando uma escada, e o
    // padrao por formato nao pode sobrescrever o pedido em silencio: o sintoma
    // seria um acervo gerado com outra grade, descoberto semanas depois.
    for (const largura of [7680, 5760]) {
      assert.equal(escolherRazao(largura, 1.4), 1.4, `largura ${largura} ignorou --razao 1.4`);
      assert.equal(escolherRazao(largura, 2), 2, `largura ${largura} ignorou --razao 2`);
      assert.equal(escolherRazao(largura, 1.6), 1.6, `largura ${largura} ignorou --razao 1.6`);
    }
  });

  it('cai no padrao por formato quando a explicita nao vem', { skip: SEM_EXPLICITA }, () => {
    // `null` e `undefined` sao os dois jeitos de "o operador nao pediu nada".
    assert.equal(escolherRazao(7680, null), RAZAO_FINA);
    assert.equal(escolherRazao(7680, undefined), RAZAO_FINA);
    assert.equal(escolherRazao(5760, null), RAZAO_PADRAO);
    assert.equal(escolherRazao(5760, undefined), RAZAO_PADRAO);
  });

  it('a escolha de cada formato monta a escada que a decisao nomeia', { skip: SEM_FUNCAO }, () => {
    // A LIGACAO COM O DADO GRAVADO. A funcao devolve um numero, e quem sofre a
    // consequencia e a grade. Os literais sao a escada do piloto ja provado
    // (1875/3000/4800/7680) e a escada classica dos 5760.
    assert.deepEqual(montarEscada(7680, 3840, TILE, escolherRazao(7680)), [
      { level: 0, width: 1875, height: 938, cols: 4, rows: 2 },
      { level: 1, width: 3000, height: 1500, cols: 6, rows: 3 },
      { level: 2, width: 4800, height: 2400, cols: 10, rows: 5 },
      { level: 3, width: 7680, height: 3840, cols: 15, rows: 8 },
    ]);

    assert.deepEqual(montarEscada(5760, 2880, TILE, escolherRazao(5760)), [
      { level: 0, width: 1440, height: 720, cols: 3, rows: 2 },
      { level: 1, width: 2880, height: 1440, cols: 6, rows: 3 },
      { level: 2, width: 5760, height: 2880, cols: 12, rows: 6 },
    ]);
  });
});

describe('decisao 2 medida na escada, sem depender da funcao de escolha', () => {
  // As duas telas MEDIDAS em Chrome. Elas ancoram a decisao inteira: sem elas,
  // "a escada casa com a tela" seria opiniao.
  const NOTEBOOK = larguraNecessaria(1350, 673, 75);
  const MONITOR = larguraNecessaria(1904, 985, 75);

  const E5760_R2 = montarEscada(5760, 2880, TILE, 2);
  const E5760_R16 = montarEscada(5760, 2880, TILE, 1.6);
  const E7680_R2 = montarEscada(7680, 3840, TILE, 2);
  const E7680_R16 = montarEscada(7680, 3840, TILE, 1.6);

  /**
   * Largura do nivel que uma escada escolhe para uma tela.
   * @param {Array<{level:number,width:number}>} escada - Saida de montarEscada.
   * @param {number} necessaria - Saida de larguraNecessaria.
   * @returns {number} Largura em pixels do nivel escolhido.
   */
  const larguraEscolhida = (escada, necessaria) => escada[escolherNivel(escada, necessaria)].width;

  it('nos 7680 a razao fina ENTREGA nivel menor no notebook', () => {
    // O ganho que paga o disco: 4800 no lugar de 7680, ou seja 2,56 vezes menos
    // pixel na mesma tela.
    assert.equal(larguraEscolhida(E7680_R2, NOTEBOOK), 7680);
    assert.equal(larguraEscolhida(E7680_R16, NOTEBOOK), 4800);
  });

  it('nos 5760 a razao fina escolhe o MESMO nivel das duas telas', () => {
    // O CASO QUE DECIDE A DECISAO 2. As duas escadas mandam as duas telas ao
    // nativo de 5760: a classica porque a foto acabou, a fina tambem. Nenhum
    // degrau novo entra entre a demanda e o nativo.
    for (const tela of [NOTEBOOK, MONITOR]) {
      assert.equal(larguraEscolhida(E5760_R16, tela), larguraEscolhida(E5760_R2, tela));
      assert.equal(larguraEscolhida(E5760_R2, tela), 5760);
    }
  });

  it('nos 5760 a razao fina so acrescenta armazenamento', () => {
    // O PRECO, medido em area antes de gerar um byte. 1,60x contra 1,3125x, ou
    // seja 22% a mais de piramide, e um nivel a mais para manter, em troca de
    // nada que a tela use.
    assert.equal(custoDaEscada(E5760_R2), 1.3125);
    assert.ok(Math.abs(custoDaEscada(E5760_R16) - 1.6028) < 1e-4,
      `custo da escada fina em 5760: ${custoDaEscada(E5760_R16)}`);
    assert.equal(E5760_R16.length, E5760_R2.length + 1);

    // O degrau extra e o de 3600 px, e ele cai ACIMA das duas telas medidas: por
    // isso ninguem o pede. Se uma tela futura pedir menos que 3600, esta linha
    // continua verdadeira e a decisao 2 precisa ser reaberta a mao.
    assert.ok(E5760_R16.some(n => n.width === 3600));
    assert.ok(NOTEBOOK > 3600, `o notebook passou a caber em 3600: ${NOTEBOOK}`);
  });
});
