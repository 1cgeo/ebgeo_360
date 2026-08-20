/**
 * @module tests/unit/migrar-escada.test
 * @description Guarda a migracao das piramides ja gravadas para a escada que
 * desce ate um tile.
 *
 * O QUE ESTA EM JOGO. O acervo tem 99.035 fotos e 11.690.996 tiles bons, que
 * custaram 7,6 horas. A migracao empurra a numeracao de todos eles: o que hoje e
 * `level 0` vira 2 ou 3. Um erro aqui nao produz erro em lugar nenhum, produz
 * parede com quadrado preto e 404 no console de quem estiver olhando.
 *
 * SAO QUATRO PERGUNTAS, e cada uma reprova um jeito plausivel de errar:
 *
 *   ESCADA ANTIGA   `escadaAntiga` reusa `montarEscada` com o tile trocado pela
 *                   largura minima historica. E economico e e fragil: se a
 *                   parada de `montarEscada` mudar, ela muda de significado sem
 *                   erro. As tres escadas do acervo ficam presas aqui.
 *   PLANO           `planoDaFoto` distingue tres estados. Rodar duas vezes NAO
 *                   pode empurrar duas vezes.
 *   RENUMERACAO     a chave primaria e (photo_id, level, x, y). A ordem errada
 *                   colide, e o teste faz a colisao acontecer de verdade.
 *   RODADA INTEIRA  o script roda por linha de comando sobre um SQLite de
 *                   verdade, com WebP de verdade, e o nivel novo tem de ter
 *                   PIXEL, e nao o preto do fundo da composicao.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import sharp from 'sharp';

import {
  escadaAntiga,
  planoDaFoto,
  ordemDaRenumeracao,
  interpretarArgumentos,
  conferirProjeto,
} from '../../scripts/migrar-escada.js';
import { montarEscada } from '../../public/calibration/js/pyramid-math.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const RAIZ = resolve(__dirname, '..', '..');
const SCRIPT = resolve(RAIZ, 'scripts', 'migrar-escada.js');

/**
 * O DDL de producao, lido do arquivo.
 *
 * Copia-lo para ca criaria uma segunda verdade sobre o schema: bastaria um ALTER
 * no arquivo de src/ para o teste passar a medir outra tabela e continuar verde.
 * @constant {string}
 */
const DDL = readFileSync(resolve(RAIZ, 'src', 'db', 'tiles-schema.sql'), 'utf8');

const TILE = 512;
const QUALIDADE = 80;

/**
 * Uma linha de `tile_pyramids` como `planoDaFoto` a le.
 * @param {object} campos - O que muda em cada caso.
 * @returns {object}
 */
function piramide(campos) {
  return { tile_size: TILE, razao: 2, quality: QUALIDADE, ...campos };
}

// ============================================================
// A escada antiga do acervo, presa
// ============================================================

describe('escadaAntiga: as tres escadas que estao no disco', () => {
  // Os numeros vem do acervo medido, e nao de rodar a funcao e copiar a saida.
  // 29 projetos, 99.035 fotos, tres formatos.
  it('7680x3840 com razao 1,6 parava em quatro niveis', () => {
    const antiga = escadaAntiga(7680, 3840, TILE, 1.6);
    assert.deepEqual(antiga.map(n => n.width), [1875, 3000, 4800, 7680]);
    assert.deepEqual(antiga.map(n => n.height), [938, 1500, 2400, 3840]);
    // A grade sai com o tile de VERDADE, e nao com a largura minima que a
    // funcao emprestou para reproduzir a parada.
    assert.deepEqual(antiga.map(n => n.cols), [4, 6, 10, 15]);
    assert.deepEqual(antiga.map(n => n.rows), [2, 3, 5, 8]);
  });

  it('5760x2880 com razao 2 parava em tres niveis', () => {
    const antiga = escadaAntiga(5760, 2880, TILE, 2);
    assert.deepEqual(antiga.map(n => n.width), [1440, 2880, 5760]);
    assert.deepEqual(antiga.map(n => n.cols), [3, 6, 12]);
  });

  it('2048x1024 com razao 2 parava num nivel so, o proprio nativo', () => {
    const antiga = escadaAntiga(2048, 1024, TILE, 2);
    assert.deepEqual(antiga.map(n => n.width), [2048]);
    // Sao 828 fotos, e o unico formato em que a piramide nao economizava nada.
    assert.equal(antiga.length, 1);
  });

  it('a escada nova e a antiga com niveis colados na FRENTE, nunca outra grade', () => {
    // E o invariante de que a migracao e um deslocamento. Se ele cair, migrar
    // deixaria de ser renumerar e passaria a exigir regerar tile.
    for (const [w, h, razao] of [[7680, 3840, 1.6], [5760, 2880, 2], [2048, 1024, 2]]) {
      const antiga = escadaAntiga(w, h, TILE, razao);
      const nova = montarEscada(w, h, TILE, razao);
      const delta = nova.length - antiga.length;
      assert.ok(delta > 0, `${w} nao ganhou nivel nenhum`);
      assert.deepEqual(
        nova.slice(delta).map(n => `${n.width}x${n.height}`),
        antiga.map(n => `${n.width}x${n.height}`),
        `em ${w} a escada nova nao contem a antiga`,
      );
    }
  });
});

// ============================================================
// O plano de uma foto, e a idempotencia
// ============================================================

describe('planoDaFoto: tres estados, e o segundo protege o acervo', () => {
  it('7680 ganha tres niveis, 5760 ganha dois, 2048 ganha dois', () => {
    const casos = [
      { p: piramide({ width: 7680, height: 3840, razao: 1.6, max_level: 3 }), delta: 3, larguras: [458, 733, 1172], tiles: 9 },
      { p: piramide({ width: 5760, height: 2880, max_level: 2 }), delta: 2, larguras: [360, 720], tiles: 3 },
      { p: piramide({ width: 2048, height: 1024, max_level: 0 }), delta: 2, larguras: [512, 1024], tiles: 3 },
    ];
    for (const caso of casos) {
      const plano = planoDaFoto(caso.p);
      assert.equal(plano.estado, 'migrar', `${caso.p.width} deveria migrar`);
      assert.equal(plano.delta, caso.delta);
      assert.deepEqual(plano.niveisNovos.map(n => n.width), caso.larguras);
      // Os niveis novos nascem numerados de 0 a delta-1: o mais grosso continua
      // sendo o level 0, que e o contrato que NAO muda.
      assert.deepEqual(plano.niveisNovos.map(n => n.level), [...Array(caso.delta).keys()]);
      assert.equal(plano.tilesNovos, caso.tiles);
    }
  });

  it('a foto ja migrada e PULADA, entao rodar duas vezes nao empurra duas vezes', () => {
    // O estado depois da primeira rodada: max_level e o da escada nova.
    const depois = piramide({ width: 7680, height: 3840, razao: 1.6, max_level: 6 });
    const plano = planoDaFoto(depois);
    assert.equal(plano.estado, 'pronta');
    assert.equal(plano.delta, 0, 'delta 0 e o que impede a segunda rodada de empurrar de novo');
    assert.equal(plano.tilesNovos, 0);

    // A prova de que os dois estados sao mesmo distintos, e nao o mesmo numero
    // lido de dois jeitos: um teste que passasse dos dois jeitos seria pior que
    // teste nenhum.
    const antes = piramide({ width: 7680, height: 3840, razao: 1.6, max_level: 3 });
    assert.equal(planoDaFoto(antes).estado, 'migrar');
    assert.notEqual(antes.max_level, depois.max_level);
  });

  it('max_level que nao e de nenhuma das duas escadas NAO vira migracao', () => {
    // Empurrar por otimismo espalharia o defeito por mais tres niveis, e o
    // sintoma seria tile faltando na tela, nunca um erro.
    const plano = planoDaFoto(piramide({ width: 7680, height: 3840, razao: 1.6, max_level: 5 }));
    assert.equal(plano.estado, 'desconhecida');
    assert.equal(plano.delta, 0);
    assert.match(plano.motivo, /max_level 5/);
  });

  it('o projeto MISTO tem dois deltas ao mesmo tempo, e cada foto leva o seu', () => {
    // blumenau, santiago, tubarao e santana_livramento misturam 7680 e 5760.
    // Um delta unico por projeto empurraria metade das fotos para o lugar errado.
    const a = planoDaFoto(piramide({ width: 7680, height: 3840, razao: 1.6, max_level: 3 }));
    const b = planoDaFoto(piramide({ width: 5760, height: 2880, max_level: 2 }));
    assert.equal(a.delta, 3);
    assert.equal(b.delta, 2);
    assert.notEqual(a.delta, b.delta);
  });
});

// ============================================================
// A renumeracao, contra a chave primaria de verdade
// ============================================================

describe('ordemDaRenumeracao: de cima para baixo, porque a chave primaria colide', () => {
  it('desce do nivel mais fino ao mais grosso', () => {
    assert.deepEqual(ordemDaRenumeracao(3, 3), [3, 2, 1, 0]);
    assert.deepEqual(ordemDaRenumeracao(0, 2), [0]);
  });

  it('delta zero ou negativo nao manda mover nada', () => {
    assert.deepEqual(ordemDaRenumeracao(3, 0), []);
    assert.deepEqual(ordemDaRenumeracao(3, -1), []);
  });

  describe('num SQLite com a chave primaria de producao', () => {
    let dir;
    let db;
    const PK = `CREATE TABLE tiles (
      photo_id TEXT NOT NULL, level INTEGER NOT NULL, x INTEGER NOT NULL,
      y INTEGER NOT NULL, webp BLOB NOT NULL,
      PRIMARY KEY (photo_id, level, x, y))`;

    before(() => {
      dir = mkdtempSync(join(tmpdir(), 'migrar-escada-pk-'));
      db = new Database(join(dir, 't.db'));
      db.exec(PK);
    });
    after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

    /**
     * Semeia quatro niveis de um tile cada, e devolve o statement de subida.
     * @param {string} id - photo_id da foto semeada.
     * @returns {object} O UPDATE preparado.
     */
    function semear(id) {
      const ins = db.prepare('INSERT INTO tiles VALUES (?, ?, 0, 0, ?)');
      for (let l = 0; l <= 3; l++) ins.run(id, l, Buffer.from([l]));
      return db.prepare('UPDATE tiles SET level = level + ? WHERE photo_id = ? AND level = ?');
    }

    it('a ordem CRESCENTE bate em UNIQUE, e e por isso que ela nao esta no codigo', () => {
      const sobe = semear('crescente');
      // O nivel 0 tenta virar 3, e o 3 ainda esta la. Nao e teoria: e o erro
      // que o SQLite devolve.
      assert.throws(() => sobe.run(3, 'crescente', 0), /UNIQUE/);
    });

    it('a ordem de ordemDaRenumeracao move as quatro linhas sem colidir', () => {
      const sobe = semear('decrescente');
      for (const nivel of ordemDaRenumeracao(3, 3)) sobe.run(3, 'decrescente', nivel);

      const niveis = db.prepare(
        'SELECT level FROM tiles WHERE photo_id = ? ORDER BY level',
      ).pluck().all('decrescente');
      assert.deepEqual(niveis, [3, 4, 5, 6]);

      // Cada linha foi reescrita UMA vez, e o conteudo seguiu junto do nivel: o
      // tile que era o nivel 0 e o mesmo byte, agora no nivel 3.
      const corpo = db.prepare(
        'SELECT webp FROM tiles WHERE photo_id = ? AND level = 3',
      ).pluck().get('decrescente');
      assert.deepEqual([...corpo], [0], 'o nivel 3 tem de ser o antigo nivel 0');
    });
  });
});

// ============================================================
// Linha de comando
// ============================================================

describe('interpretarArgumentos: valor invalido para a rodada, nao vira NaN', () => {
  it('le as opcoes que o operador realmente usa', () => {
    const o = interpretarArgumentos(['--dry-run', '--so', 'blumenau', '--workers', '2']);
    assert.equal(o.dryRun, true);
    assert.deepEqual([...o.so], ['blumenau']);
    assert.equal(o.workers, 2);
  });

  it('--so aceita lista, porque um piloto costuma ser mais de um projeto', () => {
    const o = interpretarArgumentos(['--so', 'blumenau,santiago']);
    assert.deepEqual([...o.so], ['blumenau', 'santiago']);
  });

  it('a rodada sem --dry-run e a que escreve, entao o padrao e nao escrever nada?', () => {
    // Nao: o padrao E escrever. O dry-run e explicito, e este teste registra a
    // escolha para ela nao virar surpresa.
    assert.equal(interpretarArgumentos([]).dryRun, false);
    assert.equal(interpretarArgumentos([]).so, null);
  });

  it('aborta no valor invalido e na flag sem valor', () => {
    assert.throws(() => interpretarArgumentos(['--workers', 'abc']), /inteiro/);
    assert.throws(() => interpretarArgumentos(['--workers', '0']), /inteiro/);
    assert.throws(() => interpretarArgumentos(['--so']), /exige um valor/);
    assert.throws(() => interpretarArgumentos(['--so', '--dry-run']), /exige um valor/);
  });
});

// ============================================================
// A rodada inteira, num banco de verdade
// ============================================================

describe('a migracao de ponta a ponta, pela linha de comando', () => {
  let dataDir;
  let dbPath;

  // Duas fotos escolhidas para DISCRIMINAR, com a geometria escrita a mao.
  //
  // A DE DOIS NIVEIS e o caso comum: a escada antiga tinha um nivel grosso e o
  // nativo, e a nova acrescenta dois por baixo.
  // A DE UM NIVEL SO e o formato 2048 do acervo, com 828 fotos. Nela o antigo
  // nivel 0 E o nativo, entao a fonte dos niveis novos e a foto inteira.
  const FOTO_A = {
    id: 'foto-a',
    width: 2560, height: 1280, maxLevelAntigo: 1, delta: 2,
    niveis: [{ width: 1280, height: 640 }, { width: 2560, height: 1280 }],
    // 3x2 + 5x3
    tilesAntigos: 21,
    // 320x160 (1 tile) e 640x320 (2 tiles)
    tilesNovos: 3,
    niveisNovos: [{ width: 320, height: 160 }, { width: 640, height: 320 }],
  };
  const FOTO_B = {
    id: 'foto-b',
    width: 2048, height: 1024, maxLevelAntigo: 0, delta: 2,
    niveis: [{ width: 2048, height: 1024 }],
    // 4x2
    tilesAntigos: 8,
    // 512x256 (1 tile) e 1024x512 (2 tiles)
    tilesNovos: 3,
    niveisNovos: [{ width: 512, height: 256 }, { width: 1024, height: 512 }],
  };

  /**
   * Gera os tiles de um nivel, com a borda RECORTADA e cor por coordenada.
   *
   * A COR MUDA COM (x, y) de proposito, e nenhuma delas e preta. O fundo da
   * composicao no migrador e preto: se ele deixasse de usar os tiles de fonte, o
   * nivel novo sairia preto e a soma de bytes fecharia do mesmo jeito. A cor e o
   * unico jeito de a prova de pixel enxergar isso.
   *
   * @param {{width:number,height:number}} nivel - Dimensoes do nivel.
   * @returns {Promise<Array<{x:number,y:number,webp:Buffer}>>}
   */
  async function tilesDoNivel(nivel) {
    const cols = Math.ceil(nivel.width / TILE);
    const rows = Math.ceil(nivel.height / TILE);
    const saida = [];
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const webp = await sharp({
          create: {
            width: Math.min(TILE, nivel.width - x * TILE),
            height: Math.min(TILE, nivel.height - y * TILE),
            channels: 3,
            background: { r: 60 + x * 40, g: 90 + y * 50, b: 200 },
          },
        }).webp({ quality: QUALIDADE }).toBuffer();
        saida.push({ x, y, webp });
      }
    }
    return saida;
  }

  before(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'migrar-escada-e2e-'));
    mkdirSync(join(dataDir, 'projects'), { recursive: true });
    dbPath = join(dataDir, 'projects', 'mini_tiles.db');

    const db = new Database(dbPath);
    db.pragma('page_size = 65536');
    db.pragma('journal_mode = WAL');
    db.exec(DDL);

    const insTile = db.prepare('INSERT INTO tiles VALUES (?, ?, ?, ?, ?)');
    const insPir = db.prepare(`
      INSERT INTO tile_pyramids (photo_id, tile_size, max_level, width, height, quality,
                                 tile_count, total_bytes, built_at, razao)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 2)
    `);
    for (const foto of [FOTO_A, FOTO_B]) {
      let n = 0;
      let bytes = 0;
      for (let level = 0; level < foto.niveis.length; level++) {
        for (const t of await tilesDoNivel(foto.niveis[level])) {
          insTile.run(foto.id, level, t.x, t.y, t.webp);
          n++;
          bytes += t.webp.length;
        }
      }
      assert.equal(n, foto.tilesAntigos, `a fixture de ${foto.id} nasceu com o numero errado`);
      insPir.run(
        foto.id, TILE, foto.maxLevelAntigo, foto.width, foto.height, QUALIDADE,
        n, bytes, '2026-08-14T10:00:00.000Z',
      );
    }
    db.close();
  });

  after(() => { rmSync(dataDir, { recursive: true, force: true }); });

  /**
   * Roda o migrador pela linha de comando, como o chefe vai rodar.
   * @param {string[]} args - Argumentos extras.
   * @returns {string} A saida do processo.
   */
  function rodar(args) {
    return execFileSync(process.execPath, [SCRIPT, '--data', dataDir, '--so', 'mini', ...args], {
      encoding: 'utf8', cwd: RAIZ,
    });
  }

  /**
   * Le o estado do arquivo: piramides, e a grade por nivel.
   * @returns {{piramides:Array<object>, niveis:Array<object>, conferencia:object}}
   */
  function estado() {
    const db = new Database(dbPath, { readonly: true });
    try {
      return {
        piramides: db.prepare(
          'SELECT photo_id, max_level, tile_count, total_bytes, built_at FROM tile_pyramids ORDER BY photo_id',
        ).all(),
        niveis: db.prepare(
          'SELECT photo_id, level, COUNT(*) AS n FROM tiles GROUP BY photo_id, level ORDER BY photo_id, level',
        ).all(),
        conferencia: conferirProjeto(db),
      };
    } finally {
      db.close();
    }
  }

  it('--dry-run imprime o plano e NAO escreve nada', () => {
    const antes = estado();
    const tamanhoAntes = statSync(dbPath).size;

    const saida = rodar(['--dry-run']);
    assert.match(saida, /nada e escrito/i);
    // O plano tem de dizer quantos niveis entram, e nao so que algo vai mudar.
    assert.match(saida, /\+2 nivel/);

    const depois = estado();
    assert.deepEqual(depois.piramides, antes.piramides, 'o dry-run mexeu em tile_pyramids');
    assert.deepEqual(depois.niveis, antes.niveis, 'o dry-run mexeu nos tiles');
    assert.equal(statSync(dbPath).size, tamanhoAntes);
  });

  it('a rodada empurra a numeracao, cria os niveis novos e passa na conferencia', async () => {
    const antes = estado();
    // A conferencia REPROVA o estado anterior. Sem isto, uma conferencia que
    // aprova tudo passaria por verificacao sem verificar nada.
    assert.equal(antes.conferencia.ok, false,
      'antes de migrar o arquivo esta na escada velha, e a conferencia tem de reprovar');

    const saida = rodar([]);
    assert.match(saida, /CONFERENCIA OK/);

    const depois = estado();
    assert.equal(depois.conferencia.ok, true, 'a conferencia reprovou depois de migrar');

    for (const foto of [FOTO_A, FOTO_B]) {
      const p = depois.piramides.find(l => l.photo_id === foto.id);
      const nova = montarEscada(foto.width, foto.height, TILE, 2);
      assert.equal(p.max_level, nova.length - 1, `${foto.id}: max_level nao acompanhou a escada`);
      assert.equal(p.tile_count, foto.tilesAntigos + foto.tilesNovos);

      // O total_bytes MUDA, e e assim que o cliente com cache de um ano
      // descobre que a escada e outra: ele e o token do `?v=`.
      const pAntes = antes.piramides.find(l => l.photo_id === foto.id);
      assert.notEqual(p.total_bytes, pAntes.total_bytes, `${foto.id}: o token do ?v= nao se moveu`);
      assert.notEqual(p.built_at, pAntes.built_at, `${foto.id}: o built_at do ETag nao se moveu`);

      // A GRADE INTEIRA, nivel a nivel. O antigo nivel 0 tem de estar no nivel
      // `delta`, com o mesmo numero de tiles de antes.
      for (const nivel of nova) {
        const linha = depois.niveis.find(l => l.photo_id === foto.id && l.level === nivel.level);
        assert.equal(linha.n, nivel.cols * nivel.rows,
          `${foto.id} nivel ${nivel.level}: ${linha.n} tiles contra ${nivel.cols * nivel.rows}`);
      }
      const antigoZero = antes.niveis.find(l => l.photo_id === foto.id && l.level === 0);
      const agora = depois.niveis.find(l => l.photo_id === foto.id && l.level === foto.delta);
      assert.equal(agora.n, antigoZero.n,
        `${foto.id}: o antigo nivel 0 devia estar inteiro no nivel ${foto.delta}`);
    }
  });

  it('o nivel novo tem PIXEL da foto, e nao o preto do fundo da composicao', async () => {
    // A prova de que a fonte foram os tiles gravados. Um migrador que compusesse
    // uma tela vazia geraria o mesmo numero de tiles, com bytes plausiveis, e
    // passaria em toda checagem de contagem.
    const db = new Database(dbPath, { readonly: true });
    const webp = db.prepare(
      'SELECT webp FROM tiles WHERE photo_id = ? AND level = 0 AND x = 0 AND y = 0',
    ).pluck().get(FOTO_A.id);
    db.close();

    const meta = await sharp(webp).metadata();
    assert.equal(meta.width, FOTO_A.niveisNovos[0].width);
    assert.equal(meta.height, FOTO_A.niveisNovos[0].height);

    const stats = await sharp(webp).stats();
    // Os tiles da fixture tem azul 200 e nenhum canal em zero. Preto daria
    // media perto de 0 nos tres.
    for (const canal of stats.channels) {
      assert.ok(canal.mean > 20, `canal com media ${canal.mean}: o nivel novo saiu preto`);
    }
  });

  it('rodar de novo NAO empurra a numeracao uma segunda vez', () => {
    const antes = estado();
    const saida = rodar([]);
    assert.match(saida, /Nada a migrar/);

    const depois = estado();
    assert.deepEqual(
      depois.niveis, antes.niveis,
      'a segunda rodada mexeu na grade, entao a deteccao de foto pronta falhou',
    );
    assert.deepEqual(
      depois.piramides.map(p => [p.photo_id, p.max_level, p.tile_count, p.total_bytes]),
      antes.piramides.map(p => [p.photo_id, p.max_level, p.tile_count, p.total_bytes]),
      'a segunda rodada mudou a contabilidade de uma piramide ja migrada',
    );
    assert.equal(depois.conferencia.ok, true);
  });
});
