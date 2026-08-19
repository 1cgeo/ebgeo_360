/**
 * @module scripts/medir-web
 * @description Mede a navegacao 360 DENTRO DO ebgeo_web, com tiles
 * progressivos, em cenarios que imitam o que o operador faz.
 *
 * POR QUE ELE EXISTE, tendo ja o `medir-parede.js`. Aquele mede a pagina de
 * calibracao: um HTML nu, uma esfera, nenhum mapa. Ele responde "quanto custa a
 * piramide". Este responde outra pergunta, que e a que sobrou: "quanto custa a
 * piramide DENTRO da aplicacao", onde ha MapLibre no minimapa, sobreposicao de
 * navegacao, marcadores, planta baixa e um pacote de alguns MB para carregar
 * antes de qualquer pixel de foto. As duas medidas juntas atribuem culpa: o que
 * aparece nas duas e do motor de tiles, e o que so aparece aqui e da aplicacao.
 *
 * O QUE ELE SOBE (a mesma topologia da producao, e nao a do desenvolvimento):
 *
 *     Chrome headless
 *          |
 *          v
 *     fachada (scripts/lib/fachada.js)
 *          |  /            -> ebgeo_web/dist   (pacote CONSTRUIDO)
 *          |  /ebgeo_360/* -> /api/v1/*        (reescrita igual a do nginx)
 *          v
 *     ebgeo_360 (src/server.js)
 *
 * Medir sobre o `vite dev` daria um numero que nao existe em lugar nenhum:
 * centenas de modulos soltos, compilados no primeiro pedido. Medir em duas
 * origens tambem nao serve, porque a producao tem uma so.
 *
 * DE ONDE VEM CADA NUMERO. Nada sai de variavel da aplicacao. Rede vem do CDP
 * (`encodedDataLength`, o byte que passou no fio). Textura, quadro e travada vem
 * da sonda, que embrulha WebGL e ouve `long-animation-frame`. Aparecer e ficar
 * nitido vem dos PIXELS da tela gravada. A regra e a de sempre: numero que o
 * sistema publica sobre si mesmo e eco, e eco nao e prova.
 *
 * O INSTRUMENTO SE REPROVA. Ao fim de cada rodada o script confere sete
 * afirmacoes que TEM de ser verdade se ele estiver medindo mesmo: o arrasto
 * produz quadro, o ocioso nao produz nenhum, a abertura sobe textura e baixa
 * tile, a tela entrega mais de um quadro, a imagem inteira (aposentada) nao
 * volta, e nenhum salto da 4xx. Falhando qualquer uma, ele diz que os numeros
 * NAO valem, em vez de imprimir uma tabela bonita. Cinco defeitos do proprio
 * medidor foram achados assim, e nenhum deles aparecia como erro: apareciam
 * como zero, que e um numero plausivel.
 *
 * O QUE ESTE SCRIPT DESCOBRIU SOBRE A PARTIDA DO ebgeo_web, e que vale saber
 * antes de rodar: a aplicacao pendura TODA a inicializacao no evento `load` do
 * MapLibre, e o estilo inicial e uma camada raster do OpenStreetMap, na
 * internet. Sem saida para a internet o pedido nao falha, fica pendurado, e
 * entao nao ha `load`, nao ha fim da tela de carregamento e nao ha abertura do
 * 360 por link. Sem um erro no console. Por isso `--externo local` e o padrao
 * (ver scripts/lib/externo.js).
 *
 * Uso:
 *   node scripts/medir-web.js --project museu_cms
 *   node scripts/medir-web.js --project faxinal --fotos 8 --repeticoes 3 \
 *     --viewports 1904x985,1350x673 --perfis mesa,ebnet --json medida.json
 *
 * Argumentos:
 *   --project <slug>     projeto de onde saem as fotos (obrigatorio)
 *   --fotos N            fotos da caminhada (6). Saem de uma faixa de coleta
 *                        real; sem faixa longa o bastante, da ordem de captura
 *   --repeticoes N       repeticoes por cenario (3)
 *   --viewports LxA,...  um Chrome por viewport (1904x985)
 *   --perfis nome,...    mesa | ebnet | movel  (mesa)
 *   --cenarios lista     abertura,caminhada,giro,zoom,ocioso (todos)
 *   --web <caminho>      raiz do ebgeo_web (../ebgeo_web)
 *   --construir          reconstroi o dist antes de medir
 *   --aceitar-dist-velho mede mesmo com o dist mais velho que o fonte
 *   --render always      liga o desenho a cada quadro, para comparar
 *   --externo <modo>     local | passa | bloqueia  (local): o que fazer com o
 *                        recurso que sai da maquina, como o mapa de fundo
 *   --gpu <modo>         hardware | software (hardware): 'software' roda o WebGL
 *                        no SwiftShader, que e o substituto disponivel para
 *                        video integrado fraco
 *   --json <arquivo>     grava a medida crua
 *   --comparar <arquivo> imprime esta medida contra uma anterior, coluna a coluna
 *   --porta N            porta do ebgeo_360 (8199)
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as esperar } from 'node:timers/promises';
import Database from 'better-sqlite3';
import config from '../src/config.js';
import { esperarPorta, subirChrome } from './lib/cdp.js';
import { MODOS, tratarExterno } from './lib/externo.js';
import { subirFachada } from './lib/fachada.js';
import { gravarRede } from './lib/rede-cdp.js';
import { SONDA_WEB } from './lib/sonda-web.js';
import { gravarTela } from './lib/tela.js';

// ---------------------------------------------------------------- constantes

const PREFIXO_360 = '/ebgeo_360';

/**
 * Perfis de maquina e de rede.
 *
 * `mesa` e a estacao onde se desenvolve, e e o piso: nenhum operador tem uma
 * melhor. `ebnet` imita o que a rede do quartel entrega. `movel` e o pior caso
 * plausivel, para achar o joelho da curva.
 *
 * Os numeros de `ebnet` sao um CHUTE DECLARADO, e nao uma medida: ninguem mediu
 * a EBNET de dentro deste script. Trate-os como cenario, e nao como verdade, e
 * corrija-os quando houver medida de campo.
 */
const PERFIS = {
  mesa: { cpu: 1, rede: null },
  ebnet: { cpu: 2, rede: { downloadThroughput: 20e6 / 8, uploadThroughput: 5e6 / 8, latency: 40 } },
  // A maquina velha do quartel na rede do quartel. O fator 6 de CPU e o que
  // separa esta estacao de um i5 de escritorio com uns cinco anos.
  fraco: { cpu: 6, rede: { downloadThroughput: 20e6 / 8, uploadThroughput: 5e6 / 8, latency: 40 } },
  movel: { cpu: 4, rede: { downloadThroughput: 4e6 / 8, uploadThroughput: 1e6 / 8, latency: 150 } },
};

const CENARIOS_PADRAO = ['abertura', 'caminhada', 'giro', 'zoom', 'ocioso'];

/**
 * O titulo de cada tabela.
 *
 * MORA AQUI EM CIMA, e nao ao lado de quem imprime, por causa da zona morta
 * temporal: o corpo principal do script e de nivel superior e roda ANTES das
 * declaracoes `const` que vem depois dele no arquivo. A funcao e icada, a
 * constante nao. O erro (`Cannot access TITULOS before initialization`) so
 * aparece no ultimo passo, depois de toda a medida, e custou uma rodada de
 * vinte minutos.
 */
const TITULOS = {
  abertura: 'ABERTURA (link direto, cache vazio: sobe a aplicacao E abre a foto)',
  caminhada: 'CAMINHADA (aplicacao de pe, troca de foto pela trajetoria)',
  giro: 'GIRO (uma volta inteira em arrastos)',
  zoom: 'ZOOM (75 a 10 graus de campo, e volta: forca troca de nivel)',
  ocioso: 'OCIOSO (tela parada: tudo aqui deveria ser zero)',
};

/** Quanto tempo sem pedido novo e sem quadro novo conta como "assentou". */
const MS_QUIETO = 700;
/** Teto para esperar assentar. Estourar e um resultado, e nao um erro. */
const MS_LIMITE_ASSENTAR = 25000;

// ---------------------------------------------------------------- argumentos

function lerArgs(argv) {
  const a = {
    project: null,
    fotos: 6,
    repeticoes: 3,
    viewports: ['1904x985'],
    perfis: ['mesa'],
    cenarios: [...CENARIOS_PADRAO],
    web: null,
    construir: false,
    aceitarDistVelho: false,
    render: null,
    externo: 'local',
    gpu: 'hardware',
    json: null,
    comparar: null,
    porta: 8199,
  };
  for (let i = 2; i < argv.length; i++) {
    const v = argv[i + 1];
    switch (argv[i]) {
      case '--project': a.project = v; i++; break;
      case '--fotos': a.fotos = parseInt(v, 10); i++; break;
      case '--repeticoes': a.repeticoes = parseInt(v, 10); i++; break;
      case '--viewports': a.viewports = v.split(','); i++; break;
      case '--perfis': a.perfis = v.split(','); i++; break;
      case '--cenarios': a.cenarios = v.split(','); i++; break;
      case '--web': a.web = v; i++; break;
      case '--construir': a.construir = true; break;
      case '--aceitar-dist-velho': a.aceitarDistVelho = true; break;
      case '--render': a.render = v; i++; break;
      case '--externo': a.externo = v; i++; break;
      case '--gpu': a.gpu = v; i++; break;
      case '--json': a.json = v; i++; break;
      case '--comparar': a.comparar = v; i++; break;
      case '--porta': a.porta = parseInt(v, 10); i++; break;
      default:
        if (argv[i].startsWith('--')) {
          console.error(`argumento desconhecido: ${argv[i]}`);
          process.exit(1);
        }
    }
  }
  return a;
}

const args = lerArgs(process.argv);
if (!args.project) {
  console.error('Faltou --project <slug>. Exemplo: node scripts/medir-web.js --project museu_cms');
  process.exit(1);
}
if (!MODOS.includes(args.externo)) {
  console.error(`--externo ${args.externo} nao existe. Modos: ${MODOS.join(', ')}`);
  process.exit(1);
}
for (const p of args.perfis) {
  if (!PERFIS[p]) {
    console.error(`perfil desconhecido: ${p}. Conhecidos: ${Object.keys(PERFIS).join(', ')}`);
    process.exit(1);
  }
}

const raizWeb = resolve(args.web || join(config.dataDir, '..', '..', 'ebgeo_web'));
const raizDist = join(raizWeb, 'dist');

// ---------------------------------------------------------------- o dist

/**
 * Recusa medir um pacote mais velho que o fonte.
 *
 * ESTA GUARDA E O CORACAO DA HONESTIDADE DO SCRIPT. O `dist` e um artefato, e
 * nada no repositorio o invalida quando alguem edita o fonte. Medir um pacote
 * velho produz numeros perfeitamente plausiveis sobre um codigo que nao existe
 * mais, e nada na saida denuncia isso. Ja aconteceu nesta obra com dado gravado
 * contra descritor calculado, e o sintoma foi o mesmo: tudo respondia, e a
 * resposta era de ontem.
 */
function conferirDist() {
  if (!existsSync(raizDist)) {
    if (!args.construir) {
      console.error(`Nao ha ${raizDist}. Rode com --construir, ou construa o ebgeo_web antes.`);
      process.exit(1);
    }
    return;
  }
  const maisNovoDist = maisNovoEm(raizDist);
  const maisNovoFonte = Math.max(
    maisNovoEm(join(raizWeb, 'src')),
    maisNovoEm(join(raizWeb, 'public')),
    arquivoMs(join(raizWeb, 'index.html')),
    arquivoMs(join(raizWeb, 'vite.config.js')),
  );
  if (maisNovoFonte > maisNovoDist) {
    const atraso = ((maisNovoFonte - maisNovoDist) / 60000).toFixed(0);
    if (args.construir) return;
    if (args.aceitarDistVelho) {
      console.warn(`AVISO: o dist esta ${atraso} min mais velho que o fonte. Medindo assim mesmo, por --aceitar-dist-velho.`);
      return;
    }
    console.error(`O dist esta ${atraso} min mais velho que o fonte do ebgeo_web.`);
    console.error('Medir assim daria numero sobre codigo que nao esta mais la.');
    console.error('Rode com --construir, ou com --aceitar-dist-velho se souber o que faz.');
    process.exit(1);
  }
}

function maisNovoEm(dir) {
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
}

function arquivoMs(p) { return existsSync(p) ? statSync(p).mtimeMs : 0; }

function construirWeb() {
  console.log('Construindo o ebgeo_web...');
  const r = spawnSync('npm', ['run', 'build_dev'], { cwd: raizWeb, stdio: 'inherit', shell: true });
  if (r.status !== 0) { console.error('a construcao falhou'); process.exit(1); }
}

// ---------------------------------------------------------------- as fotos

/**
 * Escolhe a caminhada: fotos CONSECUTIVAS de uma mesma faixa de coleta.
 *
 * Nao vale sortear. Fotos vizinhas na trajetoria e que sao o caso interessante,
 * porque e nelas que o cache do navegador tem chance de servir de alguma coisa e
 * que a proxima foto ja esta na tela como seta. Sortear pelo acervo mediria uma
 * navegacao que ninguem faz.
 *
 * @returns {{fotos: Array, piramide: Object}}
 */
function escolherCaminhada(slug, quantas) {
  const caminhoTiles = join(config.projectsDbDir, `${slug}_tiles.db`);
  if (!existsSync(caminhoTiles)) {
    console.error(`Sem piramide para ${slug}. Rode generate-tiles.js antes.`);
    process.exit(1);
  }
  const idx = new Database(config.indexDbPath, { readonly: true });
  const tdb = new Database(caminhoTiles, { readonly: true });

  const projeto = idx.prepare('SELECT id, slug FROM projects WHERE slug = ?').get(slug);
  if (!projeto) { console.error(`projeto ${slug} nao existe no indice`); process.exit(1); }

  const comPiramide = new Set(tdb.prepare('SELECT photo_id FROM tile_pyramids').all().map(r => r.photo_id));

  // A faixa com mais fotos e a que tem mais chance de dar uma sequencia inteira
  // com piramide.
  const faixas = idx.prepare(`
    SELECT run_id, COUNT(*) n FROM photos
     WHERE project_id = ? AND run_id IS NOT NULL
       AND id NOT IN (SELECT photo_id FROM deleted_photos)
     GROUP BY run_id ORDER BY n DESC`).all(projeto.id);

  let fotos = [];
  for (const f of faixas) {
    const seq = idx.prepare(`
      SELECT id, lon, lat, run_position, display_name FROM photos
       WHERE project_id = ? AND run_id = ?
         AND id NOT IN (SELECT photo_id FROM deleted_photos)
       ORDER BY run_position`).all(projeto.id, f.run_id).filter(p => comPiramide.has(p.id));
    if (seq.length >= quantas) { fotos = seq.slice(0, quantas); break; }
  }
  let origem = 'faixa de coleta';
  if (fotos.length < quantas) {
    // Nenhuma faixa da a caminhada inteira, e cai-se na ordem de captura.
    //
    // ISSO E O NORMAL EM LEVANTAMENTO A PE. No museu_cms cada foto tem um
    // `run_id` proprio: sao 76 faixas de uma foto cada, porque quem levanta a
    // pe para a gravacao entre um ponto e outro. A primeira versao guardava a
    // melhor faixa parcial e devolvia UMA foto, e a caminhada media zero salto,
    // calada. O `sequence_number` e a ordem em que a camera disparou, que e a
    // trajetoria de verdade nesses casos.
    fotos = idx.prepare(`
      SELECT id, lon, lat, sequence_number run_position, display_name FROM photos
       WHERE project_id = ? AND id NOT IN (SELECT photo_id FROM deleted_photos)
       ORDER BY sequence_number`).all(projeto.id).filter(p => comPiramide.has(p.id)).slice(0, quantas);
    origem = 'ordem de captura';
  }
  if (!fotos.length) { console.error(`nenhuma foto com piramide em ${slug}`); process.exit(1); }
  if (fotos.length < quantas) {
    console.warn(`AVISO: pedi ${quantas} fotos e ${slug} so tem ${fotos.length} com piramide.`);
  }

  const piramide = tdb.prepare('SELECT * FROM tile_pyramids WHERE photo_id = ?').get(fotos[0].id);
  idx.close(); tdb.close();
  return { fotos, piramide, origem };
}

// ---------------------------------------------------------------- estatistica

function mediana(xs) {
  const s = xs.filter(x => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function p95(xs) {
  const s = xs.filter(x => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))];
}

const kb = (b) => (b == null ? null : Math.round(b / 1024));
const mb = (b) => (b == null ? null : Number((b / 1048576).toFixed(1)));
const ms = (x) => (x == null ? null : Math.round(x));

// ---------------------------------------------------------------- gestos

/**
 * Arrasta o ponteiro sobre a panoramica.
 *
 * PRESSIONA, MOVE, SOLTA, e nao um salto de camera por chamada de funcao. O
 * visualizador so e alcancavel de fora por gesto: o pacote construido tem nome
 * de modulo embaralhado, entao nao ha `import` a fazer da linha de comando. E
 * melhor assim: o gesto passa pelo tratador de ponteiro, pela conta de
 * sensibilidade e pelo laco de quadro, que e onde a travada mora.
 *
 * A conta da rotacao e a do proprio visualizador: 0,1 grau por pixel, escalado
 * pelo campo de visao sobre 75.
 */
async function arrastar(cdp, ret, grausAlvo, fov = 75) {
  const pxPorGrau = 1 / (0.1 * (fov / 75));
  let restante = grausAlvo;
  const maxPorArrasto = ret.w * 0.8;

  while (restante > 0.5) {
    const graus = Math.min(restante, maxPorArrasto / pxPorGrau);
    const dx = graus * pxPorGrau;
    const x0 = ret.cx + ret.w * 0.4;
    const y0 = ret.cy;
    await cdp.enviar('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, button: 'left', clickCount: 1, buttons: 1 });
    const passos = 12;
    for (let i = 1; i <= passos; i++) {
      await cdp.enviar('Input.dispatchMouseEvent', {
        type: 'mouseMoved', x: x0 - (dx * i) / passos, y: y0, button: 'left', buttons: 1,
      });
      await esperar(16);
    }
    await cdp.enviar('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x0 - dx, y: y0, button: 'left', clickCount: 1, buttons: 0 });
    restante -= graus;
    await esperar(60);
  }
}

/** Roda a roda do mouse sobre a panoramica. deltaY negativo aproxima. */
async function rodar(cdp, ret, deltaY, vezes) {
  for (let i = 0; i < vezes; i++) {
    await cdp.enviar('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x: ret.cx, y: ret.cy, deltaX: 0, deltaY, button: 'none', buttons: 0,
    });
    await esperar(60);
  }
}

// ---------------------------------------------------------------- console

/**
 * Ouve o que a aplicacao grita: erro de console e excecao nao tratada.
 *
 * NAO E SO DIAGNOSTICO DO MEDIDOR. Erro de console durante uma navegacao normal
 * e defeito do sistema, e ele nao aparece em nenhuma outra coluna: a rede
 * responde 200, a textura sobe, e a tela ate pinta. Este e o unico canal em que
 * um `catch` silencioso da aplicacao vira numero.
 */
function gravarConsole(cdp) {
  let itens = [];
  const guardar = (tipo, texto) => {
    if (itens.length < 200) itens.push({ tipo, texto: String(texto).slice(0, 300) });
  };
  cdp.ao('Runtime.consoleAPICalled', (p) => {
    if (p.type !== 'error' && p.type !== 'warning') return;
    guardar(p.type, p.args.map(a => a.value ?? a.description ?? a.type).join(' '));
  });
  cdp.ao('Runtime.exceptionThrown', (p) => {
    guardar('excecao', p.exceptionDetails.exception?.description || p.exceptionDetails.text);
  });
  return {
    zerar() { itens = []; },
    ler() { return itens.slice(); },
    erros() { return itens.filter(i => i.tipo !== 'warning'); },
  };
}

// ---------------------------------------------------------------- assentar

/**
 * Espera a cena parar de trabalhar: nada em voo, nenhum pedido novo e nenhum
 * quadro novo por `MS_QUIETO`.
 *
 * ESTOURAR O TETO E UM RESULTADO, e por isso ele volta no objeto em vez de
 * lancar. Uma cena que nunca assenta e exatamente o defeito que se procura, e
 * um erro a esconderia dentro de um `catch`.
 */
async function assentar(cdp, rede, tela, limite = MS_LIMITE_ASSENTAR) {
  const t0 = Date.now();
  let ultimoPedido = rede.ler().length;
  let ultimoPulso = -1;
  let quietoDesde = Date.now();
  let culpado = 'nada mexeu desde o inicio';

  while (Date.now() - t0 < limite) {
    await esperar(80);
    const pedidos = rede.ler().length;
    // O PULSO E DA PANORAMICA, e nao da tela inteira. Contar quadro de tela
    // (`Page.screencastFrame`) parecia mais honesto e nao serve: a aplicacao tem
    // elementos que animam sozinhos, e enquanto qualquer um deles se mexe o
    // Chrome compoe quadro. A espera nunca terminava, e o cenario inteiro batia
    // no teto de 25 s com a foto ja pronta ha 24.
    const pulso = await cdp.avaliar('window.__sonda ? window.__sonda.pulso() : -1').catch(() => -1);
    const mexeu = pedidos !== ultimoPedido || pulso !== ultimoPulso || rede.emVoo() > 0;
    if (mexeu) {
      quietoDesde = Date.now();
      culpado = pedidos !== ultimoPedido ? 'pedido novo'
        : rede.emVoo() > 0 ? 'pedido em voo'
          : 'a panoramica ainda desenha ou sobe textura';
      ultimoPedido = pedidos; ultimoPulso = pulso;
    } else if (Date.now() - quietoDesde >= MS_QUIETO) {
      return { ms: Date.now() - t0 - MS_QUIETO, estourou: false };
    }
  }
  // Estourou. O MOTIVO vai junto, porque "nao assentou" sozinho nao aponta
  // nada: pode ser pedido pendurado, pode ser cena que nunca para de desenhar.
  const emVoo = rede.emVooDetalhe();
  return {
    ms: Date.now() - t0,
    estourou: true,
    motivo: `${culpado}. ${emVoo.length} pedido(s) em voo`
      + (emVoo.length ? `, o mais velho ha ${Math.max(...emVoo.map(r => r.ms))} ms: ${emVoo.slice(0, 3).map(r => `${r.classe} ${r.url}`).join(' | ')}` : '')
      + `; ${tela ? tela.contar() : 0} quadro(s) de tela`,
  };
}

// ---------------------------------------------------------------- cenarios

/**
 * Abre a aplicacao do zero num link direto para a foto, com cache vazio.
 *
 * Mede a experiencia de quem recebe um link compartilhado, que e o unico caminho
 * pelo qual o 360 abre sem a aplicacao ja estar de pe. Ele mistura, de proposito,
 * o custo de subir a aplicacao com o de abrir a foto: e assim que chega ao
 * operador. A separacao das duas parcelas sai da classificacao de rede
 * (`aplicacao` contra `tile`) e do cenario `caminhada`, que ja parte da
 * aplicacao de pe.
 */
async function cenarioAbertura(ctx, uuid) {
  const { cdp, rede, tela, urlBase, consola } = ctx;

  consola.zerar();
  await cdp.enviar('Network.clearBrowserCache');
  await cdp.enviar('Page.navigate', { url: 'about:blank' });
  await esperar(200);

  rede.zerar();
  tela.zerar();
  await tela.ligar();
  const t0 = Date.now();
  await cdp.enviar('Page.navigate', { url: `${urlBase}/${ctx.query}#view=360&photo=${uuid}` });

  const abriu = await cdp.esperarCondicao('!!window.__sonda && window.__sonda.pronto()', 60000);
  const msAberto = Date.now() - t0;

  // O 360 NAO ABRIU: colhe o porque AGORA, enquanto a pagina ainda esta viva.
  // A primeira versao devolvia uma linha de zeros, e zero e um numero plausivel:
  // parecia um sistema que nao baixa nada, e era um medidor olhando uma tela
  // parada na abertura da aplicacao.
  let diagnostico = null;
  if (!abriu) {
    diagnostico = {
      estado: await cdp.avaliar(`JSON.stringify({
        pronto: !!window.__sonda && window.__sonda.pronto(),
        ativo: document.body.classList.contains('streetview-active'),
        carregando: !!document.getElementById('initial-loader'),
        hash: location.hash,
        canvas: document.querySelectorAll('#street-view-container canvas').length,
      })`).catch(e => `nao deu para ler: ${e.message}`),
      emVoo: rede.emVooDetalhe().slice(0, 5),
      console: consola.ler().slice(-8),
      // ONDE A CADEIA PAROU. Uma partida travada sem pedido em voo e sem erro
      // de console so se explica pelo ULTIMO recurso que chegou: e dali que o
      // proximo deveria ter sido pedido.
      ultimos: rede.ler().slice(-8).map(r => `${r.status ?? r.falhou ?? '?'} ${r.classe} ${r.url.slice(-70)}`),
      porClasse: Object.fromEntries(Object.entries(rede.resumir().porClasse).map(([k, c]) => [k, c.n])),
    };
  }
  const acalmou = await assentar(cdp, rede, tela);
  const sonda = await cdp.avaliar('JSON.stringify(window.__sonda.ler())').then(JSON.parse).catch(() => null);
  const pixels = await tela.analisar(t0);
  await tela.desligar();

  return {
    ok: abriu,
    diagnostico,
    console: consola.erros(),
    msAteAbrir: msAberto,
    msAteAssentar: msAberto + acalmou.ms,
    estourou: acalmou.estourou,
    motivo: acalmou.motivo || null,
    rede: rede.resumir(),
    sonda,
    pixels,
  };
}

/**
 * Caminha pela trajetoria, uma foto por vez, com a aplicacao ja de pe.
 *
 * O salto se da pelo link de compartilhamento (o `hash`), e nao pelo clique na
 * seta. E DELIBERADO, e a diferenca precisa ficar dita: pelo hash mede-se a
 * TROCA DE FOTO, que e o caminho caro (descartar textura, pedir descritor, pedir
 * tiles, recompor canvas). Nao se mede o apanhador de clique da seta, que e
 * barato e que exigiria adivinhar onde a seta esta desenhada.
 */
async function cenarioCaminhada(ctx, fotos) {
  const { cdp, rede, tela } = ctx;
  const saltos = [];

  for (let i = 1; i < fotos.length; i++) {
    rede.zerar();
    tela.zerar();
    await tela.ligar();
    await cdp.avaliar('window.__sonda.zerar()');
    const t0 = Date.now();
    await cdp.avaliar(`location.hash = ${JSON.stringify(`#view=360&photo=${fotos[i].id}`)}`);
    // O ouvinte de hash tem um amortecedor de 100 ms antes de agir. A espera e
    // pelo PEDIDO da foto nova, visto pelo CDP, e nao pelo `resource timing` da
    // pagina: o buffer dele guarda 250 entradas e descarta calado numa
    // caminhada longa, o que faria a espera estourar sem motivo.
    const chegou = await rede.esperarPedido(r => r.uuid === fotos[i].id, 20000);
    const acalmou = await assentar(cdp, rede, tela);
    const sonda = await cdp.avaliar('JSON.stringify(window.__sonda.ler())').then(JSON.parse).catch(() => null);
    const pixels = await tela.analisar(t0);
    await tela.desligar();
    saltos.push({
      de: fotos[i - 1].id, para: fotos[i].id, ok: chegou,
      msAteAssentar: Date.now() - t0 - MS_QUIETO,
      estourou: acalmou.estourou, motivo: acalmou.motivo || null,
      rede: rede.resumir(), sonda, pixels,
    });
  }
  return { saltos };
}

/**
 * Gira a vista uma volta inteira, em arrastos sucessivos.
 *
 * DUAS FASES, porque duas coisas diferentes doem. `durante` e o arrasto: e ali
 * que a mao sente a travada, e o numero que importa e o bloqueio da thread.
 * `assentar` e o depois: os tiles do novo azimute chegam e sobem para a GPU, e o
 * numero que importa e quanto tempo a vista fica borrada.
 */
async function cenarioGiro(ctx, graus = 360) {
  const { cdp, rede, tela } = ctx;
  const ret = await cdp.avaliar('JSON.stringify(window.__sonda.retangulo())').then(JSON.parse);
  if (!ret) return { ok: false, motivo: 'sem canvas de panoramica' };

  rede.zerar();
  tela.zerar();
  await tela.ligar();
  await cdp.avaliar('window.__sonda.zerar()');
  const t0 = Date.now();
  await arrastar(cdp, ret, graus);
  const msDurante = Date.now() - t0;
  const durante = await cdp.avaliar('JSON.stringify(window.__sonda.ler())').then(JSON.parse);
  const redeDurante = rede.resumir();

  const acalmou = await assentar(cdp, rede, tela);
  const total = await cdp.avaliar('JSON.stringify(window.__sonda.ler())').then(JSON.parse);
  const pixels = await tela.analisar(t0);
  await tela.desligar();

  return {
    ok: true, graus,
    msDurante, msAteAssentar: Date.now() - t0 - MS_QUIETO, estourou: acalmou.estourou, motivo: acalmou.motivo || null,
    durante: { sonda: durante, rede: redeDurante },
    total: { sonda: total, rede: rede.resumir() },
    pixels,
  };
}

/**
 * Aproxima ate o campo minimo e volta.
 *
 * E o cenario que forca TROCA DE NIVEL da piramide, que e a operacao cara: o
 * canvas se refaz num tamanho novo e a textura inteira sobe de novo. O numero a
 * observar e quantos niveis foram pedidos: descer e subir de novo no mesmo gesto
 * (vaivem de nivel) e desperdicio puro.
 */
async function cenarioZoom(ctx) {
  const { cdp, rede, tela } = ctx;
  const ret = await cdp.avaliar('JSON.stringify(window.__sonda.retangulo())').then(JSON.parse);
  if (!ret) return { ok: false, motivo: 'sem canvas de panoramica' };

  rede.zerar();
  tela.zerar();
  await tela.ligar();
  await cdp.avaliar('window.__sonda.zerar()');
  const t0 = Date.now();

  // 0,05 grau de campo por unidade de roda: 13 voltas de -100 vao de 75 a 10.
  await rodar(cdp, ret, -100, 13);
  const aproximou = await assentar(cdp, rede, tela);
  const naAproximacao = { sonda: await cdp.avaliar('JSON.stringify(window.__sonda.ler())').then(JSON.parse), rede: rede.resumir() };

  await rodar(cdp, ret, 100, 13);
  const afastou = await assentar(cdp, rede, tela);
  const total = { sonda: await cdp.avaliar('JSON.stringify(window.__sonda.ler())').then(JSON.parse), rede: rede.resumir() };
  const pixels = await tela.analisar(t0);
  await tela.desligar();

  return {
    ok: true,
    msAproximar: aproximou.ms, msAfastar: afastou.ms,
    estourou: aproximou.estourou || afastou.estourou,
    motivo: aproximou.motivo || afastou.motivo || null,
    naAproximacao, total, pixels,
  };
}

/**
 * Nao faz nada por tres segundos, e conta o que a aplicacao faz sozinha.
 *
 * E o cenario mais barato e o mais diagnostico. O visualizador diz desenhar so
 * quando ha o que mudar; se isso for verdade, o ocioso tem zero quadro, zero
 * textura e zero pedido. Qualquer numero diferente de zero aqui e trabalho
 * gasto com a tela parada, e ele custa bateria e disputa a thread com o gesto
 * seguinte.
 */
async function cenarioOcioso(ctx, segundos = 3) {
  const { cdp, rede, tela } = ctx;
  rede.zerar();
  tela.zerar();
  await tela.ligar();
  await cdp.avaliar('window.__sonda.zerar()');
  await esperar(segundos * 1000);
  const sonda = await cdp.avaliar('JSON.stringify(window.__sonda.ler())').then(JSON.parse);
  const quadrosDeTela = tela.contar();
  await tela.desligar();
  return { segundos, sonda, rede: rede.resumir(), quadrosDeTela };
}

// ---------------------------------------------------------------- extracao

/** Puxa, de um retorno de sonda, so o que vai para a tabela. */
/**
 * Puxa, de um retorno de sonda, so o que vai para a tabela.
 *
 * A PANORAMICA E O MAPA SAO CONTADOS SEPARADO, e essa separacao ja consertou um
 * erro meu. A primeira versao somava a textura de TODOS os contextos WebGL e
 * chamava o total de "GPU da panoramica". Medido no museu_cms, a abertura
 * acusava 301 MB; abrindo por contexto, 288 MB eram da panoramica e 13 MB do
 * MapLibre, que tem DOIS contextos na pagina (o mapa 2D e o minimapa do 360).
 * Num projeto com o mapa mais carregado a mistura inverteria a conclusao.
 *
 * ALOCAR E SUBIR SAO COISAS DIFERENTES. O three.js em WebGL2 reserva a textura
 * com `texStorage2D` (nenhum pixel viaja) e so depois manda pixel com
 * `texSubImage2D`. Somar os dois num numero so faz uma troca de nivel parecer
 * o dobro do que ela custa em banda.
 *
 * O TEMPO DENTRO DA CHAMADA NAO E O CUSTO. Medido: 216 MB de `texSubImage2D` em
 * menos de 1 ms de relogio. Nao ha copia de CPU ai: o canvas ja mora na GPU, e
 * a chamada so enfileira uma copia de textura para textura. O preco aparece
 * como banda de GPU e memoria, e nao como thread principal parada. Por isso a
 * coluna de MB e a que importa, e `pior quadro` (LoAF) e que responde pela
 * travada sentida.
 */
function resumoDaSonda(sonda) {
  if (!sonda) return {};
  const entradas = Object.entries(sonda.contextos || {});
  const daPanoramica = entradas.filter(([k]) => k.startsWith('panorama'));
  const doMapa = entradas.filter(([k]) => !k.startsWith('panorama'));

  const somaDe = (grupo) => {
    let alocBytes = 0, subidoBytes = 0, chamadas = 0, ms = 0, maior = 0, quadros = 0, draws = 0, mip = 0, rp = 0;
    const tamanhos = [];
    for (const [, c] of grupo) {
      for (const t of c.tamanhos || []) tamanhos.push(t);
      alocBytes += c.texStorage2D.bytes || 0;
      subidoBytes += (c.texImage2D.bytes || 0) + (c.texSubImage2D.bytes || 0) + (c.compressedTexImage2D.bytes || 0);
      chamadas += c.texImage2D.n + c.texSubImage2D.n + c.compressedTexImage2D.n;
      ms += c.texImage2D.ms + c.texSubImage2D.ms + c.texStorage2D.ms;
      maior = Math.max(maior, c.texImage2D.maiorBytes, c.texSubImage2D.maiorBytes);
      quadros += c.quadros;
      draws += c.draws;
      mip += c.generateMipmap.n;
      rp += c.readPixels.n;
    }
    tamanhos.sort((a, b) => a.t - b.t);
    return { alocBytes, subidoBytes, chamadas, ms, maior, quadros, draws, mip, rp, tamanhos };
  };

  const p = somaDe(daPanoramica);
  const m = somaDe(doMapa);

  return {
    quadrosPanorama: p.quadros,
    quadrosMapa: m.quadros,
    drawsPanorama: p.draws,
    uploads: p.chamadas,
    subidoMB: mb(p.subidoBytes),
    alocadoMB: mb(p.alocBytes),
    uploadMs: Math.round(p.ms),
    maiorUploadMB: mb(p.maior),
    mapaMB: mb(m.subidoBytes),
    mapaUploads: m.chamadas,
    decodifica: sonda.decodifica?.n ?? null,
    decodificaMs: sonda.decodifica?.ms ?? null,
    compoe: sonda.compoe?.n ?? null,
    compoeMs: sonda.compoe?.ms ?? null,
    compoeMpx: sonda.compoe?.megapixels ?? null,
    mipmaps: p.mip,
    readPixels: p.rp,
    tamanhos: p.tamanhos,
    // Os tamanhos DISTINTOS de textura que a panoramica alocou, do menor para o
    // maior. Cada um e um canvas refeito por inteiro.
    canvasRefeitos: [...new Set(p.tamanhos.filter(t => t.chamada !== 'texSubImage2D').map(t => `${t.w}x${t.h}`))],
    quadrosLentos: sonda.travada.quadrosLentos,
    piorQuadroMs: Math.round(sonda.travada.piorQuadroMs),
    bloqueioMs: Math.round(sonda.travada.bloqueioTotalMs),
    piorEventoMs: Math.round(sonda.travada.piorEventoMs),
    heapMB: sonda.memoria ? Number(sonda.memoria.heapUsadoMB.toFixed(1)) : null,
    temLoaf: sonda.temLoaf,
  };
}

function resumoDaRede(r) {
  if (!r) return {};
  const c = r.porClasse || {};
  return {
    pedidos: r.pedidos,
    KB: kb(r.bytes),
    tiles: c.tile?.n ?? 0,
    tilesKB: kb(c.tile?.bytes ?? 0),
    tileMsP50: ms(c.tile?.msP50),
    tileMsMax: ms(c.tile?.msMax),
    nivelMax: r.nivelMax,
    imagemCheia: c['imagem-cheia']?.n ?? 0,
    aplicacaoKB: kb(c.aplicacao?.bytes ?? 0),
    externos: c.externo?.n ?? 0,
    externosKB: kb(c.externo?.bytes ?? 0),
    doCache: r.doCache,
    // O 4xx INTERNO e o que acusa defeito nosso. O externo, com
    // `--externo local`, e o proprio substituto respondendo 404 a um recurso
    // que nao tem substituto (um TileJSON de terreno, por exemplo): contá-lo
    // junto fazia toda abertura imprimir "ATENCAO: 1 resposta 4xx", e um alarme
    // que sempre toca deixa de ser alarme.
    status4xx5xx: r.statusRuim - (c.externo?.statusRuim ?? 0),
    status4xx5xxExterno: c.externo?.statusRuim ?? 0,
    falhas: r.falhas - (c.externo?.falhas ?? 0),
    falhasExterno: c.externo?.falhas ?? 0,
    naoConcluidos: r.naoConcluidos,
  };
}

// ---------------------------------------------------------------- principal

conferirDist();
if (args.construir) construirWeb();

const { fotos, piramide, origem } = escolherCaminhada(args.project, args.fotos);

console.log('Medida do 360 dentro do ebgeo_web');
console.log(`  Projeto:     ${args.project}`);
console.log(`  Piramide:    ${piramide.width}x${piramide.height}, tile ${piramide.tile_size}, ${piramide.max_level + 1} niveis, razao ${piramide.razao ?? 2}`);
console.log(`  Caminhada:   ${fotos.length} fotos por ${origem} (${fotos[0].display_name} ...)`);
console.log(`  Viewports:   ${args.viewports.join(', ')}`);
console.log(`  Perfis:      ${args.perfis.join(', ')}`);
console.log(`  Cenarios:    ${args.cenarios.join(', ')}`);
console.log(`  Repeticoes:  ${args.repeticoes}`);
console.log(`  Pacote:      ${raizDist}`);
console.log('');

const servidor = spawn(process.execPath, ['src/server.js'], {
  env: { ...process.env, PORT: String(args.porta), LOG_LEVEL: 'warn' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let saidaServidor = '';
servidor.stdout.on('data', d => { saidaServidor += d; });
servidor.stderr.on('data', d => { saidaServidor += d; });

const bruto = [];
let fachada = null;
let chrome = null;

try {
  const saude = await esperarPorta(`http://127.0.0.1:${args.porta}/health`);
  console.log(`  ebgeo_360 no ar: ${saude.projects} projetos, porta ${args.porta}`);

  fachada = await subirFachada({
    raiz: raizDist,
    prefixo: PREFIXO_360,
    destino: `http://127.0.0.1:${args.porta}/api/v1`,
  });
  console.log(`  fachada no ar:   ${fachada.url}  (${PREFIXO_360} -> /api/v1)`);

  // Uma prova de que a fachada faz o que diz, antes de qualquer medida. Sem
  // isso, um erro de reescrita apareceria so como "o 360 nao carregou", muito
  // depois, no meio de uma tabela.
  const provaDescritor = await fetch(`${fachada.url}${PREFIXO_360}/photos/${fotos[0].id}/tiles.json`);
  if (!provaDescritor.ok) throw new Error(`a fachada nao entrega o descritor: HTTP ${provaDescritor.status}`);
  const desc = await provaDescritor.json();
  console.log(`  descritor ok:    ${desc.levels.length} niveis, tile ${desc.tileSize}`);
  console.log('');

  for (const viewport of args.viewports) {
    const [larg, alt] = viewport.split('x').map(Number);

    for (const nomePerfil of args.perfis) {
      const perfil = PERFIS[nomePerfil];
      chrome = await subirChrome({
        largura: larg, altura: alt,
        // SEM GPU, o Chrome cai no SwiftShader, que desenha WebGL na CPU. Nao e
        // um video integrado de verdade, e e o que da para emular: ele paga
        // caro em BANDA DE TEXTURA e em preenchimento, que sao exatamente os
        // dois lugares onde a panoramica gasta. Leia como piso pessimista.
        semGpu: args.gpu === 'software',
        // O PID entra no nome: duas medidas ao mesmo tempo travariam o mesmo
        // diretorio de perfil, e o Chrome sai com codigo 21 sem explicar nada.
        perfil: `${process.env.TEMP || '/tmp'}/medir-web-${process.pid}-${larg}-${nomePerfil}`,
      });
      const cdp = chrome.cdp;
      await cdp.enviar('Page.enable');
      await cdp.enviar('Runtime.enable');
      await cdp.enviar('Performance.enable').catch(() => {});
      await cdp.enviar('Page.addScriptToEvaluateOnNewDocument', { source: SONDA_WEB });

      const rede = await gravarRede(cdp, fachada.url);
      const tela = await gravarTela(cdp);
      const consola = gravarConsole(cdp);

      if (perfil.cpu > 1) await cdp.enviar('Emulation.setCPUThrottlingRate', { rate: perfil.cpu });
      if (perfil.rede) await cdp.enviar('Network.emulateNetworkConditions', { offline: false, ...perfil.rede });
      const contaExterno = await tratarExterno(cdp, args.externo);

      const query = args.render ? `?render=${args.render}` : '';
      const ctx = { cdp, rede, tela, consola, urlBase: fachada.url, query };

      console.log(`\n=== ${viewport}, perfil ${nomePerfil}${args.render ? `, render=${args.render}` : ''} ===`);
      const real = await (async () => {
        await cdp.enviar('Page.navigate', { url: `${fachada.url}/${query}` });
        await cdp.esperarCondicao('document.readyState === "complete"', 60000);
        return cdp.avaliar('JSON.stringify({w:innerWidth,h:innerHeight,dpr:devicePixelRatio})');
      })();
      console.log(`  viewport real: ${real}`);
      console.log(`  externo (${args.externo}): ${contaExterno.substituidos} substituido(s), `
        + `${contaExterno.semResposta} em 404, ${contaExterno.bloqueados} bloqueado(s)`);

      for (let rep = 0; rep < args.repeticoes; rep++) {
        const marca = { viewport, perfil: nomePerfil, rep };

        if (args.cenarios.includes('abertura')) {
          let r = await cenarioAbertura(ctx, fotos[0].id);
          // UMA segunda tentativa, CONTADA. Uma partida travada perde a
          // repeticao inteira, e numa rodada de meia hora isso custa caro; mas
          // esconder a tentativa faria a medida parecer mais estavel do que e.
          // Por isso ela entra no registro e vira prova no fim.
          if (!r.ok) {
            console.log('             (travou na partida, segunda tentativa)');
            const segunda = await cenarioAbertura(ctx, fotos[0].id);
            segunda.repetiu = true;
            segunda.diagnosticoDaPrimeira = r.diagnostico;
            r = segunda;
          }
          bruto.push({ ...marca, cenario: 'abertura', foto: fotos[0].id, r });
          const s = resumoDaSonda(r.sonda); const n = resumoDaRede(r.rede);
          console.log(`  abertura   rep${rep}  abriu ${ms(r.msAteAbrir)} ms, assentou ${ms(r.msAteAssentar)} ms, `
            + `nitido ${r.pixels?.msNitido ?? '?'} ms | ${n.pedidos} req ${n.KB} KB (tile ${n.tiles}/${n.tilesKB} KB, nivel ${n.nivelMax}) `
            + `| GPU panorama ${s.subidoMB} MB subidos + ${s.alocadoMB} MB alocados (mapa ${s.mapaMB} MB) `
            + `| ${s.quadrosPanorama} quadro(s) | pior quadro ${s.piorQuadroMs} ms`);
          if (!r.ok) {
            console.log(`             NAO ABRIU. estado ${r.diagnostico.estado}`);
            if (r.diagnostico.emVoo.length) console.log(`             em voo: ${r.diagnostico.emVoo.map(x => `${x.classe} ${x.ms} ms`).join(', ')}`);
            console.log(`             por classe: ${JSON.stringify(r.diagnostico.porClasse)}`);
            for (const u of r.diagnostico.ultimos) console.log(`             ultimo: ${u}`);
            for (const c of r.diagnostico.console) console.log(`             [${c.tipo}] ${c.texto}`);
          }
          if (r.console?.length) console.log(`             ${r.console.length} erro(s) de console na abertura: ${r.console[0].texto.slice(0, 120)}`);
          if (r.estourou) console.log(`             NAO ASSENTOU em ${MS_LIMITE_ASSENTAR} ms: ${r.motivo}`);
          if (n.imagemCheia) console.log(`             ATENCAO: ${n.imagemCheia} pedido(s) da imagem inteira, que foi aposentada`);
          if (n.status4xx5xx) console.log(`             ATENCAO: ${n.status4xx5xx} resposta(s) 4xx/5xx`);
        }

        // Os cenarios seguintes exigem o visualizador ja aberto.
        if (!(await cdp.avaliar('!!window.__sonda && window.__sonda.pronto()').catch(() => false))) {
          await cdp.enviar('Page.navigate', { url: `${fachada.url}/${query}#view=360&photo=${fotos[0].id}` });
          await cdp.esperarCondicao('!!window.__sonda && window.__sonda.pronto()', 60000);
          await assentar(cdp, rede, null);
        }

        if (args.cenarios.includes('ocioso')) {
          const r = await cenarioOcioso(ctx);
          bruto.push({ ...marca, cenario: 'ocioso', r });
          const s = resumoDaSonda(r.sonda);
          console.log(`  ocioso     rep${rep}  ${r.segundos} s parado: ${s.quadrosPanorama} quadro(s), `
            + `${s.uploads} upload(s), ${r.rede.pedidos} pedido(s), ${r.quadrosDeTela} quadro(s) de tela`);
        }

        if (args.cenarios.includes('giro')) {
          const r = await cenarioGiro(ctx);
          bruto.push({ ...marca, cenario: 'giro', r });
          if (r.ok) {
            const d = resumoDaSonda(r.durante.sonda); const t = resumoDaSonda(r.total.sonda);
            const n = resumoDaRede(r.total.rede);
            console.log(`  giro       rep${rep}  ${r.graus} graus em ${ms(r.msDurante)} ms, assentou ${ms(r.msAteAssentar)} ms `
              + `| durante: ${d.quadrosPanorama} quadros, ${d.subidoMB} MB, bloqueio ${d.bloqueioMs} ms, pior quadro ${d.piorQuadroMs} ms `
              + `| total: ${t.subidoMB} MB subidos + ${t.alocadoMB} alocados, ${n.tiles} tiles ${n.tilesKB} KB`);
          } else {console.log(`  giro       rep${rep}  NAO RODOU: ${r.motivo}`);}
        }

        if (args.cenarios.includes('zoom')) {
          const r = await cenarioZoom(ctx);
          bruto.push({ ...marca, cenario: 'zoom', r });
          if (r.ok) {
            const t = resumoDaSonda(r.total.sonda); const n = resumoDaRede(r.total.rede);
            const niveis = Object.keys(r.total.rede.tilesPorNivel || {}).map(Number).sort((a, b) => a - b);
            console.log(`  zoom       rep${rep}  aproximar ${ms(r.msAproximar)} ms, afastar ${ms(r.msAfastar)} ms `
              + `| niveis pedidos ${niveis.join(',') || 'nenhum'} | ${n.tiles} tiles ${n.tilesKB} KB `
              + `| GPU ${t.subidoMB} MB subidos + ${t.alocadoMB} alocados em ${t.uploads} chamada(s), pior quadro ${t.piorQuadroMs} ms`);
          } else {console.log(`  zoom       rep${rep}  NAO RODOU: ${r.motivo}`);}
        }

        if (args.cenarios.includes('caminhada')) {
          const r = await cenarioCaminhada(ctx, fotos);
          bruto.push({ ...marca, cenario: 'caminhada', r });
          const tempos = r.saltos.map(s => s.msAteAssentar);
          const gpu = r.saltos.map(s => resumoDaSonda(s.sonda).subidoMB);
          const tls = r.saltos.map(s => resumoDaRede(s.rede).tiles);
          const cache = r.saltos.map(s => s.rede.doCache);
          console.log(`  caminhada  rep${rep}  ${r.saltos.length} saltos: mediana ${ms(mediana(tempos))} ms, pior ${ms(Math.max(...tempos))} ms `
            + `| GPU/salto ${mediana(gpu)} MB | tiles/salto ${mediana(tls)} | do cache ${mediana(cache)}`);
        }
      }

      await chrome.fechar(); chrome = null;
    }
  }

  if (fachada.erros.length) {
    console.log(`
  AVISO: a fachada registrou ${fachada.erros.length} erro(s). Os tres primeiros:`);
    for (const e of fachada.erros.slice(0, 3)) console.log(`    ${e.url}: ${e.erro}`);
  }

  imprimirConsolidado(bruto);
  if (args.comparar) compararCom(bruto, args.comparar);
  const veredito = conferirInstrumento(bruto);
  imprimirVeredito(veredito);

  if (args.json) {
    writeFileSync(args.json, JSON.stringify({
      quando: new Date().toISOString(),
      args, piramide, fotos: fotos.map(f => f.id), bruto, veredito,
    }, null, 2));
    console.log(`\n  Medida crua em ${args.json}`);
  }
  if (!veredito.aprovado) process.exitCode = 1;
} catch (err) {
  console.error('\nFALHOU:', err.message);
  if (err.stack) console.error(err.stack.split('\n').slice(1, 4).join('\n'));
  if (saidaServidor) console.error('Saida do ebgeo_360:\n' + saidaServidor.slice(-2000));
  process.exitCode = 1;
} finally {
  if (chrome) await chrome.fechar();
  if (fachada) await fachada.fechar();
  servidor.kill();
}

// ---------------------------------------------------------------- consolidado

function consolidar(linhas) {
  const chaves = [...new Set(linhas.map(l => `${l.viewport}|${l.perfil}`))];

  const abertura = [];
  const giro = [];
  const zoom = [];
  const caminhada = [];
  const ocioso = [];

  for (const chave of chaves) {
    const [viewport, perfil] = chave.split('|');
    const dos = (cenario) => linhas.filter(l => l.viewport === viewport && l.perfil === perfil && l.cenario === cenario);

    const a = dos('abertura');
    if (a.length) {
      abertura.push({
        viewport, perfil,
        'ms abrir': ms(mediana(a.map(x => x.r.msAteAbrir))),
        'ms assentar': ms(mediana(a.map(x => x.r.msAteAssentar))),
        'ms nitido': ms(mediana(a.map(x => x.r.pixels?.msNitido))),
        'req': ms(mediana(a.map(x => x.r.rede.pedidos))),
        'KB total': ms(mediana(a.map(x => kb(x.r.rede.bytes)))),
        'KB app': ms(mediana(a.map(x => resumoDaRede(x.r.rede).aplicacaoKB))),
        'KB tile': ms(mediana(a.map(x => resumoDaRede(x.r.rede).tilesKB))),
        'tiles': ms(mediana(a.map(x => resumoDaRede(x.r.rede).tiles))),
        'GPU subido MB': mediana(a.map(x => resumoDaSonda(x.r.sonda).subidoMB)),
        'GPU alocado MB': mediana(a.map(x => resumoDaSonda(x.r.sonda).alocadoMB)),
        'mapa MB': mediana(a.map(x => resumoDaSonda(x.r.sonda).mapaMB)),
        'quadros': ms(mediana(a.map(x => resumoDaSonda(x.r.sonda).quadrosPanorama))),
        'canvas': [...new Set(a.flatMap(x => resumoDaSonda(x.r.sonda).canvasRefeitos))].join(' '),
        'pior quadro ms': ms(mediana(a.map(x => resumoDaSonda(x.r.sonda).piorQuadroMs))),
        'heap MB': mediana(a.map(x => resumoDaSonda(x.r.sonda).heapMB)),
      });
    }

    const g = dos('giro').filter(x => x.r.ok);
    if (g.length) {
      giro.push({
        viewport, perfil,
        'ms arrasto': ms(mediana(g.map(x => x.r.msDurante))),
        'ms assentar': ms(mediana(g.map(x => x.r.msAteAssentar))),
        'quadros': ms(mediana(g.map(x => resumoDaSonda(x.r.durante.sonda).quadrosPanorama))),
        'bloqueio ms': ms(mediana(g.map(x => resumoDaSonda(x.r.durante.sonda).bloqueioMs))),
        'pior quadro ms': ms(mediana(g.map(x => resumoDaSonda(x.r.durante.sonda).piorQuadroMs))),
        'p95 pior quadro': ms(p95(g.map(x => resumoDaSonda(x.r.durante.sonda).piorQuadroMs))),
        'resposta ms': ms(mediana(g.map(x => resumoDaSonda(x.r.durante.sonda).piorEventoMs))),
        'GPU subido MB': mediana(g.map(x => resumoDaSonda(x.r.total.sonda).subidoMB)),
        'GPU alocado MB': mediana(g.map(x => resumoDaSonda(x.r.total.sonda).alocadoMB)),
        'maior upload MB': mediana(g.map(x => resumoDaSonda(x.r.total.sonda).maiorUploadMB)),
        'mapa MB': mediana(g.map(x => resumoDaSonda(x.r.total.sonda).mapaMB)),
        'tiles': ms(mediana(g.map(x => resumoDaRede(x.r.total.rede).tiles))),
        'KB tile': ms(mediana(g.map(x => resumoDaRede(x.r.total.rede).tilesKB))),
      });
    }

    const z = dos('zoom').filter(x => x.r.ok);
    if (z.length) {
      zoom.push({
        viewport, perfil,
        'ms aproximar': ms(mediana(z.map(x => x.r.msAproximar))),
        'ms afastar': ms(mediana(z.map(x => x.r.msAfastar))),
        'niveis pedidos': [...new Set(z.flatMap(x => Object.keys(x.r.total.rede.tilesPorNivel || {})))].map(Number).sort((a2, b2) => a2 - b2).join(',') || 'nenhum',
        'canvas alocados': [...new Set(z.flatMap(x => resumoDaSonda(x.r.total.sonda).canvasRefeitos))].join(' ') || 'nenhum',
        'tiles': ms(mediana(z.map(x => resumoDaRede(x.r.total.rede).tiles))),
        'KB tile': ms(mediana(z.map(x => resumoDaRede(x.r.total.rede).tilesKB))),
        'GPU subido MB': mediana(z.map(x => resumoDaSonda(x.r.total.sonda).subidoMB)),
        'GPU alocado MB': mediana(z.map(x => resumoDaSonda(x.r.total.sonda).alocadoMB)),
        'uploads': ms(mediana(z.map(x => resumoDaSonda(x.r.total.sonda).uploads))),
        'quadros': ms(mediana(z.map(x => resumoDaSonda(x.r.total.sonda).quadrosPanorama))),
        'pior quadro ms': ms(mediana(z.map(x => resumoDaSonda(x.r.total.sonda).piorQuadroMs))),
      });
    }

    const c = dos('caminhada');
    if (c.length) {
      const saltos = c.flatMap(x => x.r.saltos);
      caminhada.push({
        viewport, perfil,
        'saltos': saltos.length,
        'ms p50': ms(mediana(saltos.map(s => s.msAteAssentar))),
        'ms p95': ms(p95(saltos.map(s => s.msAteAssentar))),
        // NAO se usa `msNitido` no salto, e a razao e do metodo: a foto
        // anterior continua na tela ate a nova pintar, entao o quadro zero do
        // salto ja e nitido e a metrica responde 6 ms, que nao quer dizer nada.
        // O que importa e quando a tela TROCOU e quando ela parou de mudar.
        'ms ate trocar p50': ms(mediana(saltos.map(s => s.pixels?.msPrimeiraMudanca))),
        'ms ate parar p50': ms(mediana(saltos.map(s => s.pixels?.msUltimaMudanca))),
        'tiles p50': ms(mediana(saltos.map(s => resumoDaRede(s.rede).tiles))),
        'KB p50': ms(mediana(saltos.map(s => kb(s.rede.bytes)))),
        'do cache p50': ms(mediana(saltos.map(s => s.rede.doCache))),
        'decode n p50': ms(mediana(saltos.map(s => resumoDaSonda(s.sonda).decodifica))),
        'decode ms p50': ms(mediana(saltos.map(s => resumoDaSonda(s.sonda).decodificaMs))),
        'compoe ms p50': ms(mediana(saltos.map(s => resumoDaSonda(s.sonda).compoeMs))),
        'compoe Mpx p50': ms(mediana(saltos.map(s => resumoDaSonda(s.sonda).compoeMpx))),
        'GPU subido MB p50': mediana(saltos.map(s => resumoDaSonda(s.sonda).subidoMB)),
        'GPU alocado MB p50': mediana(saltos.map(s => resumoDaSonda(s.sonda).alocadoMB)),
        'quadros p50': ms(mediana(saltos.map(s => resumoDaSonda(s.sonda).quadrosPanorama))),
        'pior quadro p95': ms(p95(saltos.map(s => resumoDaSonda(s.sonda).piorQuadroMs))),
        'heap final MB': mediana(saltos.slice(-3).map(s => resumoDaSonda(s.sonda).heapMB)),
      });
    }

    const o = dos('ocioso');
    if (o.length) {
      ocioso.push({
        viewport, perfil,
        's parado': o[0].r.segundos,
        'quadros panorama': ms(mediana(o.map(x => resumoDaSonda(x.r.sonda).quadrosPanorama))),
        'quadros mapa': ms(mediana(o.map(x => resumoDaSonda(x.r.sonda).quadrosMapa))),
        'uploads': ms(mediana(o.map(x => resumoDaSonda(x.r.sonda).uploads))),
        'GPU subido MB': mediana(o.map(x => resumoDaSonda(x.r.sonda).subidoMB)),
        'pedidos': ms(mediana(o.map(x => x.r.rede.pedidos))),
        'quadros de tela': ms(mediana(o.map(x => x.r.quadrosDeTela))),
      });
    }
  }

  return { abertura, caminhada, giro, zoom, ocioso };
}

function imprimirConsolidado(linhas) {
  console.log('\n\nCONSOLIDADO (mediana das repeticoes)');
  const t = consolidar(linhas);
  for (const [nome, tabela] of Object.entries(t)) {
    if (tabela.length) { console.log(`\n${TITULOS[nome]}`); console.table(tabela); }
  }
}

/**
 * Compara esta medida com uma anterior, coluna a coluna.
 *
 * E ISTO QUE FECHA O LACO DE MELHORIA. Medir uma vez diz onde doi; medir de novo
 * depois de mexer diz se o conserto funcionou, e e a unica maneira honesta de
 * saber. Sem esta funcao a comparacao sairia por leitura de duas tabelas lado a
 * lado, que e onde se ve o que se quer ver.
 *
 * A comparacao e sempre da MESMA chave (cenario, viewport, perfil). Comparar um
 * viewport com outro nao mede conserto nenhum, mede tela diferente, e o 360
 * escolhe o nivel da piramide justamente pela largura da tela.
 *
 * `melhorSeMenor` marca o sentido de cada coluna. Sem isso, "mais quadros" e
 * "mais milissegundos" pareceriam a mesma coisa, e um numero que subiu por bem
 * viraria alarme falso.
 */
function compararCom(linhas, caminhoAntes) {
  let antes;
  try {
    antes = JSON.parse(readFileSync(caminhoAntes, 'utf8'));
  } catch (err) {
    console.log(`\n  Nao deu para ler a medida anterior (${caminhoAntes}): ${err.message}`);
    return;
  }
  const tAntes = consolidar(antes.bruto || []);
  const tAgora = consolidar(linhas);

  console.log(`\n\nCONTRA A MEDIDA DE ${antes.quando || '?'}`);
  if (antes.args?.project !== args.project) {
    console.log(`  ATENCAO: a medida anterior e do projeto ${antes.args?.project}, e esta e de ${args.project}.`);
    console.log('  Piramide de formato diferente nao se compara: leia como referencia, e nao como conserto.');
  }

  // Colunas em que MENOS e melhor. As de fora (quadros, tiles, do cache) nao tem
  // sentido unico, e saem sem veredito.
  const melhorSeMenor = /^(ms |GPU |KB |req|pedidos|bloqueio|pior|resposta|uploads|mapa MB|heap)/;

  for (const nome of Object.keys(TITULOS)) {
    const linhasAntes = tAntes[nome] || [];
    const linhasAgora = tAgora[nome] || [];
    if (!linhasAgora.length || !linhasAntes.length) continue;
    const saida = [];
    for (const agora of linhasAgora) {
      const velho = linhasAntes.find(x => x.viewport === agora.viewport && x.perfil === agora.perfil);
      if (!velho) continue;
      const linha = { viewport: agora.viewport, perfil: agora.perfil };
      for (const [coluna, valor] of Object.entries(agora)) {
        if (coluna === 'viewport' || coluna === 'perfil') continue;
        const v = velho[coluna];
        if (typeof valor !== 'number' || typeof v !== 'number') continue;
        const delta = valor - v;
        if (v === 0 && delta === 0) continue;
        const pct = v === 0 ? null : (delta / v) * 100;
        const seta = melhorSeMenor.test(coluna) ? (delta < 0 ? 'melhor' : delta > 0 ? 'PIOR' : 'igual') : '';
        linha[coluna] = `${v} -> ${valor}${pct === null ? '' : ` (${pct > 0 ? '+' : ''}${pct.toFixed(0)}%)`}${seta ? ` ${seta}` : ''}`;
      }
      saida.push(linha);
    }
    if (saida.length) { console.log(`\n${TITULOS[nome]}`); console.table(saida); }
  }
}

// ---------------------------------------------------------------- veredito

/**
 * Confere o INSTRUMENTO, e nao o sistema.
 *
 * Verificacao que nao pode reprovar nao e verificacao. Estas quatro provas sao
 * afirmacoes que TEM de ser verdade se a medida estiver acontecendo de verdade,
 * e cada uma delas ja falhou uma vez nesta obra por defeito do medidor, e nao do
 * medido: filtro de URL que nao casava com o token de geracao, contador que
 * usava heuristica de nivel, tela que nunca recebeu o segundo quadro.
 */
function conferirInstrumento(linhas) {
  const provas = [];
  const cenario = (n) => linhas.filter(l => l.cenario === n);

  const giros = cenario('giro').filter(x => x.r.ok);
  const ociosos = cenario('ocioso');
  const aberturas = cenario('abertura');
  const caminhadas = cenario('caminhada');

  if (giros.length) {
    const quadrosGiro = mediana(giros.map(x => resumoDaSonda(x.r.durante.sonda).quadrosPanorama)) ?? 0;
    provas.push({
      prova: 'o arrasto do ponteiro chega ao visualizador e produz quadro',
      medido: `${quadrosGiro} quadro(s) na panoramica durante o arrasto`,
      passou: quadrosGiro > 10,
    });
  }

  if (ociosos.length) {
    // A PROVA MAIS BARATA E A MAIS FORTE. Com a tela parada o visualizador nao
    // deve desenhar nada, e o valor esperado e ZERO exato. Se aparecer quadro
    // aqui, ou a sonda esta contando errado, ou o desenho sob demanda nao esta
    // valendo, e nos dois casos os numeros dos outros cenarios estao sujos.
    //
    // NAO SE COMPARA giro CONTRA ocioso EM TEXTURA, e isso ja foi tentado: o
    // giro legitimamente sobe zero textura quando o canvas ja tem a panoramica
    // inteira, entao a prova reprovava um sistema que estava certo.
    const quadrosOcioso = mediana(ociosos.map(x => resumoDaSonda(x.r.sonda).quadrosPanorama)) ?? 0;
    provas.push({
      prova: 'o ocioso nao desenha (a tela parada nao custa quadro)',
      medido: `${quadrosOcioso} quadro(s) em ${ociosos[0].r.segundos} s parado`,
      passou: quadrosOcioso === 0,
    });
  }

  if (aberturas.length) {
    const naoAbriram = aberturas.filter(x => !x.r.ok).length;
    provas.push({
      prova: 'toda abertura abriu o 360',
      medido: `${naoAbriram} de ${aberturas.length} nao abriu`,
      passou: naoAbriram === 0,
    });
    const repetidas = aberturas.filter(x => x.r.repetiu).length;
    provas.push({
      prova: 'nenhuma abertura precisou de segunda tentativa',
      medido: `${repetidas} de ${aberturas.length} travou na primeira`,
      passou: repetidas === 0,
      // AVISA, e nao bloqueia. A repeticao que travou foi refeita e a medida que
      // entrou na mediana e boa, entao invalidar a rodada inteira por causa dela
      // seria exagero. Mas o numero precisa aparecer: uma partida que trava
      // as vezes e defeito, e some se ninguem contar.
      severidade: 'avisa',
    });
    const semConsole = aberturas.filter(x => (x.r.console?.length ?? 0) > 0).length;
    provas.push({
      prova: 'a abertura nao produz erro de console',
      medido: `${semConsole} de ${aberturas.length} com erro`,
      passou: semConsole === 0,
    });
    const subiu = mediana(aberturas.map(x => resumoDaSonda(x.r.sonda).subidoMB)) ?? 0;
    provas.push({
      prova: 'a abertura sobe textura na panoramica',
      medido: `${subiu} MB`,
      passou: subiu > 0,
    });
    const tiles = mediana(aberturas.map(x => resumoDaRede(x.r.rede).tiles)) ?? 0;
    provas.push({
      prova: 'a abertura baixa tile de panoramica',
      medido: `${tiles} tile(s)`,
      passou: tiles > 0,
    });
    const quadrosTela = mediana(aberturas.map(x => x.r.pixels?.quadros)) ?? 0;
    provas.push({
      prova: 'a gravacao de tela entrega mais de um quadro',
      medido: `${quadrosTela} quadro(s) de tela`,
      passou: quadrosTela > 1,
    });
    const imagem = aberturas.reduce((s, x) => s + resumoDaRede(x.r.rede).imagemCheia, 0);
    provas.push({
      prova: 'a imagem inteira nao e mais pedida (aposentada em 2026-08-19)',
      medido: `${imagem} pedido(s)`,
      passou: imagem === 0,
    });
  }

  if (caminhadas.length) {
    const ruins = caminhadas.flatMap(x => x.r.saltos).filter(s => resumoDaRede(s.rede).status4xx5xx > 0).length;
    provas.push({
      prova: 'nenhum salto da 4xx/5xx',
      medido: `${ruins} salto(s) com resposta ruim`,
      passou: ruins === 0,
    });
  }

  return {
    provas,
    aprovado: provas.every(p => p.passou || p.severidade === 'avisa'),
    avisos: provas.filter(p => !p.passou && p.severidade === 'avisa').length,
  };
}

function imprimirVeredito(v) {
  console.log('\nO INSTRUMENTO CONTRA SI MESMO');
  for (const p of v.provas) {
    console.log(`  ${p.passou ? 'ok   ' : 'FALHA'}  ${p.prova}: ${p.medido}`);
  }
  console.log(v.aprovado
    ? '\n  As provas passaram. Os numeros acima valem.'
    : '\n  ALGUMA PROVA FALHOU. Os numeros acima NAO valem: conserte o medidor antes de ler o medido.');
  console.log('\n  RESSALVAS DESTA MEDIDA:');
  console.log('  - Tudo em 127.0.0.1. A latencia de rede so existe nos perfis que a emulam,');
  console.log('    e os numeros do perfil ebnet sao CHUTE declarado, nao medida de campo.');
  console.log('  - Gravar a tela custa codificacao JPEG na mesma thread que se mede. As');
  console.log('    colunas de travada saem um pouco piores do que sem gravacao.');
  console.log('  - O salto de foto e pelo link, e nao pelo clique na seta: mede a troca de');
  console.log('    foto, e nao o apanhador de clique.');
  if (args.externo === 'local') {
    console.log('  - O recurso externo (mapa de fundo, glifo) foi SUBSTITUIDO por um local. O');
    console.log('    custo real do mapa de fundo nao esta nestes numeros. Use --externo passa');
    console.log('    numa maquina com internet para inclui-lo.');
  }
}
