#!/usr/bin/env node

/**
 * @module scripts/generate-tiles
 * @description Gera a piramide de tiles de UM projeto para um arquivo SQLite
 * NOVO e separado: `data/projects/{slug}_tiles.db`. O `{slug}.db` original e
 * aberto so em modo readonly, nunca para escrita.
 *
 * POR QUE UM ARQUIVO SEPARADO. Reconstruir a piramide nao pode reescrever os
 * BLOBs de 2,5 MB de `images`: eles nao mudam, e um arquivo unico obrigaria a
 * copiar o acervo inteiro a cada mudanca de `--tile` ou `--quality`. Separado,
 * a troca atomica cobre os dois arquivos na mesma janela e a geracao roda com o
 * servico no ar. `getProjectDb('museu_cms_tiles.db')` ja abre o destino sem
 * tocar em `src/db/connection.js`.
 *
 * NUMERACAO (contrato). `level` 0 e o MAIS GROSSO e o nivel cresce com o
 * detalhe; `maxLevel` e a resolucao nativa. A escada divide a largura pela RAZAO
 * enquanto ela passar de 2048. Essa regra NAO mora aqui: ela vem de
 * `public/calibration/js/pyramid-math.js`, que o cliente e o benchmark importam
 * tambem. Origem top-left, nunca TMS.
 * `cols`/`rows` saem de `ceil`, e a borda fica RECORTADA: a ultima coluna mede
 * `width - 512*(cols-1)` e a ultima linha `height - 512*(rows-1)`.
 *
 * A RAZAO E POR FORMATO, e vai GRAVADA na piramide. Sem `--razao`, quem escolhe
 * e a largura NATIVA de cada foto: 7680 usa 1,6 e o resto usa 2. O mapa esta em
 * RAZAO_POR_LARGURA, com o porque medido. `--razao` explicito manda em tudo, e
 * vale para todas as fotos da rodada.
 *
 * Uso:
 *   node scripts/generate-tiles.js --project museu_cms --limit 5
 *   node scripts/generate-tiles.js --project museu_cms --razao 1.6
 *
 * Opcoes:
 *   --project <slug>  obrigatorio
 *   --data <dir>      raiz dos dados (padrao ./data)
 *   --tile <px>       lado do tile (padrao 512, o valor do contrato)
 *   --quality <n>     qualidade WebP (padrao 80, a mesma do full em migrate.js)
 *   --razao <n>       fator entre niveis (padrao: por formato, ver RAZAO_POR_LARGURA)
 *   --workers <n>     fotos em paralelo (padrao conservador, ver DEFAULT abaixo)
 *   --limit <n>       processa so as N primeiras fotos do projeto (piloto)
 *   --force           regera foto que ja tem piramide
 */

import { isMainThread, Worker, workerData, parentPort } from 'node:worker_threads';
import { resolve, join } from 'node:path';
import { existsSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import Database from 'better-sqlite3';
// A escada de niveis e importada, nunca reescrita. Ela ja nasceu escrita tres
// vezes com arredondamentos diferentes, e o descritor passou a prometer uma
// grade que o banco nao tinha. Quem muda a regra muda em pyramid-math.js.
import {
  montarEscada, custoDaEscada, RAZAO_PADRAO, RAZAO_POR_LARGURA, razaoParaLargura,
} from '../public/calibration/js/pyramid-math.js';

// ============================================================
// Constantes do contrato
// ============================================================

/** Lado do tile em pixels. O contrato fecha em 512. @constant {number} */
const TILE_PADRAO = 512;

/** Qualidade WebP dos tiles. 80 e a mesma do `full_webp` em migrate.js:1035. @constant {number} */
const QUALIDADE_PADRAO = 80;


/**
 * Descreve o mapa de razoes para a tela, a partir do proprio mapa.
 *
 * O texto sai da constante, e nao de uma frase escrita a mao ao lado dela: uma
 * frase paralela envelhece na primeira faixa nova e passa a mentir no cabecalho
 * da rodada, que e onde o operador confere o que pediu.
 * @returns {string}
 */
function descreverRazaoAutomatica() {
  return RAZAO_POR_LARGURA
    .map(f => (f.larguraMinima > 0 ? `>=${f.larguraMinima} usa ${f.razao}` : `resto usa ${f.razao}`))
    .join(', ');
}

/**
 * Caminho da DDL do banco de tiles.
 *
 * A DDL e LIDA do arquivo, nunca copiada para dentro deste script. Ela e a
 * mesma que a rota do tile assume, e uma segunda copia aqui viraria uma segunda
 * verdade: bastaria um `ALTER` no arquivo para o gerador e o servidor passarem
 * a descrever tabelas diferentes sem ninguem notar. E o mesmo gesto do
 * migrate.js com o `project-schema.sql`.
 * @constant {URL}
 */
const DDL_PATH = new URL('../src/db/tiles-schema.sql', import.meta.url);

/**
 * Padrao de fotos em paralelo.
 *
 * Cada worker guarda o RAW da foto nativa enquanto tila: 7680x3840x3 canais sao
 * 88 MB, mais ~22 MB do nivel intermediario. Quatro workers ficam perto de 500
 * MB de pico, que a estacao aguenta e um numero maior nao acelera, porque o
 * gargalo passa a ser a banda de memoria. Suba com `--workers` so em maquina
 * com folga medida.
 * @constant {number}
 */
const WORKERS_PADRAO = Math.max(1, Math.min(4, availableParallelism() - 1));

// A escada (`montarEscada`) devolve os niveis em ordem CRESCENTE de detalhe,
// porque `level` 0 e o mais grosso. O `tiles.json` repete essa lista pronta, de
// proposito redundante: assim o cliente nao refaz o `ceil` e um arredondamento
// divergente nao vira tile faltando.

// ============================================================
// Worker: decodifica uma foto e devolve os tiles de todos os niveis
// ============================================================

/**
 * Loop do worker. Abre a sua propria conexao READONLY com o banco de origem e
 * responde uma foto por mensagem.
 *
 * Cada worker le o BLOB direto do `{slug}.db` em vez de recebe-lo da thread
 * principal por duas razoes. A leitura de um BLOB de 2,5 MB e sincrona no
 * better-sqlite3, e feita na principal ela travaria o despacho e a barra de
 * progresso. E varias conexoes readonly sobre um banco WAL sao seguras em
 * paralelo, que e como o proprio servico ja serve imagem.
 * @returns {Promise<void>}
 */
async function rodarWorker() {
  const sharp = (await import('sharp')).default;

  // libvips guarda operacoes num cache proprio. Com buffers RAW de 88 MB
  // passando por ele, esse cache viraria o maior consumidor do processo sem
  // acelerar nada: cada foto e um trabalho novo, nada se repete entre elas.
  sharp.cache(false);
  // A unidade de paralelismo aqui e a FOTO, nao a operacao. Deixar o libvips
  // abrir a propria pool dentro de cada worker multiplicaria as threads pelo
  // numero de workers e so acrescentaria disputa pelos mesmos nucleos.
  sharp.concurrency(1);

  // `razaoPedida` chega null quando a rodada nao passou --razao. A escolha por
  // formato so acontece do lado de la, dentro de gerarPiramide: a largura
  // nativa e do PIXEL, e so o decode a conhece.
  const { origemPath, tileSize, quality, razaoPedida } = workerData;

  const origem = new Database(origemPath, { readonly: true });
  origem.pragma('query_only = true');
  origem.pragma('cache_size = -32000');
  origem.pragma('busy_timeout = 5000');
  const lerFull = origem.prepare('SELECT full_webp FROM images WHERE photo_id = ?').pluck();

  parentPort.on('message', async (msg) => {
    if (msg.tipo === 'fim') {
      origem.close();
      parentPort.close();
      return;
    }

    const { photoId } = msg;
    try {
      const fullBuf = lerFull.get(photoId);
      if (!fullBuf) {
        parentPort.postMessage({ tipo: 'erro', photoId, mensagem: 'sem linha em images' });
        return;
      }
      const resultado = await gerarPiramide(sharp, fullBuf, tileSize, quality, razaoPedida);
      parentPort.postMessage({ tipo: 'pronto', photoId, srcBytes: fullBuf.length, ...resultado });
    } catch (err) {
      parentPort.postMessage({ tipo: 'erro', photoId, mensagem: descreverErro(err) });
    }
  });
}

/**
 * Produz todos os tiles de todos os niveis de uma foto a partir de UM decode.
 *
 * O WebP e decodificado uma unica vez para RAW. Cada nivel abaixo do nativo sai
 * de um redimensionamento DESSE raw, nunca de um novo decode nem de uma cadeia
 * de reducoes sucessivas: um decode por nivel triplicaria o custo, e a cadeia
 * empilharia tres passes de reamostragem no nivel mais grosso.
 *
 * O corte usa `extract` sobre o raw do nivel, que no libvips e um recorte de
 * regiao. Por isso a borda sai naturalmente recortada: a ultima coluna e a
 * ultima linha pedem so os pixels que sobraram, e o tile nasce menor que 512.
 *
 * A RAZAO SE DECIDE AQUI, e nao na thread principal, porque so depois do decode
 * a largura nativa e um fato. O `index.db` guarda `full_size_bytes`, nunca as
 * dimensoes, entao deduzir o formato antes seria adivinhar. A razao usada volta
 * no resultado, e e ela que a linha de `tile_pyramids` grava.
 *
 * @param {object} sharp - O modulo sharp ja carregado.
 * @param {Buffer} fullBuf - O `full_webp` da foto.
 * @param {number} tileSize - Lado do tile em pixels.
 * @param {number} quality - Qualidade WebP dos tiles.
 * @param {number|null} razaoPedida - A razao de `--razao`, ou null para o formato decidir.
 * @returns {Promise<{width:number,height:number,maxLevel:number,razao:number,tiles:Array<object>}>}
 */
async function gerarPiramide(sharp, fullBuf, tileSize, quality, razaoPedida) {
  const { data: nativoRaw, info: nativo } = await sharp(fullBuf)
    .raw()
    .toBuffer({ resolveWithObject: true });

  const razao = razaoParaLargura(nativo.width, razaoPedida);
  const niveis = montarEscada(nativo.width, nativo.height, tileSize, razao);
  const maxLevel = niveis.length - 1;
  const tiles = [];

  for (const nivel of niveis) {
    let raw = nativoRaw;
    let canais = nativo.channels;
    if (nivel.level !== maxLevel) {
      // `fit: 'fill'` porque as duas dimensoes ja estao calculadas: qualquer
      // preservacao de proporcao aqui poderia devolver um pixel a menos e
      // desalinhar a ultima linha de tiles do que o `tiles.json` promete.
      const reduzido = await sharp(nativoRaw, {
        raw: { width: nativo.width, height: nativo.height, channels: nativo.channels },
      })
        .resize(nivel.width, nivel.height, { fit: 'fill', kernel: 'lanczos3' })
        .raw()
        .toBuffer({ resolveWithObject: true });
      raw = reduzido.data;
      canais = reduzido.info.channels;
    }

    const entrada = { raw: { width: nivel.width, height: nivel.height, channels: canais } };
    // y por fora e x por dentro: o recorte de uma linha de tiles percorre bytes
    // vizinhos no raw, que e a ordem barata de ler.
    for (let y = 0; y < nivel.rows; y++) {
      const altura = Math.min(tileSize, nivel.height - y * tileSize);
      for (let x = 0; x < nivel.cols; x++) {
        const largura = Math.min(tileSize, nivel.width - x * tileSize);
        const webp = await sharp(raw, entrada)
          .extract({ left: x * tileSize, top: y * tileSize, width: largura, height: altura })
          .webp({ quality })
          .toBuffer();
        tiles.push({ level: nivel.level, x, y, webp });
      }
    }
  }

  return { width: nativo.width, height: nativo.height, maxLevel, razao, tiles };
}

// ============================================================
// Thread principal
// ============================================================

/**
 * Le uma opcao de linha de comando.
 * @param {string[]} args - argv sem os dois primeiros elementos.
 * @param {string} nome - Nome da opcao, sem os hifens.
 * @param {string|null} padrao - Valor quando a opcao nao aparece.
 * @returns {string|null}
 */
function getArg(args, nome, padrao) {
  const i = args.indexOf(`--${nome}`);
  return i === -1 || i + 1 >= args.length ? padrao : args[i + 1];
}

/**
 * Le uma opcao numerica inteira e positiva, abortando com mensagem acionavel.
 * @param {string[]} args - argv sem os dois primeiros elementos.
 * @param {string} nome - Nome da opcao.
 * @param {number|null} padrao - Valor quando a opcao nao aparece.
 * @returns {number|null}
 */
function getInt(args, nome, padrao) {
  const bruto = getArg(args, nome, null);
  if (bruto === null) return padrao;
  const n = Number.parseInt(bruto, 10);
  if (!Number.isInteger(n) || n <= 0) {
    console.error(`--${nome} precisa de um inteiro positivo, recebeu "${bruto}".`);
    process.exit(1);
  }
  return n;
}

/**
 * Le a razao da linha de comando, abortando com mensagem acionavel.
 *
 * NAO usa getInt: a razao que interessa e fracionaria (1,6 domina 1,5 e 1,4 no
 * orcamento). O piso de 1 exclusivo nao e formalidade: com razao <= 1 o laco de
 * montarEscada nao desceria, e la dentro ela cairia calada no padrao. Aqui a
 * rodada para, porque gerar 100 GB com uma escada diferente da pedida e o tipo
 * de erro que so aparece semanas depois.
 *
 * A AUSENCIA devolve null, e nao RAZAO_PADRAO. Sao dois pedidos diferentes:
 * "use 2 em tudo" e "deixe o formato de cada foto escolher". Devolver o numero
 * apagaria o segundo, e todo o acervo de 7680 sairia com a escada errada sem
 * ninguem digitar nada.
 *
 * @param {string[]} args - argv sem os dois primeiros elementos.
 * @returns {number|null} A razao pedida, ou null quando o formato decide.
 */
function getRazao(args) {
  const bruto = getArg(args, 'razao', null);
  if (bruto === null) return null;
  const n = Number.parseFloat(bruto);
  if (!Number.isFinite(n) || n <= 1) {
    console.error(`--razao precisa de um numero maior que 1, recebeu "${bruto}".`);
    process.exit(1);
  }
  return n;
}

/** @param {number} bytes @returns {string} */
const mb = (bytes) => (bytes / 1048576).toFixed(2);

/**
 * Descreve um erro que pode NAO ser um Error de verdade.
 *
 * O erro que atravessa a fronteira do worker passa por clonagem estruturada, e
 * ela nao preserva subclasse de Error: o SqliteError do better-sqlite3 chega do
 * outro lado como objeto simples, so com `code`, e `err.message` vira
 * `undefined`. A rodada que morre e o momento em que o operador mais precisa da
 * mensagem, e "Rodada INTERROMPIDA: undefined" nao aponta nada.
 *
 * @param {unknown} err - O que quer que tenha sido lancado.
 * @returns {string} Sempre um texto util.
 */
function descreverErro(err) {
  if (err instanceof Error && err.message) return err.message;
  if (err && typeof err === 'object') {
    const partes = [err.name, err.code, err.message].filter(Boolean);
    if (partes.length) return partes.join(' ');
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return String(err);
}

/** @param {number} ms @returns {string} */
function duracao(ms) {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}

/**
 * Envelopa o Uint8Array que veio do worker como Buffer, sem copiar.
 *
 * `postMessage` clona o Buffer e o entrega do outro lado como Uint8Array puro,
 * e o better-sqlite3 so aceita Buffer para BLOB. O `Buffer.from` com offset e
 * uma vista sobre a mesma memoria, entao nao ha segunda copia aqui.
 * @param {Uint8Array} u8 - O tile como veio do worker.
 * @returns {Buffer}
 */
const comoBlob = (u8) => Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength);

/**
 * A identidade da escada de uma piramide, em uma linha.
 *
 * Ela e UMA funcao porque tres lugares dependem de concordar: o agrupamento do
 * resumo, a escolha das amostras de grade e o rotulo da propria grade. Duas
 * fotos com esta mesma chave tem, por construcao, a mesma escada e a mesma
 * grade. Se o agrupamento e a amostragem discordassem, uma escada ficaria sem
 * conferencia nenhuma e o resumo diria que conferiu.
 *
 * @param {{width:number,height:number,tile_size:number,razao:number}} p - Linha de tile_pyramids.
 * @returns {string}
 */
const chaveDaEscada = (p) => `${p.width}x${p.height} tile ${p.tile_size} razao ${p.razao}`;

/**
 * Confere a GRADE de uma foto: os (level,x,y) que a escada preve contra os que
 * estao gravados.
 *
 * POR QUE ESTA CONFERENCIA EXISTE. A outra soma tiles e bytes contra o que
 * `tile_pyramids` declarou, e as duas pontas dessa soma sao escritas pelo mesmo
 * laco: uma ESCADA TROCADA passa inteira por ela, porque o gerador contaria e
 * declararia os mesmos tiles errados. Aqui a comparacao e contra a conta
 * independente de montarEscada, refeita a partir dos parametros gravados. E o
 * defeito que ela pega nao daria erro em lugar nenhum: um cliente pedindo um
 * tile que a escada promete e o banco nao tem leva 404, e o buraco aparece como
 * quadrado preto na parede.
 *
 * A razao sai da LINHA da foto, nunca do argumento da rodada. Assim a
 * conferencia testa o invariante que a rota vai usar: a grade tem de bater com o
 * que a razao GRAVADA preve.
 *
 * @param {object} dest - Conexao com o banco de tiles.
 * @param {object} p - Linha de tile_pyramids da foto amostrada.
 * @returns {{photoId:string, geometria:string, esperados:number, gravados:number,
 *   faltando:string[], sobrando:string[], ok:boolean}}
 */
function conferirGrade(dest, p) {
  const escada = montarEscada(p.width, p.height, p.tile_size, p.razao);
  const esperados = new Set();
  for (const nivel of escada) {
    for (let y = 0; y < nivel.rows; y++) {
      for (let x = 0; x < nivel.cols; x++) esperados.add(`${nivel.level}/${x}/${y}`);
    }
  }

  const gravados = new Set(
    dest.prepare('SELECT level, x, y FROM tiles WHERE photo_id = ?')
      .all(p.photo_id)
      .map(t => `${t.level}/${t.x}/${t.y}`)
  );

  // As duas direcoes, e nao so a falta. Tile SOBRANDO e o sintoma de escada
  // trocada com --force parcial: a grade nova nao cobre a coordenada que a
  // grade velha gravou, e ela fica orfa no arquivo.
  const faltando = [...esperados].filter(k => !gravados.has(k));
  const sobrando = [...gravados].filter(k => !esperados.has(k));

  return {
    photoId: p.photo_id,
    geometria: chaveDaEscada(p),
    esperados: esperados.size,
    gravados: gravados.size,
    faltando,
    sobrando,
    ok: faltando.length === 0 && sobrando.length === 0,
  };
}

/**
 * Orquestra a geracao: monta a lista de fotos, sobe os workers, grava o destino
 * e mede o resultado no proprio banco.
 * @returns {Promise<void>}
 */
async function principal() {
  const args = process.argv.slice(2);
  const slug = getArg(args, 'project', null);
  const dataDir = resolve(getArg(args, 'data', './data'));
  const tileSize = getInt(args, 'tile', TILE_PADRAO);
  const quality = getInt(args, 'quality', QUALIDADE_PADRAO);
  const razaoPedida = getRazao(args);
  const workers = getInt(args, 'workers', WORKERS_PADRAO);

  // A razao que ESTA rodada quer para uma foto daquela largura. E a mesma conta
  // que o worker faz depois do decode, e ela reaparece aqui por duas vezes: o
  // filtro do que ja esta pronto e o aviso de mistura, que precisam decidir a
  // razao de uma foto sem decodificar nada, pela largura ja GRAVADA.
  const razaoDaFoto = (largura) => razaoParaLargura(largura, razaoPedida);
  const limite = getInt(args, 'limit', null);
  const force = args.includes('--force');

  if (!slug) {
    console.error('Uso: node scripts/generate-tiles.js --project <slug> [--limit N] [--force]');
    process.exit(1);
  }
  if (quality > 100) {
    console.error('--quality vai de 1 a 100.');
    process.exit(1);
  }

  const indexPath = resolve(dataDir, 'index.db');
  const projectsDir = resolve(dataDir, 'projects');
  if (!existsSync(indexPath)) {
    console.error(`index.db nao encontrado em ${indexPath}`);
    process.exit(1);
  }

  // O index.db decide QUAIS fotos entram: e ele que guarda o soft-delete e o
  // db_filename do projeto. Adivinhar `${slug}.db` funcionaria hoje e quebraria
  // no dia em que um projeto for renomeado sem renomear o arquivo.
  const index = new Database(indexPath, { readonly: true });
  index.pragma('query_only = true');

  const projeto = index.prepare('SELECT id, slug, db_filename FROM projects WHERE slug = ?').get(slug);
  if (!projeto) {
    console.error(`Projeto ${slug} nao encontrado em index.db.`);
    index.close();
    process.exit(1);
  }

  const origemPath = join(projectsDir, projeto.db_filename);
  if (!existsSync(origemPath)) {
    console.error(`Banco de imagens nao encontrado em ${origemPath}`);
    index.close();
    process.exit(1);
  }

  // Foto excluida por soft-delete nao aparece em lugar nenhum da interface:
  // gerar 160 tiles dela seria gastar disco num objeto que ninguem pede.
  // A ordem por sequence_number torna o recorte de `--limit` reproduzivel.
  let fotos = index.prepare(`
    SELECT ph.id, ph.display_name
    FROM photos ph
    WHERE ph.project_id = ?
      AND ph.id NOT IN (SELECT photo_id FROM deleted_photos)
    ORDER BY ph.sequence_number
  `).all(projeto.id);
  index.close();

  if (limite) fotos = fotos.slice(0, limite);
  if (!fotos.length) {
    console.error(`Projeto ${slug} nao tem foto viva para tilar.`);
    process.exit(1);
  }
  const nomeDaFoto = new Map(fotos.map(f => [f.id, f.display_name]));

  // --- Destino -------------------------------------------------------------

  const destPath = join(projectsDir, `${slug}_tiles.db`);
  const criando = !existsSync(destPath);
  const dest = new Database(destPath);
  if (criando) {
    // page_size ANTES de qualquer tabela E antes do WAL: depois que o journal
    // vira WAL o pragma passa a ser no-op silencioso, e so um VACUUM mudaria a
    // pagina. Com 64 KB o tile medio de 20 KB cabe inteiro na celula folha
    // (o limite e page_size - 35), sem cadeia de overflow, e a leitura de um
    // tile fica em UMA pagina em vez de duas.
    dest.pragma('page_size = 65536');
  }
  dest.pragma('journal_mode = WAL');
  dest.pragma('synchronous = NORMAL');
  dest.pragma('busy_timeout = 5000');
  if (!existsSync(DDL_PATH)) {
    console.error(`DDL nao encontrada em ${DDL_PATH.pathname}.`);
    console.error('O schema de tiles vive em src/db/tiles-schema.sql (contrato, secao 1).');
    dest.close();
    process.exit(1);
  }
  dest.exec(readFileSync(DDL_PATH, 'utf-8'));

  // Migracao de startup, no espirito de src/db/connection.js: `CREATE TABLE IF
  // NOT EXISTS` nao acrescenta coluna a uma tabela que ja existe, entao um
  // arquivo gerado antes da coluna `razao` sairia daqui sem ela e o INSERT
  // abaixo estouraria. O ALTER e NO LUGAR, e preserva os tiles ja gravados: o
  // museu_cms_tiles.db tem 12160 deles, e refaze-los custaria horas.
  //
  // DEFAULT 2 e a leitura certa do legado, nao um preenchimento de conveniencia:
  // as piramides anteriores a esta coluna sairam da escada classica de metades.
  const colunas = dest.pragma('table_info(tile_pyramids)');
  if (!colunas.some(c => c.name === 'razao')) {
    dest.exec(`ALTER TABLE tile_pyramids ADD COLUMN razao REAL NOT NULL DEFAULT ${RAZAO_PADRAO}`);
    console.log(`  Migracao: coluna razao acrescentada, com ${RAZAO_PADRAO} nas piramides antigas.`);
  }

  const paginaReal = dest.pragma('page_size', { simple: true });
  if (paginaReal !== 65536) {
    console.error(`${destPath} tem page_size ${paginaReal}, e o contrato pede 65536.`);
    console.error('O arquivo foi criado antes desta regra. Apague-o e rode de novo.');
    dest.close();
    process.exit(1);
  }

  const inserirTile = dest.prepare(
    'INSERT INTO tiles (photo_id, level, x, y, webp) VALUES (?, ?, ?, ?, ?)'
  );
  const inserirPiramide = dest.prepare(`
    INSERT INTO tile_pyramids
      (photo_id, tile_size, max_level, width, height, quality, tile_count, total_bytes,
       built_at, razao)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const apagarTiles = dest.prepare('DELETE FROM tiles WHERE photo_id = ?');
  const apagarPiramide = dest.prepare('DELETE FROM tile_pyramids WHERE photo_id = ?');

  /**
   * Grava a piramide INTEIRA de uma foto numa transacao so.
   *
   * O lote e a FOTO, nunca o tile: 120 commits por foto pagariam 120 vezes o
   * custo de fim de transacao para escrever 3,6 MB. E a linha de
   * `tile_pyramids` entra na MESMA transacao dos tiles, o que a torna o marcador
   * de conclusao: se a maquina cair no meio, a foto ou esta inteira ou nao esta,
   * e a rodada seguinte a refaz sem deixar meia piramide servivel pela rota.
   */
  const gravarFoto = dest.transaction((r) => {
    apagarTiles.run(r.photoId);
    apagarPiramide.run(r.photoId);
    let bytes = 0;
    for (const t of r.tiles) {
      inserirTile.run(r.photoId, t.level, t.x, t.y, comoBlob(t.webp));
      bytes += t.webp.byteLength;
    }
    // A razao gravada e a que o WORKER usou, nunca a da linha de comando: com a
    // escolha por formato elas divergem foto a foto, e gravar a da rodada
    // deixaria a coluna descrevendo uma escada que os tiles ao lado nao tem.
    inserirPiramide.run(
      r.photoId, tileSize, r.maxLevel, r.width, r.height, quality,
      r.tiles.length, bytes, new Date().toISOString(), r.razao
    );
    return bytes;
  });

  // Piramide ja pronta com OS MESMOS parametros e trabalho feito. Com tile ou
  // quality diferentes ela nao serve, porque `total_bytes` e o token de geracao
  // do ETag: manter a linha velha faria o cliente de um ano de `immutable`
  // misturar tiles de duas qualidades na mesma panoramica.
  //
  // A RAZAO ENTRA NESTE FILTRO. Sem ela, uma rodada com --razao nova pularia as
  // fotos ja feitas com a razao velha, e o arquivo terminaria com duas escadas
  // dentro: cada foto com uma grade, todas se dizendo prontas. Nao daria erro em
  // lugar nenhum, e e por isso que e pior que um erro. A comparacao e numerica e
  // o REAL nao atrapalha: os dois lados sao o mesmo double, o que o parseFloat
  // devolveu e o que o SQLite guardou dele.
  //
  // A COMPARACAO E POR FOTO, e nao um `WHERE razao = ?`. Com a escolha por
  // formato nao existe "a razao da rodada" para pedir ao SQL: um projeto misto
  // tem duas certas ao mesmo tempo. Cada linha responde com a LARGURA que ela
  // mesma gravou, e a pergunta e se a razao dela e a que esta rodada produziria
  // para aquela largura. Um filtro por razao unica reprovaria metade do projeto
  // misto a cada rodada, e refaria de graca o trabalho ja bom.
  const prontas = new Set(
    dest.prepare('SELECT photo_id, width, razao FROM tile_pyramids WHERE tile_size = ? AND quality = ?')
      .all(tileSize, quality)
      .filter(p => p.razao === razaoDaFoto(p.width))
      .map(p => p.photo_id)
  );
  const pendentes = force ? fotos.slice() : fotos.filter(f => !prontas.has(f.id));
  const puladas = fotos.length - pendentes.length;

  console.log(`Gerando piramide de ${slug}`);
  console.log(`  Origem:   ${origemPath} (readonly)`);
  console.log(`  Destino:  ${destPath}`);
  console.log(`  Tile:     ${tileSize} px, WebP q${quality}`);
  console.log(`  Razao:    ${razaoPedida === null
    ? `por formato (${descreverRazaoAutomatica()})`
    : `${razaoPedida} em todas as fotos (--razao)`}`);
  console.log(`  Fotos:    ${pendentes.length} a gerar, ${puladas} ja prontas${limite ? `, limite ${limite}` : ''}`);
  console.log(`  Workers:  ${workers}`);
  console.log('');

  // --- Pool de workers -----------------------------------------------------

  const inicio = Date.now();
  let feitas = 0;
  let tilesEscritos = 0;
  let bytesEscritos = 0;
  let ultimoDesenho = 0;
  const falhas = [];

  // O erro que mata a rodada fica GUARDADO aqui, em vez de subir e derrubar o
  // processo na hora. Uma rodada que morre na foto 40 de 77 ja gravou 39
  // piramides boas, e esse trabalho so vira numero se o resumo sair assim
  // mesmo. O codigo de saida no fim ainda conta a historia inteira.
  let erroFatal = null;
  let conferido = null;

  try {
    if (pendentes.length) {
      await new Promise((concluir, falhar) => {
        const fila = pendentes.slice();
        const pool = [];
        let vivos = 0;
        // Depois do primeiro erro de worker o pool inteiro esta sendo
        // derrubado. A flag impede despachar foto nova para um worker que ja
        // recebeu terminate, e impede um segundo erro reentrar aqui.
        let abortado = false;

        const desenharProgresso = (forcado = false) => {
          const agora = Date.now();
          if (!forcado && agora - ultimoDesenho < 200) return;
          ultimoDesenho = agora;
          const decorrido = agora - inicio;
          const eta = feitas ? duracao((decorrido / feitas) * (pendentes.length - feitas)) : '--';
          process.stderr.write(
            `\r  ${feitas}/${pendentes.length} fotos | ${tilesEscritos} tiles | ${mb(bytesEscritos)} MB | ETA ${eta}   `
          );
        };

        const despachar = (w) => {
          const foto = fila.shift();
          if (!foto) {
            w.postMessage({ tipo: 'fim' });
            return;
          }
          w.postMessage({ tipo: 'foto', photoId: foto.id });
        };

        const encerrar = () => {
          vivos--;
          if (vivos === 0) {
            desenharProgresso(true);
            process.stderr.write('\n');
            concluir();
          }
        };

        for (let i = 0; i < Math.min(workers, pendentes.length); i++) {
          const w = new Worker(new URL(import.meta.url), {
            workerData: { origemPath, tileSize, quality, razaoPedida },
          });
          vivos++;
          pool.push(w);

          w.on('message', (msg) => {
            if (msg.tipo === 'erro') {
              // O nome de exibicao entra aqui, e nao so o uuid: quem vai atras da
              // foto que falhou procura por "Museu_do_CMS_0042", nao pelo uuid.
              falhas.push({
                photoId: msg.photoId,
                displayName: nomeDaFoto.get(msg.photoId) ?? null,
                etapa: 'geracao',
                mensagem: msg.mensagem,
              });
            } else {
              // A escrita acontece na thread principal de proposito: um unico
              // escritor no SQLite dispensa retry de SQLITE_BUSY, e a transacao
              // de uma foto custa poucos milissegundos contra os segundos que o
              // worker gasta decodificando a proxima.
              try {
                bytesEscritos += gravarFoto(msg);
                tilesEscritos += msg.tiles.length;
                feitas++;
              } catch (err) {
                // Falha de ESCRITA (disco cheio, banco travado) nao pode matar a
                // rodada. Este callback roda fora do await: sem catch, um
                // SQLITE_FULL na foto 40 de 77 virava uncaughtException e levava
                // junto o despacho das 37 restantes, o fechamento do destino e a
                // conferencia final. Aqui ela vira falha registrada, e a fila
                // segue: a transacao da foto e atomica, entao o banco nao fica
                // com meia piramide.
                falhas.push({
                  photoId: msg.photoId,
                  displayName: nomeDaFoto.get(msg.photoId) ?? null,
                  etapa: 'escrita',
                  mensagem: descreverErro(err),
                });
              }
            }
            desenharProgresso();
            if (!abortado) despachar(w);
          });

          w.on('error', (err) => {
            if (abortado) return;
            abortado = true;
            process.stderr.write('\n');
            for (const outro of pool) outro.terminate();
            falhar(err);
          });

          w.on('exit', encerrar);
          despachar(w);
        }
      });
    }
  } catch (err) {
    erroFatal = err;
  } finally {
    // A conferencia mora no `finally`, entao ela roda TAMBEM na rodada que
    // morreu no meio: fecha o destino, faz o checkpoint do WAL e grava o
    // resumo do que ficou no banco. `finalizarRodada` fecha o destino no
    // proprio `finally` dela, e o try daqui garante que um erro na conferencia
    // nao engula o erro que matou a rodada.
    try {
      conferido = finalizarRodada(erroFatal);
    } catch (err) {
      console.error(`\nConferencia falhou depois da rodada: ${descreverErro(err)}`);
    }
  }

  if (erroFatal) {
    console.error(`\nRodada INTERROMPIDA: ${descreverErro(erroFatal)}`);
  }

  // Sai com erro se a rodada morreu, se alguma foto falhou ou se a conferencia
  // reprovou (ou nem rodou): chamar este script de dentro de outro precisa
  // detectar o estrago pelo codigo de saida, sem parsear o texto acima.
  if (erroFatal || falhas.length || !conferido || !conferido.ok) process.exit(1);

  // --- Conferencia e resumo, medidos NO BANCO ------------------------------

  /**
   * Mede o que ficou gravado, imprime o resumo, grava o JSON e fecha o destino.
   *
   * A declaracao vem depois do uso de proposito: ela sobe por hoisting, e o
   * bloco de leitura fica junto do resto da conferencia em vez de empurrar o
   * pool de workers para o fim do arquivo.
   *
   * Cada numero daqui e MEDIDO no banco, nenhum e estimado. Os contadores em
   * memoria (`feitas`, `bytesEscritos`) sao eco do proprio codigo que escreveu,
   * entao servem so para a barra de progresso. O piloto leva estes: fotos,
   * tiles e bytes por nivel, bytes totais, soma dos `full_webp` das MESMAS
   * fotos, a razao entre os dois e o tempo.
   *
   * SAO TRES CONFERENCIAS, e a terceira e de outra natureza. As duas somas
   * (tiles e bytes contra o que tile_pyramids declarou) comparam dois caminhos
   * do MESMO laco, entao uma escada trocada passa por elas de pe. A grade
   * (`conferirGrade`) compara contra a conta independente de montarEscada, e e
   * a unica que reprova esse caso. As tres decidem o codigo de saida.
   *
   * @param {Error|null} erroDaRodada - O erro que interrompeu a fila, se houve.
   * @returns {{ok:boolean, parcial:boolean, resumoPath:string}}
   */
  function finalizarRodada(erroDaRodada) {
    const tempoTotal = Date.now() - inicio;
    // Rodada parcial e a que nao chegou ao fim da fila. O rotulo vai para o
    // JSON porque os totais abaixo cobrem so as fotos que passaram: quem os
    // lesse como "o projeto inteiro" tiraria a razao errada.
    const parcial = Boolean(erroDaRodada) || falhas.length > 0;
    try {
      // O retorno das gravacoes acima e eco do proprio codigo. Os numeros do
      // resumo saem de uma releitura do destino, e a conferencia compara o que
      // os tiles realmente ocupam contra o que `tile_pyramids` declarou.
      // Divergir aqui e defeito, nao arredondamento: e o mesmo dado escrito por
      // dois caminhos.
      dest.pragma('wal_checkpoint(TRUNCATE)');

      const conferencia = dest.prepare(`
        SELECT
          (SELECT COUNT(*) FROM tiles)                              AS tiles,
          (SELECT COALESCE(SUM(LENGTH(webp)), 0) FROM tiles)        AS bytes,
          (SELECT COUNT(*) FROM tile_pyramids)                      AS fotos,
          (SELECT COALESCE(SUM(tile_count), 0) FROM tile_pyramids)  AS tilesDeclarados,
          (SELECT COALESCE(SUM(total_bytes), 0) FROM tile_pyramids) AS bytesDeclarados
      `).get();

      const porNivel = dest.prepare(`
        SELECT level, COUNT(*) AS tiles, SUM(LENGTH(webp)) AS bytes
        FROM tiles GROUP BY level ORDER BY level
      `).all();

      const piramides = dest.prepare(`
        SELECT photo_id, tile_size, max_level, width, height, quality, tile_count,
               total_bytes, razao
        FROM tile_pyramids ORDER BY photo_id
      `).all();

      // Bytes por foto MEDIDOS na tabela de tiles. `total_bytes` e o valor
      // declarado pelo gerador, e o resumo do piloto nao pode se apoiar no que
      // o gerador disse: e justamente isso que a conferencia esta testando.
      const bytesDaFoto = new Map(dest.prepare(`
        SELECT photo_id, SUM(LENGTH(webp)) AS bytes FROM tiles GROUP BY photo_id
      `).all().map(r => [r.photo_id, r.bytes]));

      // A razao compara o MESMO conjunto de fotos dos dois lados: soma dos tiles
      // contra soma dos `full_webp` das fotos que estao na piramide. Comparar com o
      // projeto inteiro inflaria ou desinflaria o numero conforme o `--limit`.
      let bytesOriginais = 0;
      let bytesComparaveis = 0;
      let fotosSemFull = 0;
      // A origem e um banco a MAIS que este resumo abre, e ela pode ser
      // justamente o que derrubou a rodada. Se ela nao abrir, o resumo do que
      // ficou gravado sai assim mesmo, e a razao sai como nao medida em vez de
      // sair como zero: zero seria um numero, e numero aqui e afirmacao.
      let erroOrigem = null;
      try {
        const origem = new Database(origemPath, { readonly: true });
        try {
          origem.pragma('query_only = true');
          const tamanhoFull = origem.prepare('SELECT LENGTH(full_webp) FROM images WHERE photo_id = ?').pluck();
          for (const p of piramides) {
            const full = tamanhoFull.get(p.photo_id);
            // Foto sem `full_webp` na origem sairia da soma de baixo sem sair da
            // de cima, e a razao subiria sozinha. Ela fica FORA das duas somas e
            // entra no resumo como contagem, para o numero continuar comparavel.
            if (full == null) {
              fotosSemFull++;
              continue;
            }
            bytesOriginais += full;
            bytesComparaveis += bytesDaFoto.get(p.photo_id) ?? 0;
          }
        } finally {
          origem.close();
        }
      } catch (err) {
        erroOrigem = err.message;
      }

      const fotosComparadas = piramides.length - fotosSemFull;
      // A razao entra na chave de parametros porque ela troca a GRADE, e nao so
      // os bytes: duas razoes no mesmo arquivo sao duas escadas. Aqui a lista so
      // DESCREVE o que ficou gravado. Quem julga a mistura e o bloco de avisos
      // la embaixo, que sabe distinguir a mistura por formato, esperada, da
      // reconstrucao pela metade.
      const parametros = [...new Set(piramides.map(p => `${p.tile_size}/${p.quality}/r${p.razao}`))];

      // A escada MEDIDA, uma linha por geometria distinta do arquivo, com
      // quantas fotos caem em cada uma. Ela sai da razao GRAVADA em cada linha,
      // nunca do argumento da linha de comando: com a escolha por formato, um
      // projeto misto tem duas escadas certas ao mesmo tempo, e repetir o que
      // foi pedido esconderia justamente o que ha para conferir.
      const escadas = new Map();
      for (const p of piramides) {
        const chave = chaveDaEscada(p);
        let alvo = escadas.get(chave);
        if (!alvo) {
          alvo = {
            escada: montarEscada(p.width, p.height, p.tile_size, p.razao),
            // A razao GRAVADA, e nao a divisao entre duas larguras da escada:
            // os niveis passam por Math.round, entao 4800/7680 devolveria 0,625
            // e nao 1,6. O valor que a rota vai usar e este.
            razao: p.razao,
            fotos: 0,
            bytes: 0,
          };
          escadas.set(chave, alvo);
        }
        alvo.fotos++;
        alvo.bytes += bytesDaFoto.get(p.photo_id) ?? 0;
      }
      // Da escada mais povoada para a menos, e nao na ordem em que as fotos
      // apareceram: o formato dominante do projeto e o que decide o disco.
      const escadasOrdenadas = [...escadas].sort((a, b) => b[1].fotos - a[1].fotos);
      // `razaoDeBytes`, e nao `razao`: desde que a escada ganhou uma razao
      // propria, o nome curto aqui SOMBREARIA o parametro da rodada, e uma
      // leitura de `razao` neste bloco pegaria calada o numero errado. Sao duas
      // grandezas sem parentesco: uma compara bytes, a outra separa niveis. O
      // rotulo impresso e a chave do JSON seguem os mesmos.
      const razaoDeBytes = bytesOriginais ? bytesComparaveis / bytesOriginais : 0;
      const bytesPorFoto = piramides
        .map(p => bytesDaFoto.get(p.photo_id) ?? 0)
        .sort((a, b) => a - b);
      const percentil = (q) => bytesPorFoto.length
        ? bytesPorFoto[Math.min(bytesPorFoto.length - 1, Math.floor(q * bytesPorFoto.length))]
        : 0;

      const tamanhoArquivo = statSync(destPath).size;

      console.log(`\n=== Piramide de ${slug} ===`);
      if (parcial) {
        console.log('  RODADA PARCIAL: os numeros abaixo cobrem so o que ficou gravado.');
      }
      console.log(`  Fotos na piramide:   ${conferencia.fotos} (geradas agora ${feitas}, puladas ${puladas}, falhas ${falhas.length})`);
      console.log(`  Parametros:          tile/quality/razao ${parametros.join(', ')}`);
      console.log(`  Tempo:               ${duracao(tempoTotal)}${feitas ? ` (${(tempoTotal / feitas / 1000).toFixed(2)} s/foto com ${workers} workers)` : ''}`);
      // Uma linha por escada distinta, com a contagem de fotos na frente. O
      // custo teorico ao lado e o que decide a razao ANTES de gerar o acervo:
      // ele orca em area quantas vezes a piramide inteira pesa o nivel nativo. O
      // medido sai maior, porque tile pequeno comprime pior por pixel, e por
      // isso a linha traz tambem os MB que aquelas fotos realmente ocupam.
      console.log(`  Escadas no arquivo:  ${escadas.size}`);
      for (const [chave, { escada, fotos, bytes }] of escadasOrdenadas) {
        const larguras = escada.map(n => n.width).join('/');
        console.log(`    ${String(fotos).padStart(5)} foto(s)  ${chave}  niveis ${larguras}  custo ${custoDaEscada(escada).toFixed(2)}x o nativo  ${mb(bytes)} MB medidos`);
      }
      console.log('');
      console.table(porNivel.map(n => ({
        level: n.level,
        tiles: n.tiles,
        MB: Number(mb(n.bytes)),
        'KB/tile': Number((n.bytes / n.tiles / 1024).toFixed(1)),
      })));
      console.log(`  Tiles:               ${conferencia.tiles}`);
      console.log(`  Bytes dos tiles:     ${mb(conferencia.bytes)} MB`);
      console.log(`  Bytes dos full_webp: ${erroOrigem ? 'nao lidos' : `${mb(bytesOriginais)} MB (mesmas ${fotosComparadas} fotos)`}`);
      console.log(`  RAZAO:               ${erroOrigem
        ? 'NAO MEDIDA, a origem nao abriu'
        : `${razaoDeBytes.toFixed(3)}x o full atual (${mb(bytesComparaveis)} MB de tiles nessas fotos)`}`);
      console.log(`  Por foto:            p50 ${mb(percentil(0.5))} MB, p90 ${mb(percentil(0.9))} MB, max ${mb(percentil(1))} MB`);
      console.log(`  Arquivo em disco:    ${mb(tamanhoArquivo)} MB`);

      if (erroOrigem) {
        console.log(`\n  ATENCAO: nao deu para ler ${origemPath} para comparar: ${erroOrigem}`);
      }
      if (fotosSemFull) {
        console.log(`\n  ATENCAO: ${fotosSemFull} foto(s) sem full_webp na origem ficaram fora da razao.`);
      }
      // A MISTURA QUE IMPORTA E A INESPERADA. Duas razoes no mesmo arquivo
      // deixaram de ser sintoma: com a escolha por formato, um projeto de 7680 e
      // 5760 tem duas escadas de proposito, e avisar aqui treinaria o operador a
      // ignorar o aviso justo quando ele significar alguma coisa. O que reprova
      // e a piramide cuja razao GRAVADA nao e a que esta rodada produziria para
      // a largura dela, sinal de reconstrucao pela metade. Tile e quality
      // continuam tendo de ser unicos: eles nao dependem do formato.
      const combinacoes = [...new Set(piramides.map(p => `${p.tile_size}/${p.quality}`))];
      const razaoForaDoMapa = piramides.filter(p => p.razao !== razaoDaFoto(p.width));
      if (combinacoes.length > 1) {
        console.log(`\n  ATENCAO: o arquivo mistura ${combinacoes.length} combinacoes de tile/quality: ${combinacoes.join(', ')}.`);
        console.log('  Rode com --force para uniformizar antes de usar os numeros acima.');
      }
      if (razaoForaDoMapa.length) {
        const fora = [...new Set(razaoForaDoMapa.map(p => `${p.width} com razao ${p.razao}, esperava ${razaoDaFoto(p.width)}`))];
        console.log(`\n  ATENCAO: ${razaoForaDoMapa.length} piramide(s) com razao que esta rodada nao produziria.`);
        for (const linha of fora.slice(0, 5)) console.log(`    ${linha}`);
        console.log('  Rode com --force para refazer com a escada de agora.');
      }

      const bateTiles = conferencia.tiles === conferencia.tilesDeclarados;
      const bateBytes = conferencia.bytes === conferencia.bytesDeclarados;

      // UMA AMOSTRA POR ESCADA, e nao so a foto mais larga do arquivo. Enquanto
      // o projeto tinha um formato so, a foto mais larga representava todas.
      // Num projeto misto ela representa apenas a escada dela, e a grade da
      // outra escada, gerada por outra razao, sairia sem conferencia nenhuma.
      // A escolhida em cada escada e a PRIMEIRA da lista, que ja vem ordenada
      // por photo_id: assim duas rodadas iguais dao o mesmo veredito.
      const amostras = [];
      const escadasAmostradas = new Set();
      for (const p of piramides) {
        const chave = chaveDaEscada(p);
        if (escadasAmostradas.has(chave)) continue;
        escadasAmostradas.add(chave);
        amostras.push(p);
      }
      const grades = amostras.map(p => conferirGrade(dest, p));
      const gradeOk = grades.length > 0 && grades.every(g => g.ok);

      if (bateTiles && bateBytes) {
        console.log(`\n  Conferencia OK: ${conferencia.tiles} tiles e ${conferencia.bytes} bytes conferem com tile_pyramids.`);
      } else {
        console.log('\n  CONFERENCIA REPROVOU:');
        if (!bateTiles) console.log(`    tiles ${conferencia.tiles} contra tile_count somado ${conferencia.tilesDeclarados}`);
        if (!bateBytes) console.log(`    bytes ${conferencia.bytes} contra total_bytes somado ${conferencia.bytesDeclarados}`);
      }

      if (!grades.length) {
        console.log('  GRADE NAO CONFERIDA: o arquivo nao tem piramide nenhuma.');
      }
      for (const grade of grades) {
        if (grade.ok) {
          console.log(`  Grade OK na amostra ${grade.photoId} (${grade.geometria}): ${grade.gravados} tiles nos (level,x,y) que a escada preve.`);
          continue;
        }
        console.log('  GRADE REPROVOU na amostra:');
        console.log(`    foto ${grade.photoId} (${grade.geometria})`);
        console.log(`    ${grade.esperados} previstos pela escada, ${grade.gravados} gravados`);
        if (grade.faltando.length) {
          console.log(`    ${grade.faltando.length} faltando: ${grade.faltando.slice(0, 10).join(', ')}`);
        }
        if (grade.sobrando.length) {
          console.log(`    ${grade.sobrando.length} sobrando: ${grade.sobrando.slice(0, 10).join(', ')}`);
        }
        console.log('    A escada gravada nao produz a grade do arquivo. Rode com --force.');
      }

      if (falhas.length) {
        console.log(`\n  ${falhas.length} foto(s) falharam:`);
        for (const f of falhas.slice(0, 20)) {
          console.log(`    [${f.etapa}] ${f.displayName ?? f.photoId} (${f.photoId}): ${f.mensagem}`);
        }
        if (falhas.length > 20) console.log(`    ... e mais ${falhas.length - 20}`);
      }

      // --- Resumo em arquivo, para o benchmark ler ---------------------------

      // O benchmark precisa dos mesmos numeros sem reabrir o banco nem repetir as
      // contas: se cada consumidor recalcular a razao, duas versoes dela vao
      // circular. Nome irmao do banco, no mesmo diretorio.
      const resumoPath = join(projectsDir, `${slug}_tiles.json`);
      const LIMITE_FOTOS_NO_JSON = 1000;
      const resumo = {
        schemaVersion: 1,
        projectSlug: slug,
        geradoEm: new Date().toISOString(),
        // A marca da rodada parcial vem PRIMEIRO no arquivo. Quem le o resumo
        // precisa saber que a fila nao terminou antes de olhar qualquer total.
        parcial,
        erro: erroDaRodada ? descreverErro(erroDaRodada) : null,
        origem: projeto.db_filename,
        destino: `${slug}_tiles.db`,
        // `razao` e o que foi PEDIDO, e sai null quando o formato decidiu. Quem
        // quiser a razao que cada foto levou tem `escadas` e `fotos[].razao`
        // abaixo, medidos no banco. Um numero unico aqui mentiria no projeto
        // misto, que tem duas razoes certas ao mesmo tempo.
        parametros: {
          tileSize,
          quality,
          razao: razaoPedida,
          razaoAutomatica: razaoPedida === null,
          razaoPorLargura: RAZAO_POR_LARGURA,
          format: 'webp',
          workers,
        },
        execucao: {
          fotosPedidas: pendentes.length,
          fotosGeradas: feitas,
          fotosPuladas: puladas,
          falhas,
          tempoMs: tempoTotal,
          segundosPorFoto: feitas ? Number((tempoTotal / feitas / 1000).toFixed(3)) : null,
        },
        totais: {
          fotos: conferencia.fotos,
          tiles: conferencia.tiles,
          bytes: conferencia.bytes,
          fotosComparadas: erroOrigem ? 0 : fotosComparadas,
          fotosSemFull,
          bytesComparaveis,
          bytesOriginais,
          // `null` e nao zero quando a origem nao abriu: o consumidor precisa
          // distinguir "medi e deu zero" de "nao medi".
          razao: erroOrigem ? null : Number(razaoDeBytes.toFixed(4)),
          erroOrigem,
          arquivoBytes: tamanhoArquivo,
          bytesPorFoto: { p50: percentil(0.5), p90: percentil(0.9), max: percentil(1) },
        },
        niveis: porNivel.map(n => ({
          level: n.level,
          tiles: n.tiles,
          bytes: n.bytes,
          bytesPorTile: Math.round(n.bytes / n.tiles),
        })),
        // As escadas do arquivo, uma entrada por geometria distinta. `niveis`
        // acima soma os level de TODAS as fotos, e num projeto misto o level 0
        // de uma escada convive com o level 0 da outra: sem esta lista, quem
        // lesse a tabela por nivel acharia que ha uma escada so.
        escadas: escadasOrdenadas.map(([geometria, { escada, razao, fotos, bytes }]) => ({
          geometria,
          fotos,
          bytes,
          razao,
          larguras: escada.map(n => n.width),
          custoTeorico: Number(custoDaEscada(escada).toFixed(4)),
        })),
        conferencia: {
          tilesContados: conferencia.tiles,
          tilesDeclarados: conferencia.tilesDeclarados,
          bytesContados: conferencia.bytes,
          bytesDeclarados: conferencia.bytesDeclarados,
          // A grade entra no `ok` do arquivo, e nao ao lado dele: quem le o
          // resumo para decidir se pode publicar tem UM booleano para olhar.
          // As listas saem truncadas, porque uma escada trocada erra milhares
          // de coordenadas e o JSON viraria o dump do banco. Sao VARIAS grades,
          // uma por escada: no projeto misto uma delas pode reprovar sozinha.
          grades: grades.map(grade => ({
            photoId: grade.photoId,
            geometria: grade.geometria,
            esperados: grade.esperados,
            gravados: grade.gravados,
            faltando: grade.faltando.slice(0, 50),
            sobrando: grade.sobrando.slice(0, 50),
            ok: grade.ok,
          })),
          ok: bateTiles && bateBytes && gradeOk,
        },
        fotosTruncadas: piramides.length > LIMITE_FOTOS_NO_JSON,
        fotos: piramides.slice(0, LIMITE_FOTOS_NO_JSON).map(p => ({
          photoId: p.photo_id,
          width: p.width,
          height: p.height,
          maxLevel: p.max_level,
          tileCount: p.tile_count,
          totalBytes: p.total_bytes,
          bytesMedidos: bytesDaFoto.get(p.photo_id) ?? 0,
          razao: p.razao,
          niveis: montarEscada(p.width, p.height, p.tile_size, p.razao),
        })),
      };
      writeFileSync(resumoPath, `${JSON.stringify(resumo, null, 2)}\n`, 'utf-8');
      console.log(`\n  Resumo gravado em ${resumoPath}${parcial ? ' (rodada parcial)' : ''}`);

      // A grade REPROVA a rodada, junto das somas. Ela e a unica das tres que
      // enxerga escada trocada, entao deixa-la de fora do veredito seria medir e
      // ignorar. Quem chama este script le o codigo de saida, nunca este texto.
      return { ok: bateTiles && bateBytes && gradeOk, parcial, resumoPath };
    } finally {
      // O destino fecha aqui, e nao no caminho feliz. Antes, um erro de worker
      // saia por process.exit(1) com o banco aberto e o WAL sem checkpoint.
      dest.close();
    }
  }
}

// ============================================================
// Entrada
// ============================================================

// O worker roda ESTE mesmo arquivo. Um segundo arquivo so para o corpo do
// worker separaria a matematica da piramide do codigo que a consome, e ela
// precisa ser identica nos dois lados.
if (isMainThread) {
  try {
    await principal();
  } catch (err) {
    // Este catch so pega o que estoura ANTES da fila comecar: argumento
    // invalido, banco ausente, DDL faltando. Nada foi gravado ainda, entao nao
    // ha resumo a salvar. Erro de worker e erro de escrita nao chegam aqui: eles
    // sao capturados dentro de `principal`, que fecha o destino e grava o resumo
    // parcial antes de escolher o codigo de saida.
    console.error(`\nFalhou: ${descreverErro(err)}`);
    process.exit(1);
  }
} else {
  await rodarWorker();
}
