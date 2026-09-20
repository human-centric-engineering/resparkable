// @vitest-environment happy-dom

/**
 * SectionList Component Tests
 *
 * Covers the virtualisation threshold (50 sections):
 *   - Under threshold → direct render path; every section is in the DOM
 *   - At/above threshold → react-window virtualised path; only on-screen rows mount
 *
 * The virtualised path is asserted via the path marker (data-testid) plus a
 * bounded DOM-node count — exact mount counts depend on row measurement
 * heuristics in happy-dom, which aren't worth asserting precisely.
 *
 * @see components/admin/orchestration/knowledge/section-list.tsx
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { SectionList } from '@/components/admin/orchestration/knowledge/section-list';
import type { Section } from '@/lib/orchestration/knowledge/section-detection';

function makeSections(count: number): Section[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `section-${i}`,
    marker: `## Section ${i}`,
    body: `Body of section ${i}.`,
    startOffset: 0,
    endOffset: 20,
  }));
}

const BASE_PROPS = {
  documentId: 'doc-abc-123',
  contextWindow: 200_000,
  acquireLock: vi.fn().mockResolvedValue(true),
  onSaved: vi.fn(),
  onPendingChange: vi.fn(),
};

describe('SectionList', () => {
  describe('below virtualisation threshold (< 50 sections)', () => {
    it('renders the direct path and mounts every section in the DOM', () => {
      const sections = makeSections(10);
      render(<SectionList {...BASE_PROPS} sections={sections} />);

      // Path marker confirms the direct (non-virtualised) branch was taken.
      expect(screen.getByTestId('section-list-direct')).toBeInTheDocument();
      expect(screen.queryByTestId('section-list-virtual')).toBeNull();

      // Every section body should be in the DOM — direct path mounts all.
      for (let i = 0; i < sections.length; i++) {
        expect(screen.getByText(`Body of section ${i}.`)).toBeInTheDocument();
      }
    });

    it('renders the direct path at the boundary (sections.length = 49)', () => {
      render(<SectionList {...BASE_PROPS} sections={makeSections(49)} />);
      expect(screen.getByTestId('section-list-direct')).toBeInTheDocument();
      expect(screen.queryByTestId('section-list-virtual')).toBeNull();
    });
  });

  describe('at/above virtualisation threshold (≥ 50 sections)', () => {
    it('renders the virtualised path for 50 sections', () => {
      render(<SectionList {...BASE_PROPS} sections={makeSections(50)} />);
      expect(screen.getByTestId('section-list-virtual')).toBeInTheDocument();
      expect(screen.queryByTestId('section-list-direct')).toBeNull();
    });

    it('renders the virtualised path for 200 sections and mounts only a bounded subset', () => {
      const sections = makeSections(200);
      render(<SectionList {...BASE_PROPS} sections={sections} />);

      expect(screen.getByTestId('section-list-virtual')).toBeInTheDocument();

      // Virtualisation should keep the mounted-row count well below the
      // total. The exact number depends on row-height measurement in the
      // test environment — assert a generous upper bound that still proves
      // virtualisation is doing its job (mounting < 25% of rows).
      const mountedBodies = sections.filter((_, i) =>
        screen.queryByText(`Body of section ${i}.`)
      ).length;
      expect(mountedBodies).toBeLessThan(50);
    });
  });
});
