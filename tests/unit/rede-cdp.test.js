/**
 * @module tests/unit/rede-cdp.test
 * @description Testa a classificacao de URL do gravador de rede.
 *
 * POR QUE ISTO MERECE TESTE. E o unico lugar do medidor onde um erro nao vira
 * excecao: uma expressao regular que deixa de casar transforma tile em "outro",
 * e a coluna de tiles cai para ZERO. Zero e um numero plausivel, e ja enganou
 * uma medida inteira nesta obra: o filtro pedia URL terminada em `.webp` e o
 * token de geracao (`?v=123`) fazia toda URL terminar em digito. O log mostrou
 * "zero preview, zero full" e parecia aprovacao; mostrava tambem zero tile, e
 * era cegueira do instrumento.
 *
 * Cada caso abaixo e uma URL REAL, copiada do que o navegador pediu.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classificar } from '../../scripts/lib/rede-cdp.js';

const ORIGEM = 'http://127.0.0.1:8199';
const UUID = '00374597-0d4c-4a2d-9bf2-639af7f6c47c';

describe('classificar', () => {
  it('reconhece o tile e extrai o nivel', () => {
    const r = classificar(`${ORIGEM}/ebgeo_360/photos/${UUID}/tiles/6/12/3.webp`, ORIGEM);
    assert.equal(r.classe, 'tile');
    assert.equal(r.nivel, 6);
    assert.equal(r.uuid, UUID);
  });

  it('reconhece o tile MESMO com o token de geracao na URL', () => {
    // O `?v=` e o que a rota publica no template do descritor. Foi exatamente
    // ele que quebrou o filtro anterior.
    const r = classificar(`${ORIGEM}/ebgeo_360/photos/${UUID}/tiles/4/0/0.webp?v=123456`, ORIGEM);
    assert.equal(r.classe, 'tile');
    assert.equal(r.nivel, 4);
  });

  it('separa o descritor do tile', () => {
    const r = classificar(`${ORIGEM}/ebgeo_360/photos/${UUID}/tiles.json`, ORIGEM);
    assert.equal(r.classe, 'descritor');
    assert.equal(r.uuid, UUID);
  });

  it('nao confunde o metadado da foto com o descritor', () => {
    const r = classificar(`${ORIGEM}/ebgeo_360/photos/${UUID}`, ORIGEM);
    assert.equal(r.classe, 'foto-meta');
  });

  it('mantem classe propria para a imagem inteira, que foi aposentada', () => {
    // Ela nao deve mais aparecer. A classe sobrevive JUSTAMENTE para que, se
    // aparecer, o numero grite em vez de se diluir em "outro".
    const r = classificar(`${ORIGEM}/ebgeo_360/photos/${UUID}/image?quality=full`, ORIGEM);
    assert.equal(r.classe, 'imagem-cheia');
  });

  it('reconhece o tile vetorial do mapa', () => {
    assert.equal(classificar(`${ORIGEM}/ebgeo_360/tiles/fotos/14/8191/8192`, ORIGEM).classe, 'tile-vetorial');
  });

  it('reconhece planta baixa e tracado', () => {
    assert.equal(classificar(`${ORIGEM}/ebgeo_360/projects/museu_cms/floors`, ORIGEM).classe, 'planta');
    assert.equal(classificar(`${ORIGEM}/ebgeo_360/tracks?bbox=1,2,3,4`, ORIGEM).classe, 'tracado');
  });

  it('separa o pacote da aplicacao do recurso estatico', () => {
    assert.equal(classificar(`${ORIGEM}/assets/main-B5qOdab2.js`, ORIGEM).classe, 'aplicacao');
    assert.equal(classificar(`${ORIGEM}/assets/main-BdQp3LVU.css`, ORIGEM).classe, 'aplicacao');
    assert.equal(classificar(`${ORIGEM}/images/logo_ebgeo.webp`, ORIGEM).classe, 'recurso');
  });

  it('marca como externo o que nao sai da propria origem', () => {
    assert.equal(classificar('https://a.tile.openstreetmap.org/14/8192/8191.png', ORIGEM).classe, 'externo');
    assert.equal(classificar('https://demotiles.maplibre.org/font/Open%20Sans/0-255.pbf', ORIGEM).classe, 'externo');
  });

  it('nao chama de externo um recurso da propria origem que parece tile de mapa', () => {
    const r = classificar(`${ORIGEM}/street_view/point.png`, ORIGEM);
    assert.equal(r.classe, 'recurso');
  });

  it('devolve nivel nulo para tudo que nao e tile', () => {
    for (const url of [
      `${ORIGEM}/ebgeo_360/photos/${UUID}/tiles.json`,
      `${ORIGEM}/assets/main.js`,
      'https://a.tile.openstreetmap.org/14/8192/8191.png',
    ]) {
      assert.equal(classificar(url, ORIGEM).nivel, null, url);
    }
  });
});
