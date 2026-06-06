/**
 * @module tests/unit/cache.test
 * @description Unit tests for middleware/cache.js — pure functions, no DB needed.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeETag,
  computeImageETag,
  computeMetadataETag,
  setImageCacheHeaders,
  setMetadataCacheHeaders,
  setMutableMetadataCacheHeaders,
} from '../../src/middleware/cache.js';

// Simple mock for Fastify reply object
function createMockReply() {
  const headers = {};
  return {
    header(name, value) { headers[name] = value; return this; },
    _headers: headers,
  };
}

// ============================================================================
// computeETag (hash nao-criptografico de Buffer — FNV-1a, 8 chars hex)
// ============================================================================

describe('computeETag', () => {
  it('returns an 8-character hex string', () => {
    const etag = computeETag(Buffer.from('hello'));
    assert.equal(typeof etag, 'string');
    assert.equal(etag.length, 8);
    assert.match(etag, /^[0-9a-f]{8}$/);
  });

  it('is deterministic (same buffer produces same ETag)', () => {
    const buf = Buffer.from('deterministic-test');
    const etag1 = computeETag(buf);
    const etag2 = computeETag(buf);
    assert.equal(etag1, etag2);
  });

  it('returns different values for different buffers', () => {
    const etag1 = computeETag(Buffer.from('buffer-a'));
    const etag2 = computeETag(Buffer.from('buffer-b'));
    assert.notEqual(etag1, etag2);
  });
});

// ============================================================================
// computeImageETag (derivado de uuid + quality + tamanho, sem tocar no BLOB)
// ============================================================================

describe('computeImageETag', () => {
  it('combina uuid, quality e tamanho em bytes', () => {
    const etag = computeImageETag('abc-123', 'full', 4242);
    assert.equal(etag, 'abc-123-full-4242');
  });

  it('e deterministico para os mesmos argumentos', () => {
    assert.equal(
      computeImageETag('uuid', 'preview', 10),
      computeImageETag('uuid', 'preview', 10),
    );
  });

  it('difere por quality', () => {
    assert.notEqual(
      computeImageETag('uuid', 'full', 10),
      computeImageETag('uuid', 'preview', 10),
    );
  });

  it('difere por tamanho', () => {
    assert.notEqual(
      computeImageETag('uuid', 'full', 10),
      computeImageETag('uuid', 'full', 20),
    );
  });

  it('trata tamanho ausente como 0', () => {
    assert.equal(computeImageETag('uuid', 'full', undefined), 'uuid-full-0');
    assert.equal(computeImageETag('uuid', 'full', null), 'uuid-full-0');
  });
});

// ============================================================================
// computeMetadataETag (hash barato sobre assinatura de metadados)
// ============================================================================

describe('computeMetadataETag', () => {
  it('returns an 8-character hex string', () => {
    const etag = computeMetadataETag('sig|a|b|c');
    assert.match(etag, /^[0-9a-f]{8}$/);
  });

  it('e deterministico para a mesma assinatura', () => {
    assert.equal(computeMetadataETag('x|y'), computeMetadataETag('x|y'));
  });

  it('difere para assinaturas diferentes', () => {
    assert.notEqual(computeMetadataETag('x|y'), computeMetadataETag('x|z'));
  });
});

// ============================================================================
// setImageCacheHeaders
// ============================================================================

describe('setImageCacheHeaders', () => {
  it('sets Cache-Control with immutable and max-age=31536000', () => {
    const reply = createMockReply();
    setImageCacheHeaders(reply, 'abc123');
    assert.ok(reply._headers['Cache-Control'].includes('immutable'));
    assert.ok(reply._headers['Cache-Control'].includes('31536000'));
    assert.ok(reply._headers['Cache-Control'].includes('public'));
  });

  it('sets ETag header with double quotes', () => {
    const reply = createMockReply();
    setImageCacheHeaders(reply, 'abc123');
    assert.equal(reply._headers['ETag'], '"abc123"');
  });

  it('does not set ETag header when etag is falsy', () => {
    const reply1 = createMockReply();
    setImageCacheHeaders(reply1, null);
    assert.equal(reply1._headers['ETag'], undefined);
    assert.ok(reply1._headers['Cache-Control']);

    const reply2 = createMockReply();
    setImageCacheHeaders(reply2, undefined);
    assert.equal(reply2._headers['ETag'], undefined);

    const reply3 = createMockReply();
    setImageCacheHeaders(reply3, '');
    assert.equal(reply3._headers['ETag'], undefined);
  });
});

// ============================================================================
// setMetadataCacheHeaders
// ============================================================================

describe('setMetadataCacheHeaders', () => {
  it('sets Cache-Control with max-age=3600', () => {
    const reply = createMockReply();
    setMetadataCacheHeaders(reply);
    assert.ok(reply._headers['Cache-Control'].includes('3600'));
    assert.ok(reply._headers['Cache-Control'].includes('public'));
  });
});

// ============================================================================
// setMutableMetadataCacheHeaders
// ============================================================================

describe('setMutableMetadataCacheHeaders', () => {
  it('sets Cache-Control with no-cache', () => {
    const reply = createMockReply();
    setMutableMetadataCacheHeaders(reply);
    assert.ok(reply._headers['Cache-Control'].includes('no-cache'));
    assert.ok(reply._headers['Cache-Control'].includes('public'));
  });

  it('sets ETag validator with double quotes when provided', () => {
    const reply = createMockReply();
    setMutableMetadataCacheHeaders(reply, 'deadbeef');
    assert.equal(reply._headers['ETag'], '"deadbeef"');
  });

  it('does not set ETag header when etag is falsy', () => {
    const reply = createMockReply();
    setMutableMetadataCacheHeaders(reply);
    assert.equal(reply._headers['ETag'], undefined);
    assert.ok(reply._headers['Cache-Control']);
  });
});
