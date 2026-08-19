/**
 * @module scripts/subir-local
 * @description Sobe o `ebgeo_360` e o `ebgeo_web` juntos, num endereco so, para
 * OLHAR com o proprio navegador.
 *
 * E A MESMA TOPOLOGIA QUE O MEDIDOR USA, e de proposito: uma fachada entrega o
 * pacote CONSTRUIDO do ebgeo_web e repassa `/ebgeo_360` para `/api/v1`, como o
 * nginx de producao. Assim o que se ve na tela e o mesmo que o `medir-web.js`
 * mede, e nao uma terceira montagem que ninguem mediu.
 *
 * O MAPA DE FUNDO VEM SUBSTITUIDO POR PADRAO, e isso precisa ficar dito. O
 * `map_sig.js` pendura toda a inicializacao no evento `load` do MapLibre, e o
 * estilo inicial e uma camada raster do OpenStreetMap, na internet. Nesta
 * maquina o pedido nao falha: fica pendurado, e entao nao ha `load`, a tela de
 * carregamento nunca sai e o 360 nunca abre, sem um erro no console. Com o
 * substituto, o mapa 2D fica cinza chapado e todo o resto funciona.
 *
 * Use `--externo passa` numa maquina com internet para ver o mapa de verdade.
 *
 * Uso:
 *   node scripts/subir-local.js
 *   node scripts/subir-local.js --porta-web 3000 --externo passa
 */

import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import config from '../src/config.js';
import { esperarPorta } from './lib/cdp.js';
import { subirFachada } from './lib/fachada.js';

const PREFIXO_360 = '/ebgeo_360';

function lerArgs(argv) {
  const a = { web: null, dist: null, porta: 8081, portaWeb: 3000, externo: 'local', project: null };
  for (let i = 2; i < argv.length; i++) {
    const v = argv[i + 1];
    switch (argv[i]) {
      case '--web': a.web = v; i++; break;
      case '--dist': a.dist = v; i++; break;
      case '--porta': a.porta = parseInt(v, 10); i++; break;
      case '--porta-web': a.portaWeb = parseInt(v, 10); i++; break;
      case '--externo': a.externo = v; i++; break;
      case '--project': a.project = v; i++; break;
      default:
        if (argv[i].startsWith('--')) { console.error(`argumento desconhecido: ${argv[i]}`); process.exit(1); }
    }
  }
  return a;
}

const args = lerArgs(process.argv);
const raizWeb = resolve(args.web || join(config.dataDir, '..', '..', 'ebgeo_web'));
const raizDist = args.dist ? resolve(args.dist) : join(raizWeb, 'dist');

if (!existsSync(raizDist)) {
  console.error(`Nao existe ${raizDist}. Construa o ebgeo_web antes (npm run build_dev).`);
  process.exit(1);
}

/**
 * Avisa se o pacote e mais velho que o fonte.
 *
 * AVISA, e nao recusa: aqui a intencao e olhar, e quem olha pode querer olhar o
 * pacote de ontem de proposito. No `medir-web.js` a mesma checagem RECUSA,
 * porque la um pacote velho vira numero errado sem nada denunciar.
 */
function avisarSeVelho() {
  const maiorEm = (dir) => {
    if (!existsSync(dir)) return 0;
    let maior = 0;
    const pilha = [dir];
    while (pilha.length) {
      const d = pilha.pop();
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        const p = join(d, e.name);
        if (e.isDirectory()) {pilha.push(p);} else { const m = statSync(p).mtimeMs; if (m > maior) maior = m; }
      }
    }
    return maior;
  };
  const fonte = Math.max(maiorEm(join(raizWeb, 'src')), maiorEm(join(raizWeb, 'public')));
  if (fonte > maiorEm(raizDist)) {
    console.log(`  AVISO: o dist esta ${((fonte - maiorEm(raizDist)) / 60000).toFixed(0)} min mais velho que o fonte.`);
    console.log('         Rode `npm run build_dev` no ebgeo_web para ver o codigo atual.');
  }
}

/** Uma foto com piramide, para o link direto sair pronto. */
function fotoDeExemplo() {
  const idx = new Database(config.indexDbPath, { readonly: true });
  const projetos = idx.prepare('SELECT id, slug FROM projects ORDER BY photo_count').all();
  const alvo = args.project ? projetos.find(p => p.slug === args.project) : null;
  for (const p of alvo ? [alvo] : projetos) {
    const caminho = join(config.projectsDbDir, `${p.slug}_tiles.db`);
    if (!existsSync(caminho)) continue;
    const t = new Database(caminho, { readonly: true });
    const foto = t.prepare('SELECT photo_id, width, height FROM tile_pyramids ORDER BY photo_id LIMIT 1').get();
    t.close();
    if (foto) { idx.close(); return { slug: p.slug, ...foto }; }
  }
  idx.close();
  return null;
}

const servidor = spawn(process.execPath, ['src/server.js'], {
  env: { ...process.env, PORT: String(args.porta), LOG_LEVEL: 'info' },
  stdio: ['ignore', 'inherit', 'inherit'],
});

const saude = await esperarPorta(`http://127.0.0.1:${args.porta}/health`);

const fachada = await subirFachada({
  raiz: raizDist,
  prefixo: PREFIXO_360,
  destino: `http://127.0.0.1:${args.porta}/api/v1`,
  porta: args.portaWeb,
  substituirExterno: args.externo === 'local',
});

const foto = fotoDeExemplo();

console.log('');
console.log('  ================================================================');
console.log(`   EBGeo:      ${fachada.url}`);
if (foto) {
  console.log(`   360 direto: ${fachada.url}/#view=360&photo=${foto.photo_id}`);
}
console.log(`   API 360:    http://127.0.0.1:${args.porta}/api/v1/projects`);
console.log(`   Calibracao: http://127.0.0.1:${args.porta}/calibration/`);
console.log('  ================================================================');
console.log('');
console.log(`  ${saude.projects} projetos no ar. Pacote: ${raizDist}`);
if (foto) console.log(`  Foto de exemplo: ${foto.slug}, ${foto.width}x${foto.height}`);
avisarSeVelho();
if (args.externo === 'local') {
  console.log('  O mapa de fundo esta SUBSTITUIDO por um cinza local, porque o');
  console.log('  OpenStreetMap nao responde nesta maquina e sem ele a aplicacao');
  console.log('  nao termina de subir. Use --externo passa se houver internet.');
}
console.log('');
console.log('  Ctrl+C para derrubar os dois.');

const derrubar = async () => {
  console.log('\n  derrubando...');
  try { await fachada.fechar(); } catch { /* ja fechou */ }
  servidor.kill();
  process.exit(0);
};
process.on('SIGINT', derrubar);
process.on('SIGTERM', derrubar);
