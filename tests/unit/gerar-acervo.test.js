/**
 * @module tests/unit/gerar-acervo.test
 * @description Guarda as quatro decisoes do orquestrador do acervo que uma
 * revisao adversarial reprovou, e que o juiz confirmou indo ao disco.
 *
 * CADA TESTE AQUI REPROVA UM COMPORTAMENTO QUE EXISTIA. Onde da, ele mede
 * tambem o METODO ANTIGO no mesmo caso, para deixar escrito que os dois nao
 * respondem a mesma coisa. Teste que passa dos dois jeitos e pior que teste
 * ausente.
 *
 * POR QUE ELE IMPORTA O SCRIPT. `scripts/gerar-acervo.js` passou a exportar as
 * decisoes puras e a so rodar quando chamado pela linha de comando. Antes o
 * modulo inteiro corria no import, e importa-lo de um teste dispararia 99 GB de
 * escrita: decisao escondida atras disso NAO E TESTAVEL.
 *
 * As quatro perguntas:
 *   BLOQUEADOR 3  contarPiramidesProntas: quantas piramides servem para a rodada
 *   BLOQUEADOR 4  bytesNoDisco: o gasto e do ARQUIVO, nao do drive
 *   BLOQUEADOR 5  discoNecessarioGB e podeEscrever: o piso escala e conta o que voa
 *   BLOQUEADOR 6  interpretarArgumentos: valor invalido aborta, nao vira NaN
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import {
  PARAMETROS_DA_RODADA,
  interpretarArgumentos,
  contarPiramidesProntas,
  lerPiramides,
  bytesNoDisco,
  discoNecessarioGB,
  podeEscrever,
} from '../../scripts/gerar-acervo.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const RAIZ = resolve(__dirname, '..', '..');
const FONTE_ACERVO = resolve(RAIZ, 'scripts', 'gerar-acervo.js');
const FONTE_GERADOR = resolve(RAIZ, 'scripts', 'generate-tiles.js');

/**
 * Uma linha de `tile_pyramids` como o SELECT do script a le.
 * Os padroes sao os da rodada, entao cada teste muda so o campo que interessa.
 */
function piramide(photoId, width, razao, extra = {}) {
  return {
    photo_id: photoId,
    width,
    razao,
    tile_size: PARAMETROS_DA_RODADA.tileSize,
    quality: PARAMETROS_DA_RODADA.quality,
    ...extra,
  };
}

// ============================================================
// BLOQUEADOR 3: a contagem de piramide pronta
// ============================================================

describe('contarPiramidesProntas: conta so o que esta rodada produziria', () => {
  it('nao conta piramide de foto morta, e por isso enxerga a foto nova', () => {
    // O caso exato que passava batido: a foto C levou soft-delete depois de
    // tilada, e a foto D chegou depois. As duas mudancas se cancelam na conta.
    const vivas = new Set(['A', 'B', 'D']);
    const linhas = [
      piramide('A', 5760, 2),
      piramide('B', 5760, 2),
      piramide('C', 5760, 2),
    ];

    // A medida antiga era `SELECT COUNT(*)`, ou seja o tamanho desta lista.
    assert.equal(linhas.length, vivas.size,
      'o COUNT(*) antigo empatava com as fotos vivas e dava o projeto por pronto');

    const feitas = contarPiramidesProntas(linhas, vivas);
    assert.equal(feitas, 2, 'a foto D nunca foi tilada, entao o projeto nao esta pronto');
    assert.ok(feitas < vivas.size);
  });

  it('nao conta piramide com outro tile nem com outra qualidade', () => {
    const vivas = new Set(['A', 'B']);
    const linhas = [
      piramide('A', 5760, 2, { tile_size: 1024 }),
      piramide('B', 5760, 2, { quality: 90 }),
    ];
    assert.equal(linhas.length, 2, 'o COUNT(*) antigo daria 2 e pularia o projeto');
    assert.equal(contarPiramidesProntas(linhas, vivas), 0,
      'total_bytes e o token do ETag: outra qualidade nao serve, e o cliente misturaria duas');
  });

  it('nao conta piramide cuja razao nao e a que a largura pede hoje', () => {
    // Um 7680 gravado com a escada classica. Esta rodada produziria 1,6 nele.
    const vivas = new Set(['A']);
    assert.equal(contarPiramidesProntas([piramide('A', 7680, 2)], vivas), 0);
    assert.equal(contarPiramidesProntas([piramide('A', 7680, 1.6)], vivas), 1);
  });

  it('aceita o projeto MISTO inteiro, porque a razao e por foto', () => {
    // blumenau, santiago, tubarao e santana_livramento tem dois formatos na
    // mesma pasta. Um filtro de razao unica reprovaria metade deles a cada
    // rodada, e refaria de graca trabalho bom.
    const vivas = new Set(['A', 'B', 'C']);
    const linhas = [
      piramide('A', 5760, 2),
      piramide('B', 7680, 1.6),
      piramide('C', 2048, 2),
    ];
    assert.equal(contarPiramidesProntas(linhas, vivas), 3);

    // A prova de que o filtro nao e `razao === X`: os dois valores convivem.
    const razoes = new Set(linhas.map(l => l.razao));
    assert.equal(razoes.size, 2, 'o projeto misto tem duas razoes certas ao mesmo tempo');
  });

  it('projeto sem foto viva nenhuma nao conta piramide alguma', () => {
    assert.equal(contarPiramidesProntas([piramide('A', 5760, 2)], new Set()), 0);
  });
});

describe('lerPiramides: a contagem contra um arquivo SQLite de verdade', () => {
  let dir;
  before(() => { dir = mkdtempSync(join(tmpdir(), 'gerar-acervo-db-')); });
  after(() => { rmSync(dir, { recursive: true, force: true }); });

  /** O DDL de producao, lido do arquivo. Copiar aqui seria uma segunda verdade. */
  const DDL = readFileSync(resolve(RAIZ, 'src', 'db', 'tiles-schema.sql'), 'utf8');

  /**
   * O DDL ANTES da coluna `razao`, escrito verbatim.
   * E o formato dos bancos que ja estao no disco. Se este teste lesse o arquivo
   * de src/, ele seguiria o schema novo e a regressao sumiria sem ninguem notar.
   */
  const DDL_LEGADO = `
    CREATE TABLE tile_pyramids (
      photo_id TEXT PRIMARY KEY, tile_size INTEGER NOT NULL, max_level INTEGER NOT NULL,
      width INTEGER NOT NULL, height INTEGER NOT NULL, quality INTEGER NOT NULL,
      tile_count INTEGER NOT NULL, total_bytes INTEGER NOT NULL, built_at TEXT NOT NULL);`;

  function montar(nome, ddl, fotos) {
    const caminho = join(dir, nome);
    const db = new Database(caminho);
    db.exec(ddl);
    const colunas = db.pragma('table_info(tile_pyramids)').map(c => c.name);
    const temRazao = colunas.includes('razao');
    const inserir = db.prepare(
      `INSERT INTO tile_pyramids (photo_id, tile_size, max_level, width, height, quality,
        tile_count, total_bytes, built_at${temRazao ? ', razao' : ''})
       VALUES (?, ?, 2, ?, ?, ?, 10, 1000, '2026-08-14'${temRazao ? ', ?' : ''})`);
    for (const f of fotos) {
      const base = [f.photo_id, f.tile_size ?? 512, f.width, f.width / 2, f.quality ?? 80];
      inserir.run(temRazao ? [...base, f.razao] : base);
    }
    db.close();
    return caminho;
  }

  it('o COUNT(*) antigo diz pronto, e a contagem nova reprova', () => {
    // A foto C levou soft-delete depois de tilada, e a foto D chegou depois.
    const caminho = montar('misto_tiles.db', DDL, [
      { photo_id: 'A', width: 5760, razao: 2 },
      { photo_id: 'B', width: 7680, razao: 1.6 },
      { photo_id: 'C', width: 5760, razao: 2 },
    ]);
    const vivas = new Set(['A', 'B', 'D']);
    const db = new Database(caminho, { readonly: true });
    try {
      const antigo = db.prepare('SELECT COUNT(*) c FROM tile_pyramids').get().c;
      const novo = contarPiramidesProntas(lerPiramides(db), vivas);
      assert.equal(antigo >= vivas.size, true, 'o criterio antigo daria o projeto por pronto');
      assert.equal(novo, 2);
      assert.equal(novo >= vivas.size, false, 'o criterio novo manda gerar a foto D');
    } finally {
      db.close();
    }
  });

  it('banco anterior a coluna razao continua valendo, e nao regera 99 GB', () => {
    const caminho = montar('legado_tiles.db', DDL_LEGADO, [
      { photo_id: 'A', width: 5760 },
      { photo_id: 'B', width: 5760 },
    ]);
    const db = new Database(caminho, { readonly: true });
    try {
      assert.equal(db.pragma('table_info(tile_pyramids)').some(c => c.name === 'razao'), false,
        'a fixture tem de ser mesmo um banco sem a coluna');
      const linhas = lerPiramides(db);
      assert.deepEqual(linhas.map(l => l.razao), [2, 2], 'o legado e a escada classica, pelo DEFAULT do DDL');
      assert.equal(contarPiramidesProntas(linhas, new Set(['A', 'B'])), 2);
    } finally {
      db.close();
    }
  });
});

// ============================================================
// BLOQUEADOR 4: o gasto e do arquivo, nao do drive
// ============================================================

describe('bytesNoDisco: mede o arquivo de destino', () => {
  let dir;
  before(() => { dir = mkdtempSync(join(tmpdir(), 'gerar-acervo-')); });
  after(() => { rmSync(dir, { recursive: true, force: true }); });

  /** O drive inteiro, simulado: quem cresce aqui some do "livre". */
  const ocupadoNoDiretorio = () => readdirSync(dir)
    .reduce((a, f) => a + statSync(join(dir, f)).size, 0);

  it('nao debita ao projeto a escrita do vizinho em paralelo', () => {
    const destino = join(dir, 'easa_tiles.db');
    const vizinho = join(dir, 'faxinal_tiles.db');
    writeFileSync(destino, Buffer.alloc(1000));
    writeFileSync(vizinho, Buffer.alloc(2000));

    const arquivoAntes = bytesNoDisco(destino);
    const livreAntes = -ocupadoNoDiretorio();

    // Os dois crescem ao mesmo tempo, que e o que o pool de 3 faz.
    writeFileSync(destino, Buffer.alloc(2500));
    writeFileSync(vizinho, Buffer.alloc(11000));

    const gastoMedido = bytesNoDisco(destino) - arquivoAntes;
    const gastoAntigo = livreAntes - (-ocupadoNoDiretorio());

    assert.equal(gastoMedido, 1500, 'o easa escreveu 1500 bytes, e so isso e dele');
    assert.equal(gastoAntigo, 10500,
      'a medida antiga somava o vizinho: e assim que o diario deu +107% num projeto que errou 5%');
    assert.notEqual(gastoMedido, gastoAntigo);
  });

  it('soma o -wal, porque o checkpoint pode nao ter passado', () => {
    const destino = join(dir, 'wal_tiles.db');
    writeFileSync(destino, Buffer.alloc(100));
    assert.equal(bytesNoDisco(destino), 100);
    writeFileSync(`${destino}-wal`, Buffer.alloc(50));
    assert.equal(bytesNoDisco(destino), 150, 'dado ainda no WAL e escrita real');
  });

  it('devolve 0 quando o banco ainda nao existe', () => {
    assert.equal(bytesNoDisco(join(dir, 'nunca_tiles.db')), 0);
  });
});

// ============================================================
// BLOQUEADOR 5: o piso de disco escala com o que esta em voo
// ============================================================

describe('discoNecessarioGB e podeEscrever: o piso conta os vizinhos', () => {
  /** O piso fixo da versao anterior. Ele esta aqui para ser reprovado. */
  const PISO_ANTIGO_GB = 20;
  /** O faxinal sozinho gastou isto, medido no disco. @constant {number} */
  const FAXINAL_GB = 21.2;

  it('o piso antigo nem cobria UM faxinal', () => {
    assert.ok(FAXINAL_GB > PISO_ANTIGO_GB,
      'o maior projeto do acervo passa dos 20 GB que o piso reservava');
    assert.ok(discoNecessarioGB(FAXINAL_GB) > FAXINAL_GB,
      'a reserva tem de cobrir o projeto inteiro mais folga');
  });

  it('escala com quantos projetos estao em voo', () => {
    const um = discoNecessarioGB(FAXINAL_GB);
    const tres = discoNecessarioGB(FAXINAL_GB * 3);
    assert.ok(tres > um);
    assert.ok(tres > 89 && tres < 90, `tres faxinais pedem ~89,5 GB, veio ${tres}`);
    // O piso fixo nao mudava com o paralelismo. Este e o defeito.
    assert.notEqual(tres, um);
  });

  it('sem escrita prevista sobra so a folga da maquina', () => {
    assert.equal(discoNecessarioGB(0), 10);
  });

  it('reprova o disco que o piso fixo aprovaria com tres projetos grandes', () => {
    const livre = 50;
    assert.ok(livre > PISO_ANTIGO_GB, 'a checagem antiga deixaria passar');
    assert.equal(podeEscrever(livre, FAXINAL_GB * 3), false);
    assert.equal(podeEscrever(120, FAXINAL_GB * 3), true);
  });

  it('medida de disco perdida reprova, em vez de seguir as cegas', () => {
    // `livre < piso` e falso quando livre e NaN, entao a versao anterior
    // continuava escrevendo justamente quando tinha perdido a medida do disco.
    // O NaN vem de uma conta, e nao do literal: e assim que ele chega la, e o
    // linter proibe comparar com o literal.
    const semMedida = Number.parseFloat('a saida vazia do powershell');
    assert.ok(Number.isNaN(semMedida));
    assert.equal(semMedida < PISO_ANTIGO_GB, false, 'a comparacao antiga aprovava o NaN');
    assert.equal(podeEscrever(semMedida, 1), false);
    assert.equal(podeEscrever(Infinity, 1), false);
  });
});

// ============================================================
// BLOQUEADOR 6: --ate invalido aborta
// ============================================================

describe('interpretarArgumentos: valor invalido para a rodada', () => {
  it('aborta na data que o Date nao entende', () => {
    // A versao anterior fazia `new Date(x).getTime()`, e este e o resultado.
    assert.ok(Number.isNaN(new Date('ontem a noite').getTime()));
    assert.equal(Boolean(NaN), false, 'o `if (opt.ate && ...)` sumia com a janela em silencio');

    assert.throws(() => interpretarArgumentos(['--ate', 'ontem a noite']), /--ate/);
  });

  it('aborta quando --ate vem sem valor nenhum', () => {
    assert.throws(() => interpretarArgumentos(['--ate']), /--ate/);
    assert.throws(() => interpretarArgumentos(['--ate', '--dry-run']), /--ate/);
  });

  it('aceita a data boa e guarda o instante', () => {
    const opt = interpretarArgumentos(['--ate', '2026-08-18T06:30']);
    assert.equal(opt.ate, Date.parse('2026-08-18T06:30'));
    assert.ok(Number.isFinite(opt.ate));
  });

  it('aborta no --paralelos que nao e inteiro positivo', () => {
    // `parseInt('tres', 10) || 1` devolvia 1 e mudava o plano sem avisar.
    assert.equal(parseInt('tres', 10) || 1, 1, 'a leitura antiga engolia o erro');
    assert.throws(() => interpretarArgumentos(['--paralelos', 'tres']), /--paralelos/);
    assert.throws(() => interpretarArgumentos(['--paralelos', '0']), /--paralelos/);
    assert.throws(() => interpretarArgumentos(['--paralelos', '2.5']), /--paralelos/);
    assert.equal(interpretarArgumentos(['--paralelos', '3']).paralelos, 3);
  });

  it('sem janela e sem paralelismo, os padroes ficam de pe', () => {
    const opt = interpretarArgumentos([]);
    assert.equal(opt.ate, null);
    assert.equal(opt.paralelos, 1);
    assert.equal(opt.so, null);
    assert.equal(opt.dryRun, false);
  });

  it('le as flags simples sem estragar as outras', () => {
    const opt = interpretarArgumentos(['--dry-run', '--so', 'alegrete,bage', '--workers', '6', '--maior']);
    assert.equal(opt.dryRun, true);
    assert.equal(opt.maior, true);
    assert.equal(opt.workers, '6');
    assert.deepEqual([...opt.so], ['alegrete', 'bage']);
  });
});

// ============================================================
// A copia dos parametros, e o cabecalho que descreve o script
// ============================================================

describe('o script nao mente sobre si mesmo', () => {
  it('os parametros da rodada sao os padroes do generate-tiles.js', () => {
    // A copia existe porque importar o gerador dispara a geracao. Este teste e
    // o preco dela: no dia em que o padrao mudar la, ele reprova aqui.
    const fonte = readFileSync(FONTE_GERADOR, 'utf8');
    const tile = fonte.match(/const TILE_PADRAO = (\d+);/);
    const qualidade = fonte.match(/const QUALIDADE_PADRAO = (\d+);/);
    assert.ok(tile, 'nao achei TILE_PADRAO no gerador');
    assert.ok(qualidade, 'nao achei QUALIDADE_PADRAO no gerador');
    assert.equal(PARAMETROS_DA_RODADA.tileSize, Number(tile[1]));
    assert.equal(PARAMETROS_DA_RODADA.quality, Number(qualidade[1]));
    assert.equal(PARAMETROS_DA_RODADA.razaoPedida, null,
      'a rodada nao passa --razao, entao a razao sai do formato de cada foto');
  });

  it('o cabecalho nao diz mais que o script nao paraleliza', () => {
    const fonte = readFileSync(FONTE_ACERVO, 'utf8');
    assert.doesNotMatch(fonte, /NAO FAZ:\s*paralelizar/i,
      'o --paralelos existe, e comentario que mente e pior que comentario ausente');
  });

  it('o bloco Uso lista as flags que existem', () => {
    const fonte = readFileSync(FONTE_ACERVO, 'utf8');
    const cabecalho = fonte.slice(0, fonte.indexOf('*/'));
    for (const flag of ['--dry-run', '--so', '--refazer', '--maior', '--workers', '--paralelos', '--ate']) {
      assert.ok(cabecalho.includes(flag), `o cabecalho nao cita ${flag}`);
    }
  });
});
