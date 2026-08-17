/**
 * @module scripts/gerar-acervo
 * @description Roda a geracao de tiles no ACERVO INTEIRO, projeto a projeto.
 *
 * POR QUE UM ORQUESTRADOR, e nao um laco de shell. Sao cerca de 16 horas de
 * parede e 99 GB de escrita, num processo que vai ser interrompido pelo menos
 * uma vez. Um laco de shell nao sabe retomar, nao vigia o disco e nao deixa
 * registro do que ficou de fora. Este script sabe as tres coisas.
 *
 * O QUE ELE NAO FAZ: paralelizar projetos. O `generate-tiles.js` ja usa quatro
 * workers, e a medida diz que oito rendem 9% (55 s contra 50 s em 120 fotos),
 * porque o gargalo e banda de memoria e nao CPU. Rodar dois projetos ao mesmo
 * tempo so disputaria os mesmos nucleos e o mesmo disco.
 *
 * ORDEM CRESCENTE DE TAMANHO, de proposito. Defeito de dado aparece nos
 * primeiros minutos, e nao na quarta hora. Quem quiser o contrario usa `--maior`.
 *
 * Uso:
 *   node scripts/gerar-acervo.js --dry-run          # o plano, sem escrever nada
 *   node scripts/gerar-acervo.js                    # roda de verdade
 *   node scripts/gerar-acervo.js --so alegrete,bage # so estes projetos
 *   node scripts/gerar-acervo.js --refazer          # regera o que ja esta pronto
 */

import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import sharp from 'sharp';
import config from '../src/config.js';
import { razaoParaLargura } from '../public/calibration/js/pyramid-math.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Piso de espaco livre, em GB, abaixo do qual a rodada PARA.
 *
 * Encher o disco no meio de uma escrita de SQLite deixa banco pela metade e,
 * pior, pode derrubar outra coisa da maquina. Vinte GB dao folga para o maior
 * projeto do acervo (faxinal, 9,9 GB de origem) mais margem.
 * @constant {number}
 */
const PISO_DISCO_GB = 20;

/**
 * Falhas seguidas que abortam a rodada inteira.
 *
 * Uma falha e azar, tres seguidas sao defeito sistemico, e insistir por mais
 * doze horas so produz um log grande. A doutrina da casa manda re-escalonar ou
 * parar sozinho quando a degradacao persiste depois da primeira mitigacao.
 * @constant {number}
 */
const FALHAS_SEGUIDAS_LIMITE = 3;

// ------------------------------------------------------------------ argumentos

const argv = process.argv.slice(2);
const opt = {
  dryRun: argv.includes('--dry-run'),
  refazer: argv.includes('--refazer'),
  maior: argv.includes('--maior'),
  so: null,
  workers: null,
};
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--so') opt.so = new Set(argv[++i].split(','));
  if (argv[i] === '--workers') opt.workers = argv[++i];
}

// ------------------------------------------------------------------ inventario

const idx = new Database(config.indexDbPath, { readonly: true });

/**
 * Le a largura NATIVA de uma foto do projeto, para saber a razao da escada.
 *
 * Le do BLOB, e nao de metadado: `photos` nao guarda largura, e deduzir do nome
 * do projeto seria adivinhar. Uma foto basta porque a razao se grava por foto e
 * o gerador decide foto a foto; isto aqui e so para o PLANO.
 * @param {string} dbFilename
 * @param {number} projectId
 * @returns {Promise<number|null>}
 */
async function larguraDeAmostra(dbFilename, projectId) {
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
  return Number.isFinite(n) ? n / 1073741824 : NaN;
}

/**
 * O projeto ja tem piramide COMPLETA?
 *
 * Nao basta o arquivo existir: uma rodada interrompida deixa `{slug}_tiles.db`
 * com parte das fotos. Completo e ter uma linha em `tile_pyramids` para cada
 * foto viva do projeto.
 * @param {string} slug
 * @param {number} projectId
 * @returns {{pronto:boolean, feitas:number, esperadas:number}}
 */
function estado(slug, projectId) {
  const esperadas = idx.prepare(
    `SELECT COUNT(*) c FROM photos p
      WHERE p.project_id = ?
        AND p.id NOT IN (SELECT photo_id FROM deleted_photos)`,
  ).get(projectId).c;
  const caminho = resolve(config.projectsDbDir, `${slug}_tiles.db`);
  if (!existsSync(caminho)) return { pronto: false, feitas: 0, esperadas };
  const db = new Database(caminho, { readonly: true });
  try {
    const feitas = db.prepare('SELECT COUNT(*) c FROM tile_pyramids').get().c;
    return { pronto: feitas >= esperadas && esperadas > 0, feitas, esperadas };
  } catch {
    return { pronto: false, feitas: 0, esperadas };
  } finally {
    db.close();
  }
}

const projetos = idx.prepare('SELECT id, slug, db_filename, photo_count FROM projects').all();
const plano = [];
for (const p of projetos) {
  if (opt.so && !opt.so.has(p.slug)) continue;
  const largura = await larguraDeAmostra(p.db_filename, p.id);
  const est = estado(p.slug, p.id);
  const origemBytes = idx.prepare('SELECT SUM(full_size_bytes) s FROM photos WHERE project_id = ?').get(p.id).s || 0;
  const razao = razaoParaLargura(largura ?? 0, null);
  // Fator de crescimento MEDIDO, por classe: 1,443x em 5760 (parque_osorio, 120
  // fotos) e 1,813x em 7680 (museu_cms, 76 fotos). Nao e estimativa de tabela.
  const fator = razao === 2 ? 1.443 : 1.813;
  // Segundos por foto MEDIDOS com 4 workers, nas mesmas duas amostras.
  const segPorFoto = razao === 2 ? 0.45 : 0.97;
  plano.push({
    ...p, largura, razao, fator, segPorFoto, ...est,
    gbOrigem: origemBytes / 1073741824,
    gbTiles: (origemBytes * fator) / 1073741824,
    horas: (est.esperadas * segPorFoto) / 3600,
  });
}
plano.sort((a, b) => (opt.maior ? b.photo_count - a.photo_count : a.photo_count - b.photo_count));

const aFazer = plano.filter(p => opt.refazer || !p.pronto);
const prontos = plano.filter(p => p.pronto && !opt.refazer);

// ------------------------------------------------------------------ o plano

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
  'horas (prev)': +p.horas.toFixed(1),
  parcial: p.feitas > 0 ? `${p.feitas}/${p.esperadas}` : '',
})));

const gbTotal = aFazer.reduce((a, p) => a + p.gbTiles, 0);
const horasTotal = aFazer.reduce((a, p) => a + p.horas, 0);
const livre = gbLivres();
console.log(`  TOTAL previsto: ${gbTotal.toFixed(1)} GB de tiles, ${horasTotal.toFixed(1)} h de parede com 4 workers`);
console.log(`  Disco livre agora: ${livre.toFixed(1)} GB  |  sobraria: ${(livre - gbTotal).toFixed(1)} GB  |  piso de parada: ${PISO_DISCO_GB} GB`);
console.log('  Previsao de GB e de horas sai de DOIS projetos medidos, e nao de tabela.');
console.log('  Nada aqui e medida do acervo: e extrapolacao, e vai errar por projeto.');

if (opt.dryRun) {
  console.log('\n--dry-run: nada foi escrito.');
  process.exit(0);
}
if (!Number.isFinite(livre) || livre - gbTotal < PISO_DISCO_GB) {
  console.error(`\nABORTADO: o disco nao comporta o plano com o piso de ${PISO_DISCO_GB} GB.`);
  process.exit(1);
}

// ------------------------------------------------------------------ a rodada

const pastaLog = resolve(__dirname, '..', 'data', 'logs');
mkdirSync(pastaLog, { recursive: true });
const diario = resolve(pastaLog, 'gerar-acervo.jsonl');
const registrar = (o) => {
  // Uma linha por evento, para o diario sobreviver a interrupcao. Sem timestamp
  // de biblioteca: `toISOString` basta e nao traz dependencia.
  writeFileSync(diario, `${JSON.stringify({ quando: new Date().toISOString(), ...o })}\n`, { flag: 'a' });
};

registrar({ evento: 'inicio', aFazer: aFazer.map(p => p.slug), gbTotal, horasTotal, livre });
console.log(`\nDiario em ${diario}\n`);

let seguidas = 0;
const falhas = [];
const inicioTudo = Date.now();

for (const [i, p] of aFazer.entries()) {
  const antes = gbLivres();
  if (antes < PISO_DISCO_GB) {
    console.error(`PARANDO: disco em ${antes.toFixed(1)} GB, abaixo do piso de ${PISO_DISCO_GB}.`);
    registrar({ evento: 'parada', motivo: 'disco', livre: antes });
    break;
  }

  const rotulo = `[${i + 1}/${aFazer.length}] ${p.slug} (${p.esperadas} fotos, razao ${p.razao})`;
  console.log(`\n=== ${rotulo} ===`);
  const t0 = Date.now();

  const args = ['scripts/generate-tiles.js', '--project', p.slug];
  if (opt.refazer) args.push('--force');
  if (opt.workers) args.push('--workers', opt.workers);
  const r = spawnSync(process.execPath, args, { stdio: 'inherit', cwd: resolve(__dirname, '..') });

  const seg = (Date.now() - t0) / 1000;
  const depois = gbLivres();
  const ok = r.status === 0;

  registrar({
    evento: ok ? 'projeto-ok' : 'projeto-falhou',
    slug: p.slug, fotos: p.esperadas, razao: p.razao,
    segundos: Math.round(seg), status: r.status,
    gbGastos: +(antes - depois).toFixed(2), gbPrevistos: +p.gbTiles.toFixed(2),
    livreDepois: +depois.toFixed(1),
  });

  if (ok) {
    seguidas = 0;
    console.log(`  OK em ${(seg / 60).toFixed(1)} min. Gastou ${(antes - depois).toFixed(1)} GB, previa ${p.gbTiles.toFixed(1)} GB.`);
  } else {
    seguidas++;
    falhas.push(p.slug);
    console.error(`  FALHOU (status ${r.status}). Seguidas: ${seguidas}/${FALHAS_SEGUIDAS_LIMITE}.`);
    if (seguidas >= FALHAS_SEGUIDAS_LIMITE) {
      console.error('PARANDO: falhas seguidas demais. Isto e defeito sistemico, nao azar.');
      registrar({ evento: 'parada', motivo: 'falhas-seguidas', falhas });
      break;
    }
  }
}

const horas = (Date.now() - inicioTudo) / 3600000;
console.log(`\n=== FIM: ${horas.toFixed(1)} h de parede. Falhas: ${falhas.length ? falhas.join(', ') : 'nenhuma'} ===`);
registrar({ evento: 'fim', horas: +horas.toFixed(2), falhas });

// Conferencia final, e ela vale mais que o codigo de saida do gerador.
console.log('\nCONFERENCIA (releitura dos bancos, e nao eco da rodada):');
let faltando = 0;
for (const p of plano) {
  const e = estado(p.slug, p.id);
  const marca = e.pronto ? 'ok  ' : 'FALTA';
  if (!e.pronto) faltando++;
  if (!e.pronto || opt.refazer) console.log(`  ${marca} ${p.slug}: ${e.feitas}/${e.esperadas}`);
}
console.log(faltando === 0
  ? '  Todos os projetos do plano tem piramide completa.'
  : `  ${faltando} projeto(s) incompleto(s). Rode de novo: o script retoma de onde parou.`);
process.exitCode = faltando === 0 ? 0 : 1;
