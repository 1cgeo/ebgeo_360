/**
 * @module tests/unit/etag-validador
 * @description O que `If-None-Match` aceita, e por que aceitar menos custa bytes.
 *
 * POR QUE ESTE ARQUIVO EXISTE. A comparacao era
 * `ifNoneMatch.replace(/"/g, '') === etag`, e ela so acertava a forma mais
 * simples. Tres formas legitimas caiam fora, em SILENCIO: a rota tomava vaga no
 * semaforo, lia o BLOB e mandava bytes que o cliente ja tinha. Medido na
 * bancada, com 4.000 requisicoes: `W/"<etag>"` devolveu 200 em 4.000 de 4.000 e
 * transferiu 101,4 MiB, onde o validador forte transfere zero.
 *
 * O caso do `W/` nao e hipotetico. Qualquer proxy que transforma a resposta
 * enfraquece o validador, e o navegador devolve exatamente o que recebeu.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { etagCasa, computeImageETag } from '../../src/middleware/cache.js';

describe('etagCasa', () => {
  const etag = computeImageETag('001fc5fc-b154-4dcd-ad29-7c365cc5d77c', 't6-7-4', 2941190);

  it('casa a forma forte, que e a que o servidor emite', () => {
    assert.equal(etagCasa(`"${etag}"`, etag), true);
  });

  it('casa a forma FRACA, que e a que um proxy devolve', () => {
    // O defeito de origem: o `replace` das aspas deixava o `W/` grudado.
    assert.equal(etagCasa(`W/"${etag}"`, etag), true);
  });

  it('casa dentro de uma LISTA, em qualquer posicao', () => {
    assert.equal(etagCasa(`"outro", "${etag}"`, etag), true);
    assert.equal(etagCasa(`"${etag}", "outro"`, etag), true);
    assert.equal(etagCasa(`W/"outro", W/"${etag}"`, etag), true);
  });

  it('casa o coringa, que por definicao vale para qualquer representacao', () => {
    assert.equal(etagCasa('*', etag), true);
  });

  it('NAO casa validador de outro conteudo', () => {
    assert.equal(etagCasa('"nao-e-esse"', etag), false);
    assert.equal(etagCasa(`"${etag}x"`, etag), false);
    assert.equal(etagCasa('"outro", "mais-outro"', etag), false);
  });

  it('NAO casa quando o cabecalho nao veio', () => {
    // Sem cabecalho a resposta e 200 com corpo, e nao um 304 vazio: o cliente
    // que nao tem nada guardado precisa dos bytes.
    assert.equal(etagCasa(undefined, etag), false);
    assert.equal(etagCasa('', etag), false);
  });

  it('tolera espaco em volta, que a RFC permite na lista', () => {
    assert.equal(etagCasa(`  "${etag}"  `, etag), true);
    assert.equal(etagCasa(`"outro" ,  W/"${etag}"`, etag), true);
  });

  it('o token de geracao separa uma piramide regerada da anterior', () => {
    // `total_bytes` muda quando os bytes mudam, e e ele que vai no ETag. Sem
    // isso o `immutable` de um ano misturaria tile velho e novo na mesma parede.
    const antes = computeImageETag('foto', 't6-7-4', 2941190);
    const depois = computeImageETag('foto', 't6-7-4', 2941191);
    assert.equal(etagCasa(`"${antes}"`, depois), false);
  });
});
