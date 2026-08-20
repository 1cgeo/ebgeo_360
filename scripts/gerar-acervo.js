/**
 * @module scripts/gerar-acervo
 * @description Roda a geracao de tiles no ACERVO INTEIRO, projeto a projeto.
 *
 * POR QUE UM ORQUESTRADOR, e nao um laco de shell. Sao cerca de 16 horas de
 * parede e 99 GB de escrita, num processo que vai ser interrompido pelo menos
 * uma vez. Um laco de shell nao sabe retomar, nao vigia o disco e nao deixa
 * registro do que ficou de fora. Este script sabe as tres coisas.
 *
 * PARALELISMO EM DOIS NIVEIS, e eles nao se confundem. DENTRO de um projeto
 * quem paraleliza e o `generate-tiles.js`, com quatro workers: a medida diz que
 * oito rendem 9% (55 s contra 50 s em 120 fotos), porque o gargalo e banda de
 * memoria e nao CPU. Subir `--workers` nao acelera. ENTRE projetos quem
 * paraleliza e o `--paralelos` daqui, que roda N projetos como processos
 * proprios. Cada um escreve no seu banco, entao ninguem disputa transacao. O
 * que eles disputam e DISCO, e por isso o piso de parada cresce com quantos
 * projetos estao em voo (ver `discoNecessarioGB`).
 *
 * ORDEM CRESCENTE DE TAMANHO, de proposito. Defeito de dado aparece nos
 * primeiros minutos, e nao na quarta hora. Quem quiser o contrario usa `--maior`.
 *
 * Uso:
 *   node scripts/gerar-acervo.js --dry-run          # o plano, sem escrever nada
 *   node scripts/gerar-acervo.js                    # roda de verdade
 *   node scripts/gerar-acervo.js --so alegrete,bage # so estes projetos
 *   node scripts/gerar-acervo.js --refazer          # regera o que ja esta pronto
 *   node scripts/gerar-acervo.js --maior            # comeca pelos maiores
 *   node scripts/gerar-acervo.js --paralelos 3      # tres projetos ao mesmo tempo
 *   node scripts/gerar-acervo.js --workers 6        # repassa ao generate-tiles.js
 *   node scripts/gerar-acervo.js --ate 2026-08-18T06:30
 *                                                   # nenhum projeto NOVO comeca depois disso
 *
 * O MODULO TAMBEM EXPORTA as decisoes puras: leitura de argumentos, contagem de
 * piramide que serve, tamanho no disco e piso de parada. Elas tem teste em
 * `tests/unit/gerar-acervo.test.js`. A rodada so acontece quando o arquivo e
 * chamado pela linha de comando, nunca no import: um teste que importasse este
 * modulo e disparasse 99 GB de escrita nao seria teste.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import sharp from 'sharp';
import config from '../src/config.js';
import { razaoParaLargura } from '../public/calibration/js/pyramid-math.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Bytes num GB. Escrito uma vez para o numero nao aparecer solto. @constant {number} */
const BYTES_POR_GB = 1073741824;

/**
 * Folga de disco que a maquina precisa manter mesmo sem escrita nossa.
 *
 * Dez GB cobrem o que o Windows faz por conta propria enquanto a rodada corre:
 * paginacao, temporarios e o WAL dos bancos que o servico ja tem abertos.
 * Este numero NAO cobre projeto nenhum: o custo dos projetos entra por fora, em
 * `discoNecessarioGB`.
 * @constant {number}
 */
const PISO_BASE_GB = 10;

/**
 * Quanto a previsao de arquivo pode errar para baixo.
 *
 * A previsao acerta melhor do que o diario velho sugeria: no easa ela pediu
 * 0,53 GB e o `easa_tiles.db` fechou em 0,502 GB no disco, ou seja errou 5%
 * para MAIS. Os 25% aqui cobrem cinco vezes esse erro, e no sentido perigoso.
 * @constant {number}
 */
const FOLGA_PREVISAO = 1.25;

/**
 * Falhas seguidas que abortam a rodada inteira.
 *
 * Uma falha e azar, tres seguidas sao defeito sistemico, e insistir por mais
 * doze horas so produz um log grande. A doutrina da casa manda re-escalonar ou
 * parar sozinho quando a degradacao persiste depois da primeira mitigacao.
 * @constant {number}
 */
const FALHAS_SEGUIDAS_LIMITE = 3;

/**
 * Quanto o ARQUIVO passa da soma dos tiles que ele guarda.
 *
 * A conta que interessa ao disco nao e a soma dos BLOBs, e o tamanho do
 * arquivo. Com `page_size` de 65536 um tile de 20 KB nao preenche a pagina, e
 * sobra folga em cada uma. Medido em tres projetos ja gerados: 1,168x no
 * museu_cms, 1,332x no blumenau e 1,259x no cigi, ou 1,286x no agregado.
 *
 * Sem este fator o plano subestimava o disco em 28%, o que num acervo de 99 GB
 * de tiles sao 28 GB que ninguem tinha orcado.
 * @constant {number}
 */
const OVERHEAD_SQLITE = 1.286;

/**
 * Os parametros com que ESTA rodada chama o `generate-tiles.js`.
 *
 * A rodada nao passa `--tile`, `--quality` nem `--razao`, entao valem os
 * padroes do gerador: tile 512, qualidade 80 e razao POR FORMATO (`null` diz
 * que o operador nao pediu razao nenhuma).
 *
 * POR QUE UMA COPIA. Importar `generate-tiles.js` para ler as constantes
 * dispararia a geracao, porque aquele modulo roda `principal()` no topo. A
 * copia so e honesta porque o teste le as duas constantes do FONTE do gerador e
 * reprova a divergencia no dia em que o padrao mudar.
 * @constant {{tileSize:number, quality:number, razaoPedida:number|null}}
 */
export const PARAMETROS_DA_RODADA = { tileSize: 512, quality: 80, razaoPedida: null };

// ------------------------------------------------------------------ argumentos

/**
 * Le a linha de comando, e ABORTA no valor invalido em vez de engoli-lo.
 *
 * POR QUE ISTO E UMA FUNCAO, e nao um laco solto no topo. A versao anterior
 * fazia `new Date(argv[++i]).getTime()`, que devolve NaN em qualquer texto que
 * nao seja data. Como `if (opt.ate && ...)` trata NaN como falso, a janela
 * DEIXAVA DE EXISTIR em silencio e a rodada varria a madrugada inteira. O mesmo
 * vale para `--paralelos abc`, que virava 1 sem avisar. Valor que o operador
 * digitou errado tem de parar a rodada na primeira linha, e nao mudar o plano
 * escondido.
 *
 * @param {string[]} argv - Argumentos, ja sem o node e sem o script.
 * @returns {{dryRun:boolean, refazer:boolean, maior:boolean, so:Set<string>|null,
 *            workers:string|null, paralelos:number, ate:number|null}}
 * @throws {Error} Se um valor faltar ou nao for valido.
 */
export function interpretarArgumentos(argv) {
  const opt = {
    dryRun: argv.includes('--dry-run'),
    refazer: argv.includes('--refazer'),
    maior: argv.includes('--maior'),
    so: null,
    workers: null,
    paralelos: 1,
    ate: null,
  };
  // A flag sem valor e erro, e nao ausencia: `--ate` no fim da linha significa
  // que o operador queria uma janela e ela nao existe.
  const valorDe = (i, nome) => {
    const v = argv[i];
    if (v === undefined || v.startsWith('--')) {
      throw new Error(`${nome} exige um valor, e nao veio nenhum depois dele.`);
    }
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--so') opt.so = new Set(valorDe(++i, '--so').split(','));
    if (argv[i] === '--workers') opt.workers = valorDe(++i, '--workers');
    if (argv[i] === '--paralelos') {
      const bruto = valorDe(++i, '--paralelos');
      const n = Number(bruto);
      if (!Number.isInteger(n) || n < 1) {
        throw new Error(`--paralelos pede um inteiro maior ou igual a 1. Recebi "${bruto}".`);
      }
      opt.paralelos = n;
    }
    // `--ate 2026-08-18T06:30` fecha a janela: nenhum projeto NOVO comeca depois
    // disso. O que ja estiver rodando termina, porque matar no meio da escrita
    // deixa banco pela metade e a retomada perde o projeto inteiro.
    if (argv[i] === '--ate') {
      const bruto = valorDe(++i, '--ate');
      const t = Date.parse(bruto);
      if (!Number.isFinite(t)) {
        throw new Error(`--ate pede uma data que o Date entenda, por exemplo 2026-08-18T06:30. Recebi "${bruto}".`);
      }
      opt.ate = t;
    }
  }
  return opt;
}

// ------------------------------------------------------------------ disco

/**
 * Quanto disco a rodada precisa VER LIVRE para bancar `gbPrevistos` de escrita.
 *
 * O piso antigo era fixo em 20 GB e foi dimensionado para UM projeto. Ele estava
 * errado duas vezes. Primeiro, nem um projeto ele cobria: o faxinal sozinho
 * gastou 21,2 GB medidos. Segundo, com `--paralelos 3` tres projetos escrevem ao
 * mesmo tempo, e a checagem so acontecia quando um trabalhador PEGAVA projeto,
 * cega para os vizinhos ja em voo.
 *
 * Aqui o piso escala porque o chamador soma o que esta EM VOO mais o candidato.
 * Com tres projetos do tamanho do faxinal, a conta pede 10 + 1,25 x 63,6 = 89,5
 * GB livres, contra os 20 fixos de antes.
 *
 * @param {number} gbPrevistos - GB de arquivo que os projetos em voo e o candidato ainda vao escrever.
 * @returns {number} GB que precisam estar livres.
 */
export function discoNecessarioGB(gbPrevistos) {
  const gb = Number.isFinite(gbPrevistos) ? Math.max(0, gbPrevistos) : 0;
  return PISO_BASE_GB + FOLGA_PREVISAO * gb;
}

/**
 * Da para comecar mais uma escrita com este espaco livre?
 *
 * A comparacao e `>=` e nao `<` de proposito. `gbLivres()` devolve NaN quando o
 * powershell falha, e `NaN < piso` e FALSO: a versao anterior seguia escrevendo
 * as cegas justamente quando tinha perdido a medida do disco. Aqui a medida
 * ausente reprova.
 *
 * @param {number} livreGB - Espaco livre medido agora.
 * @param {number} gbPrevistos - GB que os projetos em voo e o candidato ainda vao escrever.
 * @returns {boolean}
 */
export function podeEscrever(livreGB, gbPrevistos) {
  if (!Number.isFinite(livreGB)) return false;
  return livreGB >= discoNecessarioGB(gbPrevistos);
}

/**
 * Bytes que um banco de tiles ocupa no disco: o `.db` mais o `-wal`.
 *
 * POR QUE NAO O DISCO LIVRE. A versao anterior media `antes - livre_depois` do
 * DRIVE inteiro. Com projetos em paralelo cada um debitava para si a escrita
 * dos vizinhos, e o diario de uma rodada de 99 GB ficou inutil: ele diz que o
 * easa gastou 1,04 GB contra 0,53 previstos, um estouro de 107%, quando o
 * `easa_tiles.db` tem 0,502 GB no disco e a previsao errou 5%. Qualquer outro
 * processo da maquina tambem entrava nessa conta.
 *
 * O `-wal` entra porque o SQLite pode terminar a rodada com dado ainda la, antes
 * do checkpoint: sem ele a medida sairia menor que a escrita real. O `-shm` fica
 * de fora, e memoria compartilhada de indice, nao dado.
 *
 * @param {string} caminho - Caminho do `{slug}_tiles.db`.
 * @returns {number} Bytes somados, ou 0 se nada existe ainda.
 */
export function bytesNoDisco(caminho) {
  let total = 0;
  for (const sufixo of ['', '-wal']) {
    try {
      total += statSync(`${caminho}${sufixo}`).size;
    } catch {
      // Nao existe ainda, ou o checkpoint ja fechou o -wal. Zero e a resposta certa.
    }
  }
  return total;
}

// ------------------------------------------------------------------ inventario

/**
 * Quantas piramides do arquivo SERVEM para esta rodada.
 *
 * POR QUE NAO UM `COUNT(*)`. A versao anterior contava a tabela inteira e
 * comparava com as fotos vivas. Duas mudancas se cancelavam e o projeto era
 * PULADO: apagar uma foto ja tilada e receber uma foto nova deixa a contagem
 * igual, a piramide da foto nova nunca sai, e a conferencia final ainda imprime
 * que esta tudo completo. Erro que nao da erro e o pior tipo.
 *
 * O filtro e o MESMO do `generate-tiles.js`: tile, qualidade e razao. Piramide
 * com outro tile ou outra qualidade nao serve, porque `total_bytes` e o token do
 * ETag e misturar duas qualidades na mesma panoramica quebra o cliente.
 *
 * A RAZAO SE COMPARA POR FOTO, e nunca como `razao === X` fixo. Quatro projetos
 * do acervo sao MISTOS (blumenau, santiago, tubarao e santana_livramento): a
 * mesma pasta tem fotos de 5760 com razao 2 e de 7680 com razao 1,6. Um filtro
 * de razao unica reprovaria metade do projeto a cada rodada e refaria de graca
 * trabalho bom. Cada linha responde com a LARGURA que ela mesma gravou, e a
 * pergunta e se a razao dela e a que esta rodada produziria para aquela largura.
 *
 * @param {Array<{photo_id:string, width:number, razao:number, tile_size:number, quality:number}>} linhas
 * @param {Set<string>} vivas - Ids das fotos vivas do projeto.
 * @param {{tileSize:number, quality:number, razaoPedida:number|null}} [params]
 * @returns {number}
 */
export function contarPiramidesProntas(linhas, vivas, params = PARAMETROS_DA_RODADA) {
  const { tileSize, quality, razaoPedida } = params;
  let feitas = 0;
  for (const l of linhas) {
    if (!vivas.has(l.photo_id)) continue;
    if (l.tile_size !== tileSize || l.quality !== quality) continue;
    if (l.razao !== razaoParaLargura(l.width, razaoPedida)) continue;
    feitas++;
  }
  return feitas;
}

/**
 * Le as piramides de um banco de tiles ja aberto.
 *
 * Arquivo anterior a coluna `razao` descreve a escada classica de metades. Isso
 * nao e chute: e o `DEFAULT 2` que o proprio `tiles-schema.sql` documenta para o
 * legado. Sem esta ponte o banco velho estouraria no SELECT, cairia no catch e a
 * rodada regeraria o acervo por causa de uma coluna que falta.
 *
 * @param {import('better-sqlite3').Database} db - Banco `{slug}_tiles.db` aberto.
 * @returns {Array<{photo_id:string, width:number, tile_size:number, quality:number, razao:number}>}
 */
export function lerPiramides(db) {
  const temRazao = db.pragma('table_info(tile_pyramids)').some(c => c.name === 'razao');
  const colunaRazao = temRazao ? 'razao' : '2 AS razao';
  return db.prepare(
    `SELECT photo_id, width, tile_size, quality, ${colunaRazao} FROM tile_pyramids`,
  ).all();
}

/**
 * Le a largura NATIVA de uma foto do projeto, para saber a razao da escada.
 *
 * Le do BLOB, e nao de metadado: `photos` nao guarda largura, e deduzir do nome
 * do projeto seria adivinhar. Uma foto basta porque a razao se grava por foto e
 * o gerador decide foto a foto; isto aqui e so para o PLANO.
 * @param {import('better-sqlite3').Database} idx
 * @param {string} dbFilename
 * @param {number} projectId
 * @returns {Promise<number|null>}
 */
async function larguraDeAmostra(idx, dbFilename, projectId) {
  const caminho = resolve(config.projectsDbDir, dbFilename);
  if (!existsSync(caminho)) return null;
  const linha = idx.prepare('SELECT id FROM photos WHERE project_id = ? LIMIT 1').get(projectId);
  if (!linha) return null;
  const db = new Database(caminho, { readonly: true });
  try {
    const img = db.prepare('SELECT full_webp FROM images WHERE photo_id = ?').get(linha.id);
    if (!img) return null;
    const meta = await sharp(img.full_webp).metadata();
    return meta.width ?? null;
  } finally {
    db.close();
  }
}

function gbLivres() {
  const r = spawnSync('powershell', ['-NoProfile', '-Command',
    `(Get-PSDrive -Name (Split-Path -Qualifier '${config.dataDir}').TrimEnd(':')).Free`],
  { encoding: 'utf8' });
  const n = Number(String(r.stdout).trim());
  return Number.isFinite(n) ? n / BYTES_POR_GB : NaN;
}

/**
 * O projeto ja tem piramide COMPLETA?
 *
 * Nao basta o arquivo existir: uma rodada interrompida deixa `{slug}_tiles.db`
 * com parte das fotos. Completo e ter, para cada foto VIVA do projeto, uma
 * piramide com os parametros que esta rodada produziria (ver
 * `contarPiramidesProntas`).
 * @param {import('better-sqlite3').Database} idx
 * @param {string} slug
 * @param {number} projectId
 * @returns {{pronto:boolean, feitas:number, esperadas:number}}
 */
function estado(idx, slug, projectId) {
  const vivas = new Set(idx.prepare(
    `SELECT p.id FROM photos p
      WHERE p.project_id = ?
        AND p.id NOT IN (SELECT photo_id FROM deleted_photos)`,
  ).all(projectId).map(r => r.id));
  const esperadas = vivas.size;
  const caminho = resolve(config.projectsDbDir, `${slug}_tiles.db`);
  if (!existsSync(caminho)) return { pronto: false, feitas: 0, esperadas };
  const db = new Database(caminho, { readonly: true });
  try {
    const feitas = contarPiramidesProntas(lerPiramides(db), vivas, PARAMETROS_DA_RODADA);
    return { pronto: feitas >= esperadas && esperadas > 0, feitas, esperadas };
  } catch {
    return { pronto: false, feitas: 0, esperadas };
  } finally {
    db.close();
  }
}

// ------------------------------------------------------------------ a rodada

/**
 * Monta o plano e roda o acervo. Chamada so pela linha de comando.
 * @returns {Promise<void>}
 */
async function principal() {
  let opt;
  try {
    opt = interpretarArgumentos(process.argv.slice(2));
  } catch (e) {
    console.error(`ABORTADO: ${e.message}`);
    process.exit(1);
  }

  const idx = new Database(config.indexDbPath, { readonly: true });

  const projetos = idx.prepare('SELECT id, slug, db_filename, photo_count FROM projects').all();
  const plano = [];
  for (const p of projetos) {
    if (opt.so && !opt.so.has(p.slug)) continue;
    const largura = await larguraDeAmostra(idx, p.db_filename, p.id);
    const est = estado(idx, p.slug, p.id);
    const origemBytes = idx.prepare('SELECT SUM(full_size_bytes) s FROM photos WHERE project_id = ?').get(p.id).s || 0;
    const razao = razaoParaLargura(largura ?? 0, null);
    // Fator de crescimento MEDIDO, por classe: 1,443x em 5760 (parque_osorio, 120
    // fotos) e 1,813x em 7680 (museu_cms, 76 fotos; cigi confirmou em 1,811x).
    // Nao e estimativa de tabela.
    const fator = razao === 2 ? 1.443 : 1.813;
    // Segundos por foto MEDIDOS com 4 workers, nas mesmas duas amostras.
    const segPorFoto = razao === 2 ? 0.45 : 0.97;
    plano.push({
      ...p, largura, razao, fator, segPorFoto, ...est,
      gbOrigem: origemBytes / BYTES_POR_GB,
      gbTiles: (origemBytes * fator) / BYTES_POR_GB,
      gbDisco: (origemBytes * fator * OVERHEAD_SQLITE) / BYTES_POR_GB,
      horas: (est.esperadas * segPorFoto) / 3600,
    });
  }
  plano.sort((a, b) => (opt.maior ? b.photo_count - a.photo_count : a.photo_count - b.photo_count));

  const aFazer = plano.filter(p => opt.refazer || !p.pronto);
  const prontos = plano.filter(p => p.pronto && !opt.refazer);

  // ---------------------------------------------------------------- o plano

  console.log('PLANO DE GERACAO DO ACERVO');
  console.log(`  projetos no plano: ${plano.length}  |  a fazer: ${aFazer.length}  |  ja prontos: ${prontos.length}`);
  if (prontos.length) console.log(`  prontos: ${prontos.map(p => `${p.slug} (${p.feitas})`).join(', ')}`);
  console.table(aFazer.map(p => ({
    projeto: p.slug,
    fotos: p.esperadas,
    largura: p.largura ?? '?',
    razao: p.razao,
    'GB origem': +p.gbOrigem.toFixed(1),
    'GB tiles (prev)': +p.gbTiles.toFixed(1),
    'GB disco (prev)': +p.gbDisco.toFixed(1),
    'horas (prev)': +p.horas.toFixed(1),
    parcial: p.feitas > 0 ? `${p.feitas}/${p.esperadas}` : '',
  })));

  const gbTotal = aFazer.reduce((a, p) => a + p.gbTiles, 0);
  const gbDiscoTotal = aFazer.reduce((a, p) => a + p.gbDisco, 0);
  const horasTotal = aFazer.reduce((a, p) => a + p.horas, 0);
  const livre = gbLivres();
  const precisaTudo = discoNecessarioGB(gbDiscoTotal);
  console.log(`  TOTAL previsto: ${gbTotal.toFixed(1)} GB de tiles, que viram ${gbDiscoTotal.toFixed(1)} GB de ARQUIVO`);
  console.log(`  Parede prevista: ${horasTotal.toFixed(1)} h com 4 workers, ${opt.paralelos} projeto(s) por vez`);
  console.log(`  Disco livre agora: ${livre.toFixed(1)} GB  |  o plano inteiro pede ${precisaTudo.toFixed(1)} GB`);
  console.log('  Previsao de GB e de horas sai de DOIS projetos medidos, e nao de tabela.');
  console.log('  Nada aqui e medida do acervo: e extrapolacao, e vai errar por projeto.');

  if (opt.dryRun) {
    console.log('\n--dry-run: nada foi escrito.');
    process.exit(0);
  }
  if (!podeEscrever(livre, gbDiscoTotal)) {
    console.error(`\nABORTADO: o disco tem ${livre.toFixed(1)} GB e o plano pede ${precisaTudo.toFixed(1)} GB.`);
    process.exit(1);
  }

  const pastaLog = resolve(__dirname, '..', 'data', 'logs');
  mkdirSync(pastaLog, { recursive: true });
  const diario = resolve(pastaLog, 'gerar-acervo.jsonl');
  const registrar = (o) => {
    // Uma linha por evento, para o diario sobreviver a interrupcao. Sem timestamp
    // de biblioteca: `toISOString` basta e nao traz dependencia.
    writeFileSync(diario, `${JSON.stringify({ quando: new Date().toISOString(), ...o })}\n`, { flag: 'a' });
  };

  registrar({ evento: 'inicio', aFazer: aFazer.map(p => p.slug), gbTotal, gbDiscoTotal, horasTotal, livre });
  console.log(`\nDiario em ${diario}\n`);

  let seguidas = 0;
  const falhas = [];
  const inicioTudo = Date.now();
  let pararTudo = null;

  /**
   * Roda UM projeto, como processo proprio.
   *
   * Processo separado, e nao worker deste script, porque cada projeto escreve no
   * seu banco e o `generate-tiles.js` ja gerencia o proprio pool. Assim o
   * paralelismo entre projetos nao disputa a transacao de ninguem.
   * @param {object} p - Linha do plano.
   * @param {string} rotulo - Prefixo do log.
   * @returns {Promise<{ok:boolean,status:number,seg:number,gastos:number}>}
   */
  function rodarProjeto(p, rotulo) {
    // O gasto se mede no ARQUIVO DE DESTINO, nunca no disco livre do drive. Com
    // projetos em paralelo o drive perde espaco por causa dos vizinhos, e cada
    // um debitaria a escrita dos outros para si.
    const destino = resolve(config.projectsDbDir, `${p.slug}_tiles.db`);
    const bytesAntes = bytesNoDisco(destino);
    const t0 = Date.now();
    const args = ['scripts/generate-tiles.js', '--project', p.slug];
    if (opt.refazer) args.push('--force');
    if (opt.workers) args.push('--workers', opt.workers);

    return new Promise((resolver) => {
      // `pipe` e nao `inherit`: com projetos em paralelo, as barras de progresso
      // se sobrepoem e o log fica ilegivel. Guardamos so as linhas do resumo.
      const filho = spawn(process.execPath, args, { cwd: resolve(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'] });
      let cauda = '';
      const juntar = (d) => { cauda = (cauda + d).slice(-4000); };
      filho.stdout.on('data', juntar);
      filho.stderr.on('data', juntar);
      filho.on('close', (status) => {
        const seg = (Date.now() - t0) / 1000;
        const bytesDepois = bytesNoDisco(destino);
        const gastos = (bytesDepois - bytesAntes) / BYTES_POR_GB;
        const ok = status === 0;
        for (const linha of cauda.split(String.fromCharCode(10))) {
          if (/RAZAO|Tiles:|Conferencia|Grade|Escadas|falha|FALHOU|Erro/i.test(linha)) {
            console.log(`  ${rotulo} ${linha.trim()}`);
          }
        }
        console.log(`  ${rotulo} ${ok ? 'OK' : 'FALHOU'} em ${(seg / 60).toFixed(1)} min. O arquivo cresceu ${gastos.toFixed(2)} GB, previa ${p.gbDisco.toFixed(2)} GB.`);
        registrar({
          evento: ok ? 'projeto-ok' : 'projeto-falhou',
          slug: p.slug, fotos: p.esperadas, razao: p.razao,
          segundos: Math.round(seg), status,
          gbGastos: +gastos.toFixed(2), gbPrevistos: +p.gbDisco.toFixed(2),
          gbArquivo: +(bytesDepois / BYTES_POR_GB).toFixed(2),
          livreDepois: +gbLivres().toFixed(1),
        });
        resolver({ ok, status, seg, gastos });
      });
    });
  }

  // Pool de projetos: `opt.paralelos` correndo ao mesmo tempo, puxando da fila.
  const fila = [...aFazer];
  let proximo = 0;
  // Quem esta escrevendo AGORA. O piso de disco de quem vai pegar projeto conta
  // o que os vizinhos ainda vao escrever, senao tres projetos grandes entram
  // juntos num disco que so cabia um.
  const emVoo = new Set();

  async function trabalhador(id) {
    for (;;) {
      if (pararTudo) return;
      const i = proximo++;
      if (i >= fila.length) return;
      const p = fila[i];

      const livreAgora = gbLivres();
      const gbEmVoo = [...emVoo].reduce((a, x) => a + x.gbDisco, 0);
      const gbPrevistos = gbEmVoo + p.gbDisco;
      if (!podeEscrever(livreAgora, gbPrevistos)) {
        pararTudo = 'disco';
        console.error(`PARANDO: disco em ${livreAgora.toFixed(1)} GB, e ${emVoo.size} projeto(s) em voo mais o ${p.slug} pedem ${discoNecessarioGB(gbPrevistos).toFixed(1)} GB.`);
        registrar({
          evento: 'parada', motivo: 'disco', livre: livreAgora,
          precisa: +discoNecessarioGB(gbPrevistos).toFixed(1),
          emVoo: [...emVoo].map(x => x.slug),
        });
        return;
      }
      if (opt.ate !== null && Date.now() > opt.ate) {
        pararTudo = 'prazo';
        console.error(`PARANDO: passou do prazo. ${fila.length - i} projeto(s) ficaram para depois.`);
        registrar({ evento: 'parada', motivo: 'prazo', restantes: fila.slice(i).map(x => x.slug) });
        return;
      }

      const rotulo = `[t${id} ${i + 1}/${fila.length} ${p.slug}]`;
      console.log(`
=== ${rotulo} ${p.esperadas} fotos, razao ${p.razao}, previa ${p.horas.toFixed(1)} h ===`);
      emVoo.add(p);
      let r;
      try {
        r = await rodarProjeto(p, rotulo);
      } finally {
        emVoo.delete(p);
      }

      if (r.ok) {
        seguidas = 0;
      } else {
        seguidas++;
        falhas.push(p.slug);
        if (seguidas >= FALHAS_SEGUIDAS_LIMITE) {
          pararTudo = 'falhas';
          console.error('PARANDO: falhas seguidas demais. Isto e defeito sistemico, nao azar.');
          registrar({ evento: 'parada', motivo: 'falhas-seguidas', falhas });
          return;
        }
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(opt.paralelos, fila.length) }, (_, k) => trabalhador(k + 1)),
  );

  const horas = (Date.now() - inicioTudo) / 3600000;
  console.log(`\n=== FIM: ${horas.toFixed(1)} h de parede. Falhas: ${falhas.length ? falhas.join(', ') : 'nenhuma'} ===`);
  registrar({ evento: 'fim', horas: +horas.toFixed(2), falhas });

  // Conferencia final, e ela vale mais que o codigo de saida do gerador.
  console.log('\nCONFERENCIA (releitura dos bancos, e nao eco da rodada):');
  let faltando = 0;
  for (const p of plano) {
    const e = estado(idx, p.slug, p.id);
    const marca = e.pronto ? 'ok  ' : 'FALTA';
    if (!e.pronto) faltando++;
    if (!e.pronto || opt.refazer) console.log(`  ${marca} ${p.slug}: ${e.feitas}/${e.esperadas}`);
  }
  console.log(faltando === 0
    ? '  Todos os projetos do plano tem piramide completa.'
    : `  ${faltando} projeto(s) incompleto(s). Rode de novo: o script retoma de onde parou.`);
  process.exitCode = faltando === 0 ? 0 : 1;
}

// A rodada so acontece pela linha de comando. Importar o modulo (o teste importa)
// carrega as funcoes e nao escreve nada.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await principal();
}
