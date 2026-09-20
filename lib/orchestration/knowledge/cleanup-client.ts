// Client-side helpers for the Document Clean Up editor. Kept separate from
// section-detection.ts (which is isomorphic) so server bundles don't pick
// up Web Crypto types they don't need.

// SHA-256 hex digest matching server-side createHash('sha256'). Used to
// compute `expectedFingerprint` for the inline edit endpoints — the server
// rejects with 409 CONTENT_MISMATCH on hash drift.
export async function sha256Hex(text: string): Promise<string> {
  const buf = new TextEncoder().encode(text);
  const hashBuf = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
