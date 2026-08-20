/**
 * @module scripts/comparar-tela
 * @description Fotografa a MESMA cena em dois pacotes do `ebgeo_web` e compara
 * os pixels.
 *
 * POR QUE ELE EXISTE. O `medir-web.js` responde quanto custa, e nao se continua
 * certo. Uma otimizacao de textura pode cortar 80% do trafego de GPU e entregar
 * a panoramica de cabeca para baixo, espelhada ou com uma costura de um pixel
 * entre tiles: todas as colunas melhoram, e a imagem esta errada. Nenhum teste
 * de unidade pega isso, porque o defeito mora na conversa entre `flipY`,
 * `texSubImage2D` e a UV da esfera.
 *
 * O CONTROLE NEGATIVO E O CORACAO DISTO. Alem de comparar A com B, ele compara A
 * com B ESPELHADO na vertical. Se a diferenca espelhada for MENOR que a direta,
 * a imagem virou, e ele reprova dizendo exatamente isso. Sem esse par, uma
 * diferenca pequena nao distingue "igual" de "instrumento cego", e uma grande
 * nao distingue "virou" de "mudou de foto".
 *
 * Uso:
 *   node scripts/comparar-tela.js --antes <dist-a> --depois <dist-b> \
 *     --project museu_cms [--photo <uuid>] [--lon 137 --lat -5 --fov 75]
 *     [--viewport 1904x985] [--salvar <dir>]
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as esperar } from 'node:timers/promises';
import sharp from 'sharp';
import Database from 'better-sqlite3';
import config from '../src/config.js';
import { esperarPorta, subirChrome } from './lib/cdp.js';
import { tratarExterno } from './lib/externo.js';
import { subirFachada } from './lib/fachada.js';
import { gravarRede } from './lib/rede-cdp.js';
import { SONDA_WEB } from './lib/sonda-web.js';

const PREFIXO_360 = '/ebgeo_360';
/** Sem mexer em nada, a tela para de mudar. Este e o teto de espera. */
const MS_LIMITE = 30000;
/** Lado da imagem reduzida em que a diferenca e contada. */
const LARGURA_ANALISE = 256;

function lerArgs(argv) {
  const a = {
    antes: null, depois: null, project: null, photo: null,
    lon: 137, lat: 0, fov: 75, viewport: '1904x985', porta: 8199, salvar: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const v = argv[i + 1];
    switch (argv[i]) {
      case '--antes': a.antes = v; i++; break;
      case '--depois': a.depois = v; i++; break;
      case '--project': a.project = v; i++; break;
      case '--photo': a.photo = v; i++; break;
      case '--lon': a.lon = Number(v); i++; break;
      case '--lat': a.lat = Number(v); i++; break;
      case '--fov': a.fov = Number(v); i++; break;
      case '--viewport': a.viewport = v; i++; break;
      case '--porta': a.porta = parseInt(v, 10); i++; break;
      case '--salvar': a.salvar = v; i++; break;
      default:
        if (argv[i].startsWith('--')) { console.error(`argumento desconhecido: ${argv[i]}`); process.exit(1); }
    }
  }
  return a;
}

const args = lerArgs(process.argv);
for (const obrigatorio of ['antes', 'depois', 'project']) {
  if (!args[obrigatorio]) {
    console.error(`Faltou --${obrigatorio}. Exemplo:\n  node scripts/comparar-tela.js --antes dist-antes --depois dist --project museu_cms`);
    process.exit(1);
  }
}
for (const dir of [args.antes, args.depois]) {
  if (!existsSync(dir)) { console.error(`nao existe: ${dir}`); process.exit(1); }
}

/** Escolhe uma foto com piramide, se o chamador nao apontou uma. */
function escolherFoto() {
  if (args.photo) return args.photo;
  const caminho = join(config.projectsDbDir, `${args.project}_tiles.db`);
  if (!existsSync(caminho)) { console.error(`sem piramide para ${args.project}`); process.exit(1); }
  const db = new Database(caminho, { readonly: true });
  const foto = db.prepare('SELECT photo_id FROM tile_pyramids ORDER BY photo_id LIMIT 1').get();
  db.close();
  if (!foto) { console.error(`nenhuma foto com piramide em ${args.project}`); process.exit(1); }
  return foto.photo_id;
}

/**
 * Sobe um pacote, abre a foto na camera pedida, espera a cena parar e devolve o
 * PNG da tela.
 *
 * A CAMERA VAI NO LINK, e nao num gesto. Dois arrastos nunca param no mesmo
 * lugar, e uma diferenca de meio grau entre as duas fotografias apareceria como
 * uma diferenca de pixel que nao e da mudanca sob teste.
 */
async function fotografar(raizDist, uuid) {
  const [larg, alt] = args.viewport.split('x').map(Number);
  const fachada = await subirFachada({
    raiz: raizDist, prefixo: PREFIXO_360, destino: `http://127.0.0.1:${args.porta}/api/v1`,
  });
  const chrome = await subirChrome({
    largura: larg, altura: alt,
    perfil: `${process.env.TEMP || '/tmp'}/comparar-tela-${process.pid}`,
  });
  const cdp = chrome.cdp;
  try {
    await cdp.enviar('Page.enable');
    await cdp.enviar('Runtime.enable');
    await cdp.enviar('Page.addScriptToEvaluateOnNewDocument', { source: SONDA_WEB });
    const rede = await gravarRede(cdp, fachada.url);
    await tratarExterno(cdp, 'local');

    const link = `${fachada.url}/#view=360&photo=${uuid}&lon=${args.lon}&lat=${args.lat}&fov=${args.fov}`;
    await cdp.enviar('Page.navigate', { url: link });
    const abriu = await cdp.esperarCondicao('!!window.__sonda && window.__sonda.pronto()', 60000);
    if (!abriu) throw new Error(`o 360 nao abriu em ${raizDist}`);

    // Espera a cena parar: nada em voo, nenhum pedido novo e nenhum quadro novo
    // na panoramica por 800 ms.
    const t0 = Date.now();
    let ultimoPedido = -1;
    let ultimoPulso = -1;
    let quietoDesde = Date.now();
    while (Date.now() - t0 < MS_LIMITE) {
      await esperar(100);
      const pedidos = rede.ler().length;
      const pulso = await cdp.avaliar('window.__sonda.pulso()').catch(() => -1);
      if (pedidos !== ultimoPedido || pulso !== ultimoPulso || rede.emVoo() > 0) {
        quietoDesde = Date.now(); ultimoPedido = pedidos; ultimoPulso = pulso;
      } else if (Date.now() - quietoDesde >= 800) {break;}
    }

    const tiles = rede.resumir().porClasse.tile?.n ?? 0;
    const { data } = await cdp.enviar('Page.captureScreenshot', { format: 'png' });
    return { png: Buffer.from(data, 'base64'), tiles };
  } finally {
    await chrome.fechar();
    await fachada.fechar();
  }
}

/** Reduz para cinza pequeno, que e onde a diferenca e contada. */
async function cinza(png) {
  const { data, info } = await sharp(png)
    .greyscale()
    .resize(LARGURA_ANALISE, null, { fit: 'inside' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { px: data, w: info.width, h: info.height };
}

function diferencaMedia(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

/** Espelha na vertical, para o controle negativo. */
function espelharVertical({ px, w, h }) {
  const fora = Buffer.alloc(px.length);
  for (let y = 0; y < h; y++) px.copy(fora, (h - 1 - y) * w, y * w, (y + 1) * w);
  return fora;
}

/** Espelha na horizontal, o outro modo de errar a UV. */
function espelharHorizontal({ px, w, h }) {
  const fora = Buffer.alloc(px.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) fora[y * w + x] = px[y * w + (w - 1 - x)];
  }
  return fora;
}

// ---------------------------------------------------------------- principal

const uuid = escolherFoto();
console.log('Comparacao de tela, pixel a pixel');
console.log(`  Projeto:  ${args.project}   Foto: ${uuid}`);
console.log(`  Camera:   lon ${args.lon}, lat ${args.lat}, campo ${args.fov}`);
console.log(`  Viewport: ${args.viewport}`);
console.log(`  Antes:    ${args.antes}`);
console.log(`  Depois:   ${args.depois}`);
console.log('');

const servidor = spawn(process.execPath, ['src/server.js'], {
  env: { ...process.env, PORT: String(args.porta), LOG_LEVEL: 'warn' },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let codigo = 0;
try {
  await esperarPorta(`http://127.0.0.1:${args.porta}/health`);

  const a = await fotografar(args.antes, uuid);
  console.log(`  antes:  ${a.tiles} tiles, ${(a.png.length / 1024).toFixed(0)} KB de PNG`);
  const b = await fotografar(args.depois, uuid);
  console.log(`  depois: ${b.tiles} tiles, ${(b.png.length / 1024).toFixed(0)} KB de PNG`);

  if (args.salvar) {
    mkdirSync(args.salvar, { recursive: true });
    writeFileSync(join(args.salvar, 'antes.png'), a.png);
    writeFileSync(join(args.salvar, 'depois.png'), b.png);
    console.log(`  telas gravadas em ${args.salvar}`);
  }

  const ca = await cinza(a.png);
  const cb = await cinza(b.png);
  if (ca.w !== cb.w || ca.h !== cb.h) throw new Error('as duas telas tem tamanhos diferentes');

  const direta = diferencaMedia(ca.px, cb.px);
  const vertical = diferencaMedia(ca.px, espelharVertical(cb));
  const horizontal = diferencaMedia(ca.px, espelharHorizontal(cb));

  console.log('\n  diferenca media por pixel, de 0 a 255:');
  console.log(`    A contra B                    ${direta.toFixed(2)}`);
  console.log(`    A contra B espelhado na vertical    ${vertical.toFixed(2)}`);
  console.log(`    A contra B espelhado na horizontal  ${horizontal.toFixed(2)}`);

  const provas = [
    {
      prova: 'as duas telas sao a mesma imagem',
      medido: `${direta.toFixed(2)} de diferenca media`,
      passou: direta < 3,
    },
    {
      prova: 'a imagem NAO esta virada na vertical',
      medido: `direta ${direta.toFixed(2)} contra espelhada ${vertical.toFixed(2)}`,
      passou: direta < vertical,
    },
    {
      prova: 'a imagem NAO esta espelhada na horizontal',
      medido: `direta ${direta.toFixed(2)} contra espelhada ${horizontal.toFixed(2)}`,
      passou: direta < horizontal,
    },
    {
      prova: 'os dois pacotes carregaram tile de panoramica',
      medido: `${a.tiles} e ${b.tiles} tiles`,
      passou: a.tiles > 0 && b.tiles > 0,
    },
  ];

  console.log('');
  for (const p of provas) console.log(`  ${p.passou ? 'ok   ' : 'FALHA'}  ${p.prova}: ${p.medido}`);

  if (provas.every(p => p.passou)) {
    console.log('\n  A imagem nao mudou. O que mudou foi o custo.');
  } else {
    console.log('\n  A IMAGEM MUDOU. Nenhum ganho de custo compra isso.');
    codigo = 1;
  }
} catch (err) {
  console.error('\nFALHOU:', err.message);
  codigo = 1;
} finally {
  servidor.kill();
  process.exitCode = codigo;
}
