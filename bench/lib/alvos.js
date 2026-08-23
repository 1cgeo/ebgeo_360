/**
 * @module bench/lib/alvos
 * @description Os alvos da medida, declarados em UM lugar so, e o conjunto de
 * tiles que cada um pede.
 *
 * POR QUE NAO SORTEAR TILE DO BANCO. O visualizador 360 nao pede tile aleatorio.
 * Ele escolhe UM nivel pela largura da tela e pede a vizinhanca do que a camera
 * enxerga, do centro para a borda. Uma carga de chaves sorteadas mede o pior
 * caso do cache de pagina do SQLite, e nao o caso real: ela subestima o servico
 * e leva a otimizar o que nao doi. As duas formas estao aqui, e as bancadas
 * rodam as duas: `frustum` e o padrao realista, `sorteio` e o piso.
 *
 * A GEOMETRIA NAO SE CALCULA AQUI. Ela sai de pyramid-math.js, o mesmo modulo do
 * gerador, da rota e do cliente. O conjunto de tiles visiveis ja nasceu escrito
 * duas vezes uma vez, e as duas copias divergiram 2,2x: o numero que decidia o
 * piloto saia do benchmark, e quem roda em producao e o cliente. Instrumento de
 * comparacao errado nao mede coisa nenhuma.
 *
 * OS CINCO ALVOS SAO FIXOS de proposito. Duas execucoes da bancada tem de pedir
 * os MESMOS tiles na MESMA ordem, senao a comparacao entre configuracoes mede o
 * sorteio da camera.
 */

import { statSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import config from '../../src/config.js';
import { tilesDbFilenameFor } from '../../src/db/tiles-queries.js';
import {
  escadaGravada,
  larguraNecessaria,
  escolherNivel,
  tilesVisiveis,
} from '../../public/calibration/js/pyramid-math.js';

/**
 * Margem de tiles que o cliente pede de verdade.
 *
 * O valor e o `MARGEM_TILES` de public/calibration/js/tile-loader.js. Medir com
 * margem 0 mediria uma rajada que a producao nunca faz: sem folga a emenda abre
 * buraco ao arrastar, e por isso o cliente sempre paga a vizinhanca.
 * @constant {number}
 */
export const MARGEM_CLIENTE = 1;

/**
 * Tiles em voo que o cliente dispara de verdade.
 *
 * O valor e o `MAX_PARALELO` de tile-loader.js. Ele existe medido: atras do
 * nginx com HTTP/2, 24 objetos de 11 a 21 KB em paralelo chegam em 43 ms, e com
 * 12 em voo a mesma rajada vira duas ondas. Medir a rota com outra concorrencia
 * responde uma pergunta que ninguem fez.
 * @constant {number}
 */
export const PARALELO_CLIENTE = 24;

/**
 * Projeto padrao da bancada.
 *
 * `faxinal` porque o banco de tiles dele passa de 1,4 GB, e e o unico maior que
 * o `mmap_size` de 256 MB do servico. Num arquivo que cabe inteiro no cache de
 * pagina a pergunta sobre mmap nao existe: as variantes empatam por construcao,
 * e foi exatamente o que a primeira rodada desta bancada mediu num banco de
 * 20,9 MiB.
 * @constant {string}
 */
export const PROJETO_PADRAO = 'faxinal';

/**
 * Tiles que o visualizador REAL pede no nivel alvo, ao abrir a 1904x985.
 *
 * O NUMERO E MEDIDO, e nao calculado, e a diferenca e o ponto. `tilesVisiveis`
 * preve 48 para a janela de 1904x985 e 60 para o canvas de 1888x890 que sobra
 * dela. O visualizador pediu 54, contados um a um pelo Network do CDP.
 *
 * Nenhuma das duas contas acerta, porque o carregador desconta o que ja
 * desenhou e a camera nao abre em lat 0 exata. Entao a bancada mede 54, o
 * numero da producao, e imprime a previsao ao lado. Medir 48 ou 60 mediria o
 * instrumento, e nao o servico.
 * @constant {number}
 */
export const RAJADA_REFERENCIA = 54;

/**
 * @typedef {object} Alvo
 * @property {string} nome    - Rotulo curto, usado na tabela e na captura
 * @property {number} largura - Largura do canvas em pixels de dispositivo
 * @property {number} altura  - Altura do canvas em pixels de dispositivo
 * @property {number} fov     - Campo vertical em graus
 * @property {number} lon     - Longitude da camera, 0 a 360
 * @property {number} lat     - Latitude da camera, -90 a 90
 */

/**
 * Os cinco alvos da bancada.
 *
 * O PRIMEIRO E A REFERENCIA, e os outros existem para cerca-lo. `visualizador`
 * traz o CANVAS de 1888x890, e nao a janela de 1904x985: o painel de calibracao
 * e a borda comem a diferenca, e quem escolhe o nivel da piramide e o canvas.
 * Rotular a linha com o tamanho da janela ja fez a bancada prometer 48 tiles
 * onde a producao pede 54.
 *
 * `notebook` e `celular` descem o nivel, `zenite` puxa a camera para onde um
 * grau de longitude encurta com o cosseno, e `zoom` estreita a fov. Os quatro
 * mudam o TAMANHO da rajada sem mudar uma linha de codigo, que e o unico jeito
 * de saber se o custo medido acompanha o numero de tiles ou o numero de fotos.
 * @constant {Alvo[]}
 */
export const ALVOS = [
  { nome: 'visualizador', largura: 1888, altura: 890, fov: 75, lon: 0, lat: 0 },
  { nome: 'notebook', largura: 1350, altura: 673, fov: 75, lon: 0, lat: 0 },
  { nome: 'zenite', largura: 1888, altura: 890, fov: 75, lon: 90, lat: 60 },
  { nome: 'celular', largura: 412, altura: 915, fov: 75, lon: 180, lat: 0 },
  { nome: 'zoom', largura: 1888, altura: 890, fov: 30, lon: 270, lat: -20 },
];

/**
 * O caminho do banco de piramide de um projeto.
 *
 * A raiz sai da chave STREETVIEW_DATA_DIR, pelo src/config.js, e nao de um
 * caminho escrito aqui: a bancada tem de medir o MESMO acervo que o servico
 * serve, e um segundo lugar para configurar a raiz seria um segundo jeito de
 * apontar para o dado errado.
 *
 * @param {string} projeto - Slug do projeto
 * @returns {string} Caminho absoluto do {slug}_tiles.db
 */
export function caminhoDosTiles(projeto) {
  return join(config.projectsDbDir, tilesDbFilenameFor(`${projeto}.db`));
}

/**
 * As piramides gravadas de um projeto, lidas do arquivo.
 *
 * POR QUE A BANCADA DE HTTP TAMBEM LE O BANCO. O servico nao tem rota que liste
 * as fotos de um projeto, entao descobrir o alvo so pela porta HTTP exigiria
 * inventar uma, ou seja mexer em codigo de producao para poder medi-lo. Ler a
 * linha de tile_pyramids e a fonte, e nao o eco: e dela que sai o `total_bytes`
 * que a URL do tile leva como token de geracao.
 *
 * @param {string} projeto - Slug do projeto
 * @returns {Array<object>} Linhas de tile_pyramids, ordenadas por photo_id
 */
export function piramidesDoProjeto(projeto) {
  const caminho = caminhoDosTiles(projeto);
  if (!statSync(caminho, { throwIfNoEntry: false })) return [];
  const db = new Database(caminho, { readonly: true });
  try {
    return db.prepare(`
      SELECT photo_id, tile_size, max_level, width, height,
             quality, tile_count, total_bytes, razao
      FROM tile_pyramids ORDER BY photo_id
    `).all();
  } catch {
    // Arquivo presente mas sem as tabelas: geracao interrompida.
    return [];
  } finally {
    db.close();
  }
}

/**
 * Acha um alvo pelo nome, ou estoura com a lista do que existe.
 * @param {string} nome - Nome declarado em ALVOS
 * @returns {Alvo} O alvo pedido
 */
export function alvoPorNome(nome) {
  const a = ALVOS.find(x => x.nome === nome);
  if (!a) throw new Error(`alvo "${nome}" nao existe. Ha: ${ALVOS.map(x => x.nome).join(', ')}`);
  return a;
}

/**
 * @typedef {object} Frustum
 * @property {number} nivel       - Nivel escolhido pela largura da tela
 * @property {number} necessaria  - Largura de panoramica que a tela pede, em px
 * @property {Array}  escada      - A escada inteira, de escadaGravada
 * @property {object} grade       - O nivel escolhido, com cols e rows
 * @property {Array<{level:number,x:number,y:number}>} tiles - Do centro para a borda
 */

/**
 * O que UM alvo pede de UMA piramide: o nivel e a lista de tiles.
 *
 * A ESCADA SAI DO `max_level` GRAVADO, e nao da regra de parada de hoje. Dado
 * gravado manda em descritor calculado: recalcular pela regra corrente ja
 * reinterpretou 98.854 fotos e o cliente pedia nivel que nao existia.
 *
 * @param {object} piramide - Linha de tile_pyramids
 * @param {Alvo} alvo - Um dos ALVOS
 * @param {number} [margem] - Tiles extras de cada lado
 * @returns {Frustum}
 */
export function frustum(piramide, alvo, margem = MARGEM_CLIENTE) {
  const escada = escadaGravada(
    piramide.width, piramide.height, piramide.tile_size, piramide.razao, piramide.max_level,
  );
  const necessaria = larguraNecessaria(alvo.largura, alvo.altura, alvo.fov);
  const nivel = escolherNivel(escada, necessaria);
  const grade = escada[nivel];
  const camera = {
    lon: alvo.lon, lat: alvo.lat, fov: alvo.fov, largura: alvo.largura, altura: alvo.altura,
  };
  const tiles = tilesVisiveis(grade, piramide.tile_size, camera, margem)
    .map(t => ({ level: nivel, x: t.x, y: t.y }));
  return { nivel, necessaria, escada, grade, tiles };
}

/**
 * A rajada que a bancada mede: os N primeiros tiles do frustum.
 *
 * OS PRIMEIROS, e nao um recorte qualquer. `tilesVisiveis` devolve a lista
 * ordenada do centro da tela para a borda, que e a ordem em que o carregador os
 * pede. Cortar no fim tira a margem, exatamente o que o cliente larga quando
 * desiste, entao os N primeiros sao o subconjunto mais proximo do que ele
 * realmente segura.
 *
 * Quando o frustum previsto tem MENOS que N tiles, a lista volta inteira. Nao
 * se inventa tile para bater um numero: a linha impressa mostra os dois.
 *
 * @param {object} piramide - Linha de tile_pyramids
 * @param {Alvo} alvo - Um dos ALVOS
 * @param {number} [n] - Tamanho da rajada medida
 * @param {number} [margem] - Tiles extras de cada lado
 * @returns {{nivel:number, previsto:number, tiles:Array}} A rajada
 */
export function rajada(piramide, alvo, n = RAJADA_REFERENCIA, margem = MARGEM_CLIENTE) {
  const f = frustum(piramide, alvo, margem);
  return {
    nivel: f.nivel,
    previsto: f.tiles.length,
    tiles: f.tiles.slice(0, Math.min(n, f.tiles.length)),
  };
}

/**
 * O giro de 180 graus, em passos: os frustuns que a camera atravessa.
 *
 * Existe porque "bytes por giro" nao e o frustum vezes um fator. Passos vizinhos
 * compartilham coluna, e so a UNIAO diz quantos tiles distintos o giro pede. A
 * bancada de cliente mede o giro de verdade; esta funcao da o numero previsto,
 * para a medida ter contra o que ser conferida.
 *
 * @param {object} piramide - Linha de tile_pyramids
 * @param {Alvo} alvo - Ponto de partida do giro
 * @param {number} [passos] - Quantas paradas no arco de 180 graus
 * @returns {{nivel:number, passos:number, unicos:Array<{level:number,x:number,y:number}>}}
 */
export function giro(piramide, alvo, passos = 12) {
  const vistos = new Map();
  let nivel = 0;
  for (let i = 0; i < passos; i++) {
    const lon = (alvo.lon + (180 * i) / (passos - 1 || 1)) % 360;
    const f = frustum(piramide, { ...alvo, lon });
    nivel = f.nivel;
    for (const t of f.tiles) vistos.set(`${t.level}/${t.x}/${t.y}`, t);
  }
  return { nivel, passos, unicos: Array.from(vistos.values()) };
}

/**
 * Embaralha a lista de forma determinista, para a carga de pior caso.
 *
 * Semente fixa de proposito, pelo mesmo motivo dos alvos fixos: duas execucoes
 * tem de pedir os MESMOS tiles na MESMA ordem.
 *
 * @param {Array} lista - Qualquer lista
 * @param {number} [semente] - Semente do gerador linear
 * @returns {Array} Copia embaralhada
 */
export function sorteio(lista, semente = 12345) {
  const copia = [...lista];
  let s = semente;
  const proximo = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  for (let i = copia.length - 1; i > 0; i--) {
    const j = Math.floor(proximo() * (i + 1));
    [copia[i], copia[j]] = [copia[j], copia[i]];
  }
  return copia;
}

/**
 * Amostra determinista COM reposicao, para encher uma rodada longa.
 *
 * Serve a bancada de banco, onde o numero de leituras da rodada (milhares) e
 * maior que o numero de tiles do frustum (dezenas). Todas as configuracoes leem
 * exatamente a mesma sequencia.
 *
 * @param {Array} lista - Populacao
 * @param {number} k - Quantos itens sortear
 * @param {number} [semente] - Semente do gerador linear
 * @returns {Array} Lista de k itens
 */
export function amostra(lista, k, semente = 987) {
  const saida = [];
  let s = semente;
  for (let i = 0; i < k; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    saida.push(lista[s % lista.length]);
  }
  return saida;
}

/**
 * Repete a lista ate atingir `total` itens, preservando a ordem.
 * @param {Array} lista - Lista a repetir
 * @param {number} total - Tamanho desejado
 * @returns {Array} Lista com `total` itens
 */
export function repete(lista, total) {
  if (!lista.length) return [];
  const saida = [];
  while (saida.length < total) {
    saida.push(...lista.slice(0, Math.min(lista.length, total - saida.length)));
  }
  return saida;
}

/**
 * Monta a URL de um tile, com o token de geracao.
 *
 * O `?v=<total_bytes>` NAO e enfeite: o tile sai com `immutable` de um ano, e
 * sem o token o navegador da bancada serviria da memoria dele o tile de uma
 * rodada anterior. A rota ignora o parametro de proposito; quem o consome e o
 * cache.
 *
 * @param {string} base - Ex.: 'http://127.0.0.1:8081'
 * @param {string} uuid - UUID da foto
 * @param {{level:number,x:number,y:number}} t - Coordenada do tile
 * @param {number} token - `tile_pyramids.total_bytes`
 * @returns {{caminho:string}} Alvo no formato que carga.js consome
 */
export function urlDoTile(base, uuid, t, token) {
  return {
    caminho: `${base}/api/v1/photos/${uuid}/tiles/${t.level}/${t.x}/${t.y}.webp?v=${token}`,
  };
}

/**
 * A URL do descritor da piramide.
 * @param {string} base - Raiz do servico
 * @param {string} uuid - UUID da foto
 * @returns {{caminho:string}} Alvo no formato que carga.js consome
 */
export function urlDoDescritor(base, uuid) {
  return { caminho: `${base}/api/v1/photos/${uuid}/tiles.json` };
}
