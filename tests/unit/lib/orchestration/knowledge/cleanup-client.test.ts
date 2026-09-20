/**
 * sha256Hex Tests
 *
 * Test Coverage:
 * - Empty string → known canonical SHA-256 digest
 * - Short ASCII string → cross-checked against Node's crypto.createHash('sha256')
 * - Unicode / multi-byte string → cross-checked against Node's crypto.createHash('sha256')
 *
 * Key property: sha256Hex must agree with server-side createHash('sha256') because the
 * server uses node crypto for fingerprint comparison and rejects with 409 CONTENT_MISMATCH
 * on hash drift. Cross-checking against node crypto in these tests is the anti-green-bar
 * move that proves the client and server implementations agree on the same byte sequence.
 *
 * Mocking: none. Uses real Web Crypto (crypto.subtle.digest), which happy-dom v20 provides
 * via Node's webcrypto.
 *
 * @see lib/orchestration/knowledge/cleanup-client.ts
 */

import { createHash } from 'crypto';
import { describe, expect, it } from 'vitest';

import { sha256Hex } from '@/lib/orchestration/knowledge/cleanup-client';

// ── helpers ──────────────────────────────────────────────────────────────────

/** Derive the expected digest using Node's createHash — the same implementation
 *  the server uses — so tests prove client ↔ server agreement, not just
 *  self-consistency. */
function nodesha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('sha256Hex', () => {
  it('empty string → canonical SHA-256 digest (e3b0c4...)', async () => {
    // Arrange
    const input = '';
    const expectedDigest = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

    // Act
    const result = await sha256Hex(input);

    // Assert: this is the universally-agreed SHA-256 of the empty byte sequence.
    // If the implementation gets the encoding wrong (e.g. passes an empty buffer
    // with a BOM), it would produce a different digest.
    expect(result).toBe(expectedDigest);
  });

  it('short ASCII string → digest matches Node crypto (client–server agreement)', async () => {
    // Arrange
    const input = 'hello world';
    // Derive expected via Node's crypto — the server-side implementation.
    // Hardcoding the hex would only prove self-consistency; using nodesha256()
    // here proves the Web Crypto path agrees with the node path byte-for-byte.
    const expected = nodesha256(input);

    // Act
    const result = await sha256Hex(input);

    // Assert: client output matches server output — any encoding divergence
    // (e.g. UTF-16 vs UTF-8) would produce a mismatch.
    expect(result).toBe(expected);
    // Sanity: result must be 64 hex chars (SHA-256 = 256 bits = 32 bytes = 64 hex digits)
    expect(result).toHaveLength(64);
    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });

  it('Unicode + multi-byte content → digest matches Node crypto (UTF-8 byte handling)', async () => {
    // Arrange — café contains an accented character (2-byte UTF-8), 🚀 is 4-byte UTF-8.
    // If sha256Hex encodes as UTF-16 instead of UTF-8 the digest will differ from Node's.
    const input = 'café 🚀';
    const expected = nodesha256(input);

    // Act
    const result = await sha256Hex(input);

    // Assert: multi-byte characters are encoded as UTF-8 on both sides.
    // A wrong encoding (e.g. TextEncoder defaulting to something else, or node
    // using a different charset) would produce a different 64-char string.
    expect(result).toBe(expected);
    expect(result).toHaveLength(64);
    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });
});
