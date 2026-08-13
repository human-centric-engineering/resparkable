/**
 * Unit Tests: `app/manifest.ts`.
 *
 * A one-line seam (see its own header): the file exists so a host can swap
 * PWA identity without touching Resparkable's. The only thing worth pinning is
 * that it really does hand back Resparkable's manifest unchanged — the content
 * itself is `RESPARKABLE_MANIFEST`'s own test file's job
 * (`lib/framework/resparkable/pwa/manifest.test.ts`).
 *
 * @see app/manifest.ts
 */

import { describe, expect, it } from 'vitest';

import manifest from '@/app/manifest';
import { RESPARKABLE_MANIFEST } from '@/lib/framework/resparkable/pwa/manifest';

describe('manifest', () => {
  it('returns RESPARKABLE_MANIFEST unchanged', () => {
    expect(manifest()).toBe(RESPARKABLE_MANIFEST);
  });
});
