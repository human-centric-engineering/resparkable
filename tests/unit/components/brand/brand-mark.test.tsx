// @vitest-environment happy-dom

/**
 * BrandMark slot (issue #347)
 *
 * The fork-owned header/footer brand slot. Resparkable's default body renders
 * `BRAND.name` as a bare string; Resparkable has taken the slot up on its offer and
 * renders the loop-and-spark mark alongside the wordmark, which is exactly the modification
 * the seam exists to absorb.
 *
 * So the contract these tests hold is the seam's, not the default body's: the
 * configured name must still reach the DOM as text (it is the accessible name of
 * the surrounding link), and the decoration must stay decoration — hidden from
 * assistive tech, or every page would announce "graphic, link, resparkable".
 *
 * `BRAND.name` is read from the `lib/app/brand.ts` seam at module load, and
 * tests/setup.ts pins that seam to null for the whole suite — so the name these
 * cases see is the unconfigured default, not the fork's. That is deliberate:
 * what is under test here is the slot's structure, and the fork's own brand is
 * rendered through every surface in tests/unit/brand-fork-surfaces.test.tsx.
 *
 * @see components/brand/brand-mark.tsx · lib/brand.ts
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render } from '@testing-library/react';
import * as React from 'react';

afterEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
});

async function renderBrandMark(): Promise<HTMLElement> {
  const { BrandMark } = await import('@/components/brand/brand-mark');
  const { container } = render(React.createElement(BrandMark));
  return container;
}

describe('BrandMark default', () => {
  it('renders the default brand name when the seam is unset', async () => {
    const container = await renderBrandMark();
    expect(container.textContent).toBe('Sunrise');
  });

  // Fork-brand cases live in tests/unit/brand-fork-surfaces.test.tsx, which
  // mocks the seam HOISTED. Driving a brand from here needs doMock +
  // resetModules + re-import, which races the module graph and failed on CI.

  it('renders the mark as decoration, not as content', async () => {
    const container = await renderBrandMark();
    const svg = container.querySelector('svg');

    expect(svg).not.toBeNull();
    // Hidden from the accessibility tree: the wordmark text beside it already
    // names the link, and an unlabelled graphic inside it would be announced
    // twice on every page of the app.
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    // The name is still text, so `textContent` — and therefore the link's
    // accessible name — is the brand and nothing else. The svg contributes
    // nothing to it.
    expect(container.textContent).toBe('Sunrise');
  });
});
