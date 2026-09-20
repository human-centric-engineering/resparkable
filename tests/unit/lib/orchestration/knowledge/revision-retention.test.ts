import { describe, it, expect } from 'vitest';

import { DEFAULT_REVISION_RETENTION } from '@/lib/orchestration/knowledge/revision-retention';

/**
 * `DEFAULT_REVISION_RETENTION` lives in its own module (rather than inline
 * in `revisions.ts`) specifically so the client-side revision-drawer hint
 * can import it without pulling the Prisma client into the browser bundle.
 * `revisions.test.ts` covers the env-var override + clamping behaviour that
 * consumes this constant; this just pins the constant itself so a change
 * here is deliberate, not a drive-by edit.
 */
describe('DEFAULT_REVISION_RETENTION', () => {
  it('is 50, matching the documented default', () => {
    expect(DEFAULT_REVISION_RETENTION).toBe(50);
  });

  it('is within the [10, 500] range revisions.ts clamps KB_REVISION_RETENTION to', () => {
    expect(DEFAULT_REVISION_RETENTION).toBeGreaterThanOrEqual(10);
    expect(DEFAULT_REVISION_RETENTION).toBeLessThanOrEqual(500);
  });
});
