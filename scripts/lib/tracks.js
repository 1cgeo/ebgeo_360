/**
 * @module scripts/lib/tracks
 * @description O tracado da captura como GUARDA das conexoes espaciais.
 *
 * A Fase 5 do `migrate.js` liga foto a foto por PROXIMIDADE, e proximidade nao
 * sabe onde ha parede. Num quartel duas fotos a 40 m podem estar em ruas
 * paralelas separadas por um pavilhao: a linha reta entre elas atravessa o
 * predio, e o visualizador ganha um marcador que manda o operador andar para
 * dentro da alvenaria.
 *
 * O `fotos_linha.geojson` da entrega sabe por onde se andou. Este modulo o usa
 * para reprovar a conexao cujo caminho SAI do tracado.
 *
 * A REGUA NAO E O AFASTAMENTO BRUTO, e por medida. As fotos do lote de Cascavel
 * ficam sobre a linha (p99 de 0,0 m), porque o tracado nasce dos proprios
 * pontos. Entao um afastamento absoluto mede a foto, e nao o caminho. O que
 * decide e o EXCESSO: quanto a corda A-B se afasta do tracado ALEM do que os
 * proprios extremos ja estao afastados.
 *
 * O limite de 3 m saiu de medida nos cinco projetos de Cascavel, e nao de
 * arbitrio. O grafo ENTREGUE (1.768 conexoes que o levantamento desenhou, e que
 * sao a verdade de campo do que e conexao legitima) tem excesso 0,0 m no p99 e
 * 1,6 m no maximo. Os candidatos que so a proximidade cria tem excesso mediano
 * de 2,7 a 6,4 m e cauda ate 31,6 m. Com 3 m preservam-se 100% das conexoes
 * entregues nos cinco projetos, e cortam-se de 47,2% a 68,6% dos candidatos.
 *
 * O cruzamento legitimo sobrevive de proposito: onde duas faixas se cruzam, a
 * corda entre as duas fotos corre POR CIMA do tracado, e o excesso fica em zero.
 * Filtrar por "mesma faixa" mataria esse caso, e por isso nao e o criterio.
 */

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DEG_TO_RAD = Math.PI / 180;
const M_POR_GRAU_LAT = 111320;

/** Passo de amostragem da corda, em metros. */
const PASSO_AMOSTRA = 2;
/** Lado da celula do indice, em metros. */
const CELULA = 60;

/**
 * Distancia de um ponto a um segmento, no plano local.
 * @returns {number} metros
 */
function distanciaPontoSegmento(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const comprimento = vx * vx + vy * vy;
  let t = comprimento > 0 ? ((px - ax) * vx + (py - ay) * vy) / comprimento : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}

/**
 * O tracado de um levantamento, indexado para consulta por ponto.
 *
 * Usa projecao plana local em torno da latitude media dos vertices. Um projeto
 * cobre poucos quilometros, entao o erro da aproximacao fica muito abaixo do
 * limite que se vai comparar.
 */
export class Tracado {
  /**
   * @param {Array<Object>} features - feicoes GeoJSON LineString/MultiLineString
   */
  constructor(features) {
    const linhas = [];
    for (const f of features) {
      if (!f || !f.geometry) continue;
      const { type, coordinates } = f.geometry;
      if (type === 'LineString') linhas.push(coordinates);
      else if (type === 'MultiLineString') linhas.push(...coordinates);
    }

    let somaLat = 0;
    let nVertices = 0;
    for (const linha of linhas) {
      for (const c of linha) { somaLat += c[1]; nVertices++; }
    }
    this.vazio = nVertices === 0;
    this.latRef = this.vazio ? 0 : somaLat / nVertices;
    this.kx = M_POR_GRAU_LAT * Math.cos(this.latRef * DEG_TO_RAD);
    this.ky = M_POR_GRAU_LAT;

    this.segmentos = [];
    for (const linha of linhas) {
      for (let i = 1; i < linha.length; i++) {
        const a = this.plano(linha[i - 1][1], linha[i - 1][0]);
        const b = this.plano(linha[i][1], linha[i][0]);
        if (a[0] === b[0] && a[1] === b[1]) continue;
        this.segmentos.push([a[0], a[1], b[0], b[1]]);
      }
    }

    // Indice de grade: cada segmento entra em todas as celulas da sua caixa.
    // Sobra celula que o segmento nao cruza, o que so custa candidato a mais.
    this.grade = new Map();
    this.segmentos.forEach((s, i) => {
      const x0 = Math.floor(Math.min(s[0], s[2]) / CELULA);
      const x1 = Math.floor(Math.max(s[0], s[2]) / CELULA);
      const y0 = Math.floor(Math.min(s[1], s[3]) / CELULA);
      const y1 = Math.floor(Math.max(s[1], s[3]) / CELULA);
      for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) {
          const chave = `${x},${y}`;
          if (!this.grade.has(chave)) this.grade.set(chave, []);
          this.grade.get(chave).push(i);
        }
      }
    });
  }

  /** Converte lat/lon em coordenada plana local, em metros. */
  plano(lat, lon) {
    return [lon * this.kx, lat * this.ky];
  }

  /**
   * Distancia de um ponto plano ao tracado.
   *
   * Cresce o anel de celulas ate que o melhor achado seja menor que o raio ja
   * varrido. Sem essa condicao a busca pararia no primeiro anel com algum
   * segmento, que pode nao conter o mais proximo.
   * @returns {number} metros, ou Infinity se o tracado estiver vazio
   */
  distanciaPlano(x, y) {
    if (this.vazio) return Infinity;
    const cx = Math.floor(x / CELULA);
    const cy = Math.floor(y / CELULA);
    let melhor = Infinity;
    for (let r = 1; r <= 8; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dy = -r; dy <= r; dy++) {
          const celula = this.grade.get(`${cx + dx},${cy + dy}`);
          if (!celula) continue;
          for (const i of celula) {
            const s = this.segmentos[i];
            const d = distanciaPontoSegmento(x, y, s[0], s[1], s[2], s[3]);
            if (d < melhor) melhor = d;
          }
        }
      }
      if (melhor < r * CELULA) return melhor;
    }
    return melhor;
  }

  /** Distancia de um ponto geografico ao tracado, em metros. */
  distancia(lat, lon) {
    const [x, y] = this.plano(lat, lon);
    return this.distanciaPlano(x, y);
  }

  /**
   * Excesso da corda A-B: o maior afastamento do tracado ao longo dela, menos o
   * afastamento que os proprios extremos ja tem.
   *
   * Zero significa que se anda de A ate B sem sair do tracado.
   * @returns {number} metros
   */
  excesso(latA, lonA, latB, lonB) {
    if (this.vazio) return Infinity;
    const a = this.plano(latA, lonA);
    const b = this.plano(latB, lonB);
    const base = Math.max(this.distanciaPlano(a[0], a[1]), this.distanciaPlano(b[0], b[1]));
    const comprimento = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(4, Math.ceil(comprimento / PASSO_AMOSTRA));
    let pior = 0;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const d = this.distanciaPlano(a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]));
      if (d > pior) pior = d;
      // Ja estourou o que qualquer limite util aceitaria: para de amostrar.
      if (pior - base > 1000) break;
    }
    return Math.max(0, pior - base);
  }

  /**
   * O tracado cobre esta nuvem de fotos?
   *
   * Serve para NAO aplicar a guarda a um projeto cujo tracado nao veio. Sem
   * isso o filtro reprovaria todas as conexoes daquele projeto, em silencio.
   * @param {Array<{lat: number, lon: number}>} fotos
   * @param {number} limite - metros
   */
  cobre(fotos, limite = 50) {
    if (this.vazio || fotos.length === 0) return false;
    const d = fotos.map(p => this.distancia(p.lat, p.lon)).sort((x, y) => x - y);
    return d[Math.floor(d.length / 2)] <= limite;
  }
}

/**
 * Le um ou mais `fotos_linha.geojson`. Aceita arquivo, pasta (onde procura o
 * nome padrao) ou lista separada por virgula.
 * @param {string} caminhos
 * @returns {{tracado: Tracado, arquivos: string[]}}
 */
export function carregarTracado(caminhos) {
  const arquivos = [];
  for (const bruto of String(caminhos).split(',').map(s => s.trim()).filter(Boolean)) {
    if (!existsSync(bruto)) throw new Error(`tracado nao encontrado: ${bruto}`);
    if (statSync(bruto).isDirectory()) {
      const achados = readdirSync(bruto).filter(f => f.endsWith('fotos_linha.geojson'));
      if (achados.length === 0) throw new Error(`nenhum fotos_linha.geojson em ${bruto}`);
      for (const f of achados) arquivos.push(join(bruto, f));
    } else {
      arquivos.push(bruto);
    }
  }
  const features = [];
  for (const a of arquivos) {
    const g = JSON.parse(readFileSync(a, 'utf8'));
    if (Array.isArray(g.features)) features.push(...g.features);
    else if (g.type === 'Feature') features.push(g);
  }
  return { tracado: new Tracado(features), arquivos };
}
