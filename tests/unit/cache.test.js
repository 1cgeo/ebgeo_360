/**
 * @module tests/unit/cache.test
 * @description Unit tests for middleware/cache.js — pure functions, no DB needed.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeETag, setImageCacheHeaders, setMetadataCacheHeaders } from '../../src/middleware/cache.js';

// Simple mock for Fastify reply object
function createMockReply() {
  const headers = {};
  return {
    header(name, value) { headers[name] = value; return this; },
    _headers: headers,
  };
}

// ============================================================================
// computeETag
// ============================================================================

describe('computeETag', () => {
  it('returns a 16-character hex string', () => {
    const etag = computeETag(Buffer.from('hello'));
    assert.equal(typeof etag, 'string');
    assert.equal(etag.length, 16);
    assert.match(etag, /^[0-9a-f]{16}$/);
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
