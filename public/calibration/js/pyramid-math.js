/**
 * @module pyramid-math
 * @description A UNICA verdade sobre a piramide de tiles 360.
 *
 * POR QUE ESTE ARQUIVO EXISTE. A escada de niveis nasceu escrita tres vezes
 * (gerador, rota e benchmark) com regras de arredondamento diferentes, e o
 * conjunto de tiles visiveis nasceu escrito duas vezes (cliente e benchmark),
 * divergindo 2,2x. A segunda divergencia e a pior: o numero que decide o piloto
 * saia do benchmark, e quem roda em producao e o cliente. Instrumento de
 * comparacao errado nao mede coisa nenhuma.
 *
 * O arquivo vive em public/ e nao em src/ porque o NAVEGADOR precisa dele. E
 * ESM puro, sem dependencia e sem API de Node, entao os scripts de src/ e de
 * scripts/ o importam por caminho relativo, e o cliente o importa como modulo.
 *
 * Regra de manutencao: quem mudar a escada ou o frustum muda AQUI. Se um
 * consumidor precisar de outra conta, ele esta errado ou a conta e outra.
 */

/**
 * Largura abaixo da qual a escada para de descer.
 *
 * Um nivel mais grosso que isso nao economiza nada util: em 1920 de largura a
 * panoramica inteira ja cabe em 8 tiles, e o preview de 512x256 cobre o caso
 * do primeiro quadro.
 * @constant {number}
 */
export const LARGURA_MINIMA_NIVEL = 2048;

/**
 * Razao padrao entre um nivel e o seguinte.
 *
 * 2 e a escada classica, e foi a do primeiro piloto. Ela tem um defeito MEDIDO:
 * em 7680 nativo ela da 1920, 3840 e 7680, e a largura que as telas realmente
 * usam cai entre 4264 (notebook 1350x673) e 6119 (monitor 1904x985), ou seja
 * dentro do vao entre 3840 e 7680. Resultado: todo viewport satura no nativo, e
 * a escada nao economiza nada. Razao menor fecha o vao e custa armazenamento.
 * @constant {number}
 */
export const RAZAO_PADRAO = 2;

/**
 * A politica de razao POR FORMATO, medida e nao arbitrada.
 *
 * A largura que as telas realmente usam fica entre 4264 px (notebook 1350x673) e
 * 6119 px (monitor 1904x985). Disso saem os dois casos do acervo:
 *
 * - Em 5760 o nativo ja cai dentro dessa faixa, entao razao 2 basta e uma escada
 *   fina la so custaria armazenamento.
 * - Em 7680 a razao 2 da 1920/3840/7680, e a faixa util cai no vao entre 3840 e
 *   7680. Todo viewport satura no nativo e paga ate 80% de largura a toa. Com
 *   razao 1,6 entra o nivel de 4800, e o notebook desce para ele.
 *
 * Medido no museu_cms: razao 2 custa 1,429x o full_webp, razao 1,6 custa 1,813x.
 * Aplicar 1,6 so nos 7680 projeta 98,6 GB no acervo, contra 113,4 GB em tudo.
 *
 * A politica mora AQUI, e nao no gerador, porque quatro modulos dependem dela e
 * a escada ja teve duas copias uma vez: o sintoma foi tile faltando, nunca erro.
 * @constant {Array<{larguraMinima:number, razao:number}>}
 */
export const RAZAO_POR_LARGURA = [
  { larguraMinima: 7680, razao: 1.6 },
  { larguraMinima: 0, razao: RAZAO_PADRAO },
];

/**
 * A razao que uma foto daquela largura leva, com a precedencia do pedido.
 *
 * A EXPLICITA VENCE, e nao em silencio: quem passa `--razao 1.4` esta orcando uma
 * escada, e o padrao por formato sobrescrever o pedido produziria um acervo com
 * outra grade, descoberto semanas depois. `null` e `undefined` sao os dois jeitos
 * de dizer que o operador nao pediu nada.
 *
 * @param {number} largura - Largura NATIVA da foto em pixels.
 * @param {number|null} [explicita] - A razao de `--razao`, quando houve.
 * @returns {number} A razao a usar nesta foto.
 */
export function razaoParaLargura(largura, explicita) {
  if (explicita !== null && explicita !== undefined) return explicita;
  for (const faixa of RAZAO_POR_LARGURA) {
    if (largura >= faixa.larguraMinima) return faixa.razao;
  }
  return RAZAO_PADRAO;
}

/**
 * Monta a escada de niveis, do mais grosso (level 0) ao nativo.
 *
 * A REGRA E A DO GERADOR, e nao a da rota. O gerador e quem escreve o dado, e
 * dado gravado manda em descritor calculado. A rota antiga dividia a largura
 * nativa por `2**(max_level-level)`, o que so coincide com metades sucessivas
 * quando nao ha arredondamento. Em 8194 de largura as duas discordavam, e o
 * descritor prometia uma grade que nao existia no banco: o cliente levava 400
 * pedindo um tile realmente gravado.
 *
 * A escada e determinada por (width, height, tileSize, razao). Por isso a razao
 * se GRAVA junto da piramide: quem reconstruir a escada com outra razao produz
 * outra grade, e o sintoma seria tile faltando, nunca erro.
 *
 * @param {number} width - Largura nativa em pixels.
 * @param {number} height - Altura nativa em pixels.
 * @param {number} tileSize - Lado do tile em pixels.
 * @param {number} [razao=2] - Fator entre um nivel e o proximo. Maior que 1.
 * @returns {Array<{level:number,width:number,height:number,cols:number,rows:number}>}
 */
export function montarEscada(width, height, tileSize, razao = RAZAO_PADRAO) {
  // Razao invalida cairia num laco infinito, ou numa escada de um nivel so sem
  // dizer por que. Melhor tratar como a escada classica.
  const r = Number.isFinite(razao) && razao > 1 ? razao : RAZAO_PADRAO;
  const escada = [{ width, height }];
  let w = width;
  let h = height;
  while (w > LARGURA_MINIMA_NIVEL) {
    const proximaW = Math.max(1, Math.round(w / r));
    const proximaH = Math.max(1, Math.round(h / r));
    // Guarda contra razao que arredonda para o mesmo numero e nao desce.
    if (proximaW >= w) break;
    w = proximaW;
    h = proximaH;
    escada.push({ width: w, height: h });
  }
  escada.reverse();
  return escada.map((nivel, level) => ({
    level,
    width: nivel.width,
    height: nivel.height,
    cols: Math.ceil(nivel.width / tileSize),
    rows: Math.ceil(nivel.height / tileSize),
  }));
}

/**
 * Custo relativo de uma escada, em area, contra servir so o nivel nativo.
 *
 * Serve para orcar a razao ANTES de gerar 100 GB. A soma e geometrica: com
 * razao 2 a piramide inteira custa 1,31 vez a area do nativo, e com razao 1,6
 * custa 1,60.
 *
 * ATENCAO AO DENOMINADOR, que ja confundiu leitor cuidadoso. Aqui o
 * denominador e o NIVEL NATIVO, e nao o `full_webp` de hoje. No museu_cms, com
 * razao 2: os tiles somam 113.326.996 B e o nivel nativo sozinho soma
 * 73.292.402 B, ou seja 1,55 medido contra 1,31 previsto por area (tile pequeno
 * comprime pior por pixel). Contra o `full_webp` de 79.280.578 B a razao e
 * 1,43, que e OUTRA medida, a de armazenamento, e e a que o bench-tiles.js
 * imprime. As duas estao certas e respondem perguntas diferentes.
 *
 * @param {Array<{width:number,height:number}>} escada - Saida de montarEscada.
 * @returns {number} Area total dividida pela area do nivel nativo.
 */
export function custoDaEscada(escada) {
  const nativo = escada[escada.length - 1];
  const areaNativa = nativo.width * nativo.height;
  const total = escada.reduce((soma, n) => soma + n.width * n.height, 0);
  return total / areaNativa;
}

/**
 * Converte a fov vertical da camera na horizontal, dada a proporcao da tela.
 * @param {number} fovVertical - Fov vertical em graus.
 * @param {number} aspecto - Largura dividida pela altura.
 * @returns {number} Fov horizontal em graus.
 */
export function fovHorizontal(fovVertical, aspecto) {
  const meia = Math.atan(Math.tan((fovVertical * Math.PI) / 360) * aspecto);
  return (meia * 360) / Math.PI;
}

/**
 * Largura de panoramica que a tela consegue mostrar a um pixel por pixel.
 *
 * A demanda sai da fov HORIZONTAL, e nao da vertical. Foi assim que os 6119 px
 * de um monitor 1904x985 foram medidos. Uma conta pela vertical dava 4728 px na
 * mesma tela, e escolheria um nivel abaixo do necessario.
 *
 * @param {number} larguraPx - Largura do canvas em pixels de dispositivo.
 * @param {number} alturaPx - Altura do canvas em pixels de dispositivo.
 * @param {number} fovVertical - Fov vertical em graus.
 * @returns {number} Largura necessaria, ou 0 quando a tela nao tem area.
 */
export function larguraNecessaria(larguraPx, alturaPx, fovVertical) {
  // Tela oculta ou container de largura zero davam NaN, e toda comparacao com
  // NaN e falsa: a escolha caia no nivel nativo, o mais caro, justamente para
  // quem nao esta vendo nada.
  if (!(larguraPx > 0) || !(alturaPx > 0) || !(fovVertical > 0)) return 0;
  const hfov = fovHorizontal(fovVertical, larguraPx / alturaPx);
  if (!(hfov > 0)) return 0;
  return (larguraPx * 360) / hfov;
}

/**
 * Escolhe o menor nivel que cobre a largura necessaria, saturando no nativo.
 * @param {Array<{level:number,width:number}>} escada - Saida de montarEscada.
 * @param {number} necessaria - Saida de larguraNecessaria.
 * @returns {number} O nivel escolhido.
 */
export function escolherNivel(escada, necessaria) {
  if (!Number.isFinite(necessaria) || necessaria <= 0) return 0;
  for (const nivel of escada) {
    if (nivel.width >= necessaria) return nivel.level;
  }
  return escada[escada.length - 1].level;
}

/**
 * Os tiles que a camera ve, em UM modelo so, do cliente e do benchmark.
 *
 * Tres cuidados que a versao ingenua errava:
 *
 * 1. A COLUNA SE CONTA EM PIXEL, nunca em indice de tile. `(lon/360)*cols` so
 *    vale quando `cols*tileSize == width`. Vale para 7680 (15 tiles cheios),
 *    nao vale para 5760 (12 colunas, a ultima com 128 px), que e metade do
 *    acervo. Em alegrete, lon 355, a conta por indice errava 0,7 tile.
 * 2. A FAIXA DE LONGITUDE CRESCE COM A LATITUDE. Um grau de longitude encurta
 *    com o cosseno, entao perto do zenite o mesmo campo cobre mais coluna.
 * 3. A MARGEM E PARAMETRO, e nao constante escondida. O cliente pede margem
 *    para nao abrir buraco na emenda ao arrastar; o benchmark precisa medir os
 *    dois conjuntos, o ideal e o que a produção realmente pede.
 *
 * @param {{level:number,width:number,height:number,cols:number,rows:number}} nivel
 * @param {number} tileSize - Lado do tile em pixels.
 * @param {{lon:number,lat:number,fov:number,largura:number,altura:number}} camera
 * @param {number} [margem=1] - Tiles extras de cada lado.
 * @returns {Array<{x:number,y:number,d:number}>} Tiles, do centro para a borda.
 */
export function tilesVisiveis(nivel, tileSize, camera, margem = 1) {
  const { width, height, cols, rows } = nivel;
  const aspecto = camera.largura / Math.max(camera.altura, 1);
  const hfov = fovHorizontal(camera.fov, aspecto);

  const latExtrema = Math.min(89, Math.abs(camera.lat) + camera.fov / 2);
  const cosLat = Math.max(Math.cos((latExtrema * Math.PI) / 180), 0.05);
  const meiaLon = Math.min(180, hfov / 2 / cosLat);

  // Colunas por caminhada em PIXEL, que e o que torna a ultima coluna parcial
  // correta. O passo anda de borda de tile em borda de tile e da a volta em
  // `width`, nunca em `cols * tileSize`.
  const colunas = new Set();
  const lonNorm = (((camera.lon % 360) + 360) % 360);
  const pxCentro = (lonNorm / 360) * width;
  if (meiaLon >= 180) {
    for (let c = 0; c < cols; c++) colunas.add(c);
  } else {
    const arco = (meiaLon * 2 / 360) * width;
    let px = ((pxCentro - arco / 2) % width + width) % width;
    let restante = arco;
    while (restante > 0) {
      const coluna = Math.min(Math.floor(px / tileSize), cols - 1);
      colunas.add(coluna);
      const fim = Math.min((coluna + 1) * tileSize, width);
      restante -= fim - px;
      px = fim >= width ? 0 : fim;
    }
  }

  // A margem entra em indice de coluna, com volta, porque e uma folga de
  // vizinhanca e nao um arco.
  if (margem > 0 && colunas.size < cols) {
    for (const c of Array.from(colunas)) {
      for (let m = 1; m <= margem; m++) {
        colunas.add(((c - m) % cols + cols) % cols);
        colunas.add((c + m) % cols);
      }
    }
  }

  // O topo da equirretangular e o zenite, entao a linha cresce para BAIXO.
  const pyCentro = ((90 - camera.lat) / 180) * height;
  const meiaAltura = (camera.fov / 2 / 180) * height;
  const linhaCentro = pyCentro / tileSize;
  const y0 = Math.max(0, Math.floor((pyCentro - meiaAltura) / tileSize) - margem);
  const y1 = Math.min(rows - 1, Math.floor((pyCentro + meiaAltura) / tileSize) + margem);

  const colCentro = pxCentro / tileSize;
  const lista = [];
  for (const x of colunas) {
    for (let y = y0; y <= y1; y++) {
      const bruto = Math.abs(x + 0.5 - colCentro);
      const dx = Math.min(bruto, cols - bruto);
      const dy = Math.abs(y + 0.5 - linhaCentro);
      lista.push({ x, y, d: dx * dx + dy * dy });
    }
  }
  // Do centro da tela para a borda: o que o olho esta olhando chega primeiro.
  lista.sort((a, b) => a.d - b.d);
  return lista;
}
