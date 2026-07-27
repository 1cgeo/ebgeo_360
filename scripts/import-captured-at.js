#!/usr/bin/env node

/**
 * @module scripts/import-captured-at
 * @description Importa a hora de captura de cada foto (`photos.captured_at`) a
 * partir dos metadados do levantamento.
 *
 * A hora NAO serve para achar a fronteira da faixa — essa vem do id de sessao no
 * `original_name`, e por bom motivo (ver capture-runs.js). Ela serve para dois
 * outros fins:
 *
 * 1. Dar `started_at` as faixas cujo NOME nao carrega hora. O id do MULTICAPTURA
 *    e opaco (9468, 4809, 0913), entao sem isto 18 projetos listavam as faixas
 *    por numero de fotos. Basta UMA foto datada por faixa.
 * 2. Guardar a data real da captura, que nao existia em lugar nenhum do banco.
 *
 * O que ela NAO melhora, medido: a ordem DENTRO da faixa. Em quatro projetos com
 * cobertura total (46.266 fotos) reordenar por hora move de 0,00% a 0,01% das
 * fotos e deixa a distribuicao de passo identica, porque o numero do quadro ja e
 * um contador de tempo.
 *
 * FONTES, nesta ordem de preferencia:
 *   - `fotos.geojson`  -> properties.nome_img + properties.time_img
 *   - `*.csv`          -> colunas nome_img/nome + time_img/time
 * Nos dois a hora e um epoch Unix. Os JSON por foto NAO tem hora (so id, img,
 * lon, lat, ele, heading), entao nao sao fonte.
 *
 * Uso:
 *   node scripts/import-captured-at.js --sources "<dir>[,<dir>...]" [--slug <slug>] [--dry-run]
 *
 * Os diretorios entram por argumento de proposito: os caminhos de rede do
 * levantamento nao pertencem ao repositorio.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve, basename, extname } from 'node:path';
import Database from 'better-sqlite3';
import { captureTimeFromName } from './lib/capture-runs.js';

// ============================================================
// CLI
// ============================================================

const args = process.argv.slice(2);
const getArg = (nome, padrao) => {
  const i = args.indexOf(`--${nome}`);
  return i === -1 || i + 1 >= args.length ? padrao : args[i + 1];
};
const dataDir = resolve(getArg('data', './data'));
const slugFiltro = getArg('slug', null);
const dryRun = args.includes('--dry-run');
const doNome = args.includes('--from-name');
const fontes = (getArg('sources', '') || '').split(',').map(s => s.trim()).filter(Boolean);

if (!fontes.length && !doNome) {
  console.error('Uso: node scripts/import-captured-at.js [--sources "<dir>[,<dir>...]"] [--from-name] [--slug <slug>] [--dry-run]');
  console.error('Fontes aceitas: fotos.geojson (nome_img/time_img), *.csv (nome_img|nome + time_img|time)');
  console.error('e --from-name, que deduz a hora do proprio nome nos arquivos PIC_.');
  process.exit(1);
}

// ============================================================
// Hora
// ============================================================

/**
 * Deslocamento do fuso do levantamento, em horas.
 *
 * O `startedAt` que sai do nome PIC_ e hora LOCAL, e a ordenacao das faixas
 * compara as duas como string. Gravar o epoch em UTC misturaria escalas e
 * desordenaria qualquer projeto que tivesse as duas origens. O Brasil nao tem
 * horario de verao desde 2019 e o acervo vai de 2022 a 2025, entao o
 * deslocamento e constante.
 */
const FUSO_HORAS = -3;

/** Menor e maior epoch aceitos: 2015-01-01 e 2035-01-01. Fora disso e lixo. */
const EPOCH_MIN = 1420070400;
const EPOCH_MAX = 2051222400;

/**
 * Converte um epoch Unix para `AAAA-MM-DDTHH:MM:SS` no fuso do levantamento.
 *
 * @param {number} epoch - Segundos desde 1970-01-01 UTC
 * @returns {string} Hora local sem fuso, no mesmo formato do `startedAt`
 */
function paraHoraLocal(epoch) {
  return new Date((epoch + FUSO_HORAS * 3600) * 1000).toISOString().slice(0, 19);
}

/**
 * Le um epoch de um campo de texto, recusando o que estiver fora da janela.
 *
 * @param {string|number} valor - Campo bruto da fonte
 * @returns {number|null} Epoch valido, ou null
 */
function lerEpoch(valor) {
  if (valor === null || valor === undefined) return null;
  const n = Number(String(valor).trim().replace(/^"|"$/g, ''));
  if (!Number.isFinite(n) || n < EPOCH_MIN || n > EPOCH_MAX) return null;
  return Math.trunc(n);
}

// ============================================================
// Leitura resiliente
// ============================================================

const espera = ms => new Promise(r => setTimeout(r, ms));

/**
 * Espera um drive de rede voltar. Mesmo tratamento de migrate.js e
 * import-geojson-photos.js: o drive do levantamento cai no meio da operacao, e
 * um backoff curto so queima as tentativas contra um caminho morto.
 *
 * @param {string} dir - Diretorio que sumiu
 * @param {number} [limiteMs] - Tempo maximo de espera
 * @returns {Promise<boolean>} true se voltou
 */
async function esperarDrive(dir, limiteMs = 30 * 60 * 1000) {
  if (existsSync(dir)) return true;
  const inicio = Date.now();
  let avisou = false;
  while (Date.now() - inicio < limiteMs) {
    if (existsSync(dir)) {
      console.log(`\n  drive de volta apos ${((Date.now() - inicio) / 1000).toFixed(0)}s, retomando`);
      return true;
    }
    if (!avisou) {
      console.log(`\n  AGUARDANDO: ${dir} sumiu — reconecte (desisto em ${limiteMs / 60000} min)`);
      avisou = true;
    }
    await espera(5000);
  }
  return false;
}

const TENTATIVAS = 8;

/**
 * Le um arquivo com repeticao e backoff, tolerando queda do drive.
 *
 * @param {string} caminho - Arquivo a ler
 * @param {string} raiz - Diretorio da fonte, sondado quando some
 * @returns {Promise<string|null>} Conteudo, ou null se desistiu
 */
async function lerArquivo(caminho, raiz) {
  for (let t = 1; t <= TENTATIVAS; t++) {
    try {
      return readFileSync(caminho, 'utf-8');
    } catch (e) {
      if (t === TENTATIVAS) {
        console.warn(`  falhou ao ler ${basename(caminho)}: ${e.message}`);
        return null;
      }
      if (!existsSync(raiz) && !(await esperarDrive(raiz))) return null;
      await espera(Math.min(30000, 300 * 2 ** t));
    }
  }
  return null;
}

/**
 * Lista recursivamente os arquivos de interesse sob um diretorio.
 *
 * A profundidade vai a 10 porque o acervo aninha fundo: o metadado do
 * parque_osorio esta em `street_view_atlas/2_Parque_Osorio/hd_externo_06-06-JUN-2/
 * osorio/streetview/site/site_streetview/Metadados/fotos.geojson`, nivel 8. Com
 * o limite em 6 o projeto sumia inteiro do relatorio, sem erro nenhum.
 *
 * @param {string} raiz - Diretorio inicial
 * @param {number} [profMax] - Profundidade maxima
 * @returns {string[]} Caminhos de fotos.geojson e *.csv
 */
function acharFontes(raiz, profMax = 10) {
  const achados = [];
  const anda = (dir, prof) => {
    if (prof > profMax) return;
    let entradas;
    try {
      entradas = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entradas) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        anda(p, prof + 1);
      } else if (e.name === 'fotos.geojson' || extname(e.name).toLowerCase() === '.csv') {
        achados.push(p);
      }
    }
  };
  anda(raiz, 0);
  return achados;
}

// ============================================================
// Parsers
// ============================================================

/**
 * Quebra uma linha de CSV respeitando aspas duplas.
 *
 * Escrito aqui em vez de trazer dependencia: o formato das fontes e simples
 * (sem quebra de linha dentro do campo) e o projeto nao tem lib de CSV.
 *
 * @param {string} linha - Linha crua
 * @returns {string[]} Campos
 */
function partirCsv(linha) {
  const campos = [];
  let atual = '';
  let dentro = false;
  for (let i = 0; i < linha.length; i++) {
    const c = linha[i];
    if (c === '"') {
      if (dentro && linha[i + 1] === '"') { atual += '"'; i++; } else { dentro = !dentro; }
    } else if (c === ',' && !dentro) {
      campos.push(atual);
      atual = '';
    } else {
      atual += c;
    }
  }
  campos.push(atual);
  return campos;
}

const COL_NOME = ['nome_img', 'nome'];
const COL_TEMPO = ['time_img', 'time'];

/**
 * Extrai pares (nome, epoch) de um CSV do levantamento.
 *
 * @param {string} texto - Conteudo do arquivo
 * @returns {Array<[string, number]>} Pares validos
 */
function paresDoCsv(texto) {
  const linhas = texto.split(/\r?\n/);
  if (!linhas.length) return [];
  const cab = partirCsv(linhas[0]).map(s => s.trim().replace(/^"|"$/g, ''));
  const iNome = cab.findIndex(c => COL_NOME.includes(c));
  const iTempo = cab.findIndex(c => COL_TEMPO.includes(c));
  if (iNome === -1 || iTempo === -1) return [];
  const pares = [];
  for (let i = 1; i < linhas.length; i++) {
    if (!linhas[i]) continue;
    const campos = partirCsv(linhas[i]);
    const nome = (campos[iNome] ?? '').trim().replace(/^"|"$/g, '');
    const epoch = lerEpoch(campos[iTempo]);
    if (nome && epoch !== null) pares.push([nome, epoch]);
  }
  return pares;
}

/**
 * Extrai pares (nome, epoch) de um fotos.geojson do levantamento.
 *
 * @param {string} texto - Conteudo do arquivo
 * @returns {Array<[string, number]>} Pares validos
 */
function paresDoGeojson(texto) {
  let d;
  try {
    d = JSON.parse(texto);
  } catch {
    return [];
  }
  const pares = [];
  for (const f of d.features ?? []) {
    const pr = f?.properties ?? {};
    const epoch = lerEpoch(pr.time_img);
    if (pr.nome_img && epoch !== null) pares.push([String(pr.nome_img), epoch]);
  }
  return pares;
}

// ============================================================
// Banco
// ============================================================

const db = new Database(join(dataDir, 'index.db'));
db.pragma('journal_mode = WAL');

const colunas = db.pragma('table_info(photos)').map(c => c.name);
if (!colunas.includes('captured_at')) {
  console.error('photos nao tem a coluna captured_at.');
  console.error('Suba o servico uma vez (npm start) para aplicar a migracao.');
  process.exit(1);
}

const projetos = db.prepare(
  `SELECT id, slug FROM projects ${slugFiltro ? 'WHERE slug = ?' : ''} ORDER BY slug`,
).all(...(slugFiltro ? [slugFiltro] : []));
if (!projetos.length) {
  console.error(slugFiltro ? `Projeto ${slugFiltro} nao existe.` : 'Nenhum projeto no banco.');
  process.exit(1);
}

// Fotos soft-deleted ficam de fora: elas nao aparecem em nenhum lugar da
// interface e nao entram em faixa nenhuma.
const doBanco = new Map();
const porProjeto = new Map();
for (const p of projetos) {
  const linhas = db.prepare(`
    SELECT ph.id, ph.original_name, ph.captured_at
    FROM photos ph
    WHERE ph.project_id = ?
      AND ph.id NOT IN (SELECT photo_id FROM deleted_photos)
  `).all(p.id);
  porProjeto.set(p.slug, linhas);
  for (const l of linhas) doBanco.set(l.original_name, { id: l.id, slug: p.slug, atual: l.captured_at });
}
console.log(`banco: ${doBanco.size} fotos vivas em ${projetos.length} projeto(s)`);

// ============================================================
// Colheita
// ============================================================

const encontrado = new Map();   // original_name -> Map<epoch, número de fontes>
let lidos = 0;
let ignorados = 0;

for (const raiz of fontes) {
  const dir = resolve(raiz);
  if (!existsSync(dir)) {
    console.warn(`fonte ausente, pulando: ${raiz}`);
    continue;
  }
  const arquivos = acharFontes(dir);
  console.log(`\n${raiz}: ${arquivos.length} arquivo(s) candidato(s)`);
  for (const caminho of arquivos) {
    const texto = await lerArquivo(caminho, dir);
    if (texto === null) continue;
    const pares = basename(caminho) === 'fotos.geojson' ? paresDoGeojson(texto) : paresDoCsv(texto);
    if (!pares.length) continue;
    let uteis = 0;
    for (const [nome, epoch] of pares) {
      if (!doBanco.has(nome)) { ignorados++; continue; }
      uteis++;
      let vistos = encontrado.get(nome);
      if (!vistos) { vistos = new Map(); encontrado.set(nome, vistos); }
      vistos.set(epoch, (vistos.get(epoch) ?? 0) + 1);
    }
    if (uteis) {
      lidos++;
      console.log(`  ${uteis.toString().padStart(6)} de ${pares.length.toString().padStart(6)}  ${caminho.slice(dir.length)}`);
    }
  }
}

console.log(`\narquivos que contribuiram: ${lidos}`);
console.log(`pares descartados por nao existirem no banco: ${ignorados}`);

// Fontes que discordam sobre a mesma foto: a duplicacao de pastas no acervo faz
// a mesma foto aparecer em varios arquivos, e copias divergentes existem.
// Vence o epoch mais frequente; empate vai no mais antigo, que e o disparo real.
let conflitos = 0;
const resolvido = new Map();
for (const [nome, vistos] of encontrado) {
  if (vistos.size > 1) conflitos++;
  let melhor = null;
  for (const [epoch, n] of vistos) {
    if (!melhor || n > melhor[1] || (n === melhor[1] && epoch < melhor[0])) melhor = [epoch, n];
  }
  resolvido.set(nome, melhor[0]);
}
console.log(`fotos com hora encontrada nas fontes: ${resolvido.size}`);
console.log(`fotos em que as fontes discordam: ${conflitos}`);

// O nome PIC_ carrega o inicio da captura, e a camera dispara a cada 4 s. Isso
// da a hora de cada foto sem fonte externa nenhuma, a 2 s do EXIF real. Entra
// so onde a fonte externa nao cobriu: o carimbo do instrumento tem precedencia.
const doNomeMapa = new Map();
if (doNome) {
  for (const [nome] of doBanco) {
    if (resolvido.has(nome)) continue;
    const hora = captureTimeFromName(nome);
    if (hora) doNomeMapa.set(nome, hora);
  }
  console.log(`fotos com hora deduzida do nome: ${doNomeMapa.size}`);
}

// ============================================================
// Relatorio por projeto
// ============================================================

/**
 * Hora final de uma foto: a fonte externa vence, o nome preenche o resto.
 *
 * @param {string} nome - original_name
 * @returns {string|null} `AAAA-MM-DDTHH:MM:SS` local, ou null
 */
function horaDe(nome) {
  const epoch = resolvido.get(nome);
  if (epoch !== undefined) return paraHoraLocal(epoch);
  return doNomeMapa.get(nome) ?? null;
}

const tabela = [];
for (const p of projetos) {
  const linhas = porProjeto.get(p.slug);
  let daFonte = 0;
  let doNomeN = 0;
  let muda = 0;
  for (const l of linhas) {
    const hora = horaDe(l.original_name);
    if (hora === null) continue;
    if (resolvido.has(l.original_name)) daFonte++; else doNomeN++;
    if (l.captured_at !== hora) muda++;
  }
  const com = daFonte + doNomeN;
  if (!com && slugFiltro === null) continue;
  tabela.push({
    projeto: p.slug,
    fotos: linhas.length,
    daFonte,
    doNome: doNomeN,
    cobertura: `${((100 * com) / Math.max(linhas.length, 1)).toFixed(0)}%`,
    aGravar: muda,
  });
}
console.table(tabela);

const totalAGravar = tabela.reduce((s, l) => s + l.aGravar, 0);
console.log(`a gravar: ${totalAGravar} fotos`);

if (dryRun) {
  console.log('\nNada foi gravado (--dry-run).');
  db.close();
  process.exit(0);
}

// ============================================================
// Grava
// ============================================================

const atualizar = db.prepare('UPDATE photos SET captured_at = ? WHERE id = ?');
const gravar = db.transaction(() => {
  let n = 0;
  for (const [nome, alvo] of doBanco) {
    const hora = horaDe(nome);
    if (hora === null || alvo.atual === hora) continue;
    atualizar.run(hora, alvo.id);
    n++;
  }
  return n;
});
const gravadas = gravar();

// Confere RELENDO o banco, e nao pelo retorno do UPDATE.
const conferido = db.prepare(`
  SELECT COUNT(*) AS n FROM photos
  WHERE captured_at IS NOT NULL
    AND id NOT IN (SELECT photo_id FROM deleted_photos)
`).get().n;
console.log(`\ngravadas: ${gravadas}`);
console.log(`releitura do banco: ${conferido} fotos vivas com captured_at`);

db.pragma('wal_checkpoint(TRUNCATE)');
db.close();
console.log('\npronto. Rode `npm run derive-runs` para as faixas herdarem o started_at.');
