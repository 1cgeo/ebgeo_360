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
 * afirmacao que sustenta a decisao: nos 5760 a razao fina escolhe a MESMA
 * largura que a classica para as duas telas medidas, e so custa armazenamento.
 *
 * A ESCADA MUDOU EM 2026-08-18, e este arquivo mudou junto. Ela agora desce ate
 * o nivel caber em um tile, entao entraram degraus POR BAIXO e a numeracao
 * andou. A POLITICA que este arquivo testa nao mudou: 1,6 nos 7680 e 2 no resto.
 * Por isso as asercoes daqui falam em LARGURA, e nao em indice de nivel: a
 * decisao 2 e sobre qual resolucao a tela recebe, nunca sobre o numero do level.
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
    // fina la nao escolheria largura menor nenhuma: so gastaria disco. O segundo
    // bloco deste arquivo mede isso.
    assert.equal(escolherRazao(5760), RAZAO_PADRAO);
    assert.equal(escolherRazao(5760), 2);
    assert.notEqual(escolherRazao(5760), RAZAO_FINA);
  });

  it('da 2 nos 2048, o terceiro formato do acervo', { skip: SEM_FUNCAO }, () => {
    // O acervo tem 828 fotos de 2048x1024, razao 2:1. A politica e por LARGURA,
    // entao 2048 cai na mesma faixa que 5760 e leva a razao classica. Nao ha vao
    // a fechar ali: a foto inteira e menor que qualquer tela util.
    assert.equal(escolherRazao(2048), RAZAO_PADRAO);
    assert.notEqual(escolherRazao(2048), RAZAO_FINA);
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
    // consequencia e a grade. A cauda de 1875 para cima em 7680, e de 1440 para
    // cima em 5760, e a escada do piloto ja provado. Os degraus abaixo dela sao
    // os que a decisao de 2026-08-18 acrescentou, para a piramide bastar sozinha.
    assert.deepEqual(montarEscada(7680, 3840, TILE, escolherRazao(7680)), [
      { level: 0, width: 458, height: 229, cols: 1, rows: 1 },
      { level: 1, width: 733, height: 366, cols: 2, rows: 1 },
      { level: 2, width: 1172, height: 586, cols: 3, rows: 2 },
      { level: 3, width: 1875, height: 938, cols: 4, rows: 2 },
      { level: 4, width: 3000, height: 1500, cols: 6, rows: 3 },
      { level: 5, width: 4800, height: 2400, cols: 10, rows: 5 },
      { level: 6, width: 7680, height: 3840, cols: 15, rows: 8 },
    ]);

    assert.deepEqual(montarEscada(5760, 2880, TILE, escolherRazao(5760)), [
      { level: 0, width: 360, height: 180, cols: 1, rows: 1 },
      { level: 1, width: 720, height: 360, cols: 2, rows: 1 },
      { level: 2, width: 1440, height: 720, cols: 3, rows: 2 },
      { level: 3, width: 2880, height: 1440, cols: 6, rows: 3 },
      { level: 4, width: 5760, height: 2880, cols: 12, rows: 6 },
    ]);

    assert.deepEqual(montarEscada(2048, 1024, TILE, escolherRazao(2048)), [
      { level: 0, width: 512, height: 256, cols: 1, rows: 1 },
      { level: 1, width: 1024, height: 512, cols: 2, rows: 1 },
      { level: 2, width: 2048, height: 1024, cols: 4, rows: 2 },
    ]);
  });

  it('a escolha por formato poe o preview dentro da piramide', { skip: SEM_FUNCAO }, () => {
    // A CONSEQUENCIA QUE AUTORIZA APAGAR O `preview_webp`. Seja qual for a razao
    // que a politica devolver, o nivel 0 tem de caber em UM tile. Se um formato
    // novo entrar na politica com uma razao que quebre isso, este teste cai antes
    // de alguem apagar 1,03 GB de preview.
    const formatos = [[7680, 3840], [5760, 2880], [2048, 1024]];
    for (const [largura, altura] of formatos) {
      const escada = montarEscada(largura, altura, TILE, escolherRazao(largura));
      assert.equal(escada[0].cols, 1, `${largura}: nivel 0 com ${escada[0].cols} colunas`);
      assert.equal(escada[0].rows, 1, `${largura}: nivel 0 com ${escada[0].rows} linhas`);
    }
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

  it('nos 7680 a razao fina ENTREGA largura menor no notebook', () => {
    // O ganho que paga o disco: 4800 no lugar de 7680, ou seja 2,56 vezes menos
    // pixel na mesma tela. A asercao e em LARGURA de proposito: a escada nova
    // empurrou o indice de 2 para 5, e o indice nao e o que a rede paga.
    assert.equal(larguraEscolhida(E7680_R2, NOTEBOOK), 7680);
    assert.equal(larguraEscolhida(E7680_R16, NOTEBOOK), 4800);
  });

  it('nos 5760 a razao fina escolhe a MESMA largura das duas telas', () => {
    // O CASO QUE DECIDE A DECISAO 2. As duas escadas mandam as duas telas ao
    // nativo de 5760: a classica porque a foto acabou, a fina tambem. Nenhum
    // degrau novo entra entre a demanda e o nativo.
    for (const tela of [NOTEBOOK, MONITOR]) {
      assert.equal(larguraEscolhida(E5760_R16, tela), larguraEscolhida(E5760_R2, tela));
      assert.equal(larguraEscolhida(E5760_R2, tela), 5760);
    }
  });

  it('nos 5760 a razao fina so acrescenta armazenamento', () => {
    // O PRECO, medido em area antes de gerar um byte. 1,639x contra 1,332x, ou
    // seja 23% a mais de piramide, e dois niveis a mais para manter, em troca de
    // nada que a tela use.
    //
    // OS DOIS CUSTOS SUBIRAM com a escada descendo ate um tile, e SUBIRAM JUNTOS:
    // a comparacao que decide a razao continua valendo, porque os degraus novos
    // entram nas duas escadas. Antes eram 1,6028 contra 1,3125.
    assert.equal(custoDaEscada(E5760_R2), 1.33203125);
    assert.ok(Math.abs(custoDaEscada(E5760_R16) - 1.63866) < 1e-5,
      `custo da escada fina em 5760: ${custoDaEscada(E5760_R16)}`);
    assert.ok(custoDaEscada(E5760_R16) > custoDaEscada(E5760_R2));
    assert.equal(E5760_R16.length, E5760_R2.length + 2);

    // O degrau extra util e o de 3600 px, e ele cai ACIMA das duas telas
    // medidas: por isso ninguem o pede. Se uma tela futura pedir menos que 3600,
    // esta linha continua verdadeira e a decisao 2 precisa ser reaberta a mao.
    assert.ok(E5760_R16.some(n => n.width === 3600));
    assert.ok(NOTEBOOK > 3600, `o notebook passou a caber em 3600: ${NOTEBOOK}`);
  });

  it('as duas razoes poem o nivel 0 em um tile, nos dois formatos', () => {
    // A DECISAO DE 2026-08-18 NAO DEPENDE DA RAZAO. Ela e sobre onde a escada
    // PARA, e a parada e o tile. Fixar isso aqui protege a decisao 2 de ser
    // reaberta com uma razao que devolva o `preview_webp` pela porta dos fundos.
    for (const escada of [E5760_R2, E5760_R16, E7680_R2, E7680_R16]) {
      assert.equal(escada[0].cols, 1, `nivel 0 de ${escada[0].width} px nao coube em um tile`);
      assert.equal(escada[0].rows, 1, `nivel 0 de ${escada[0].width} px nao coube em um tile`);
      assert.equal(escada[0].level, 0, 'o mais grosso deixou de ser o level 0');
    }
  });
});
