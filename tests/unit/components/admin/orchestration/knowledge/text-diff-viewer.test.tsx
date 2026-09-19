// @vitest-environment happy-dom

/**
 * TextDiffViewer Component Tests
 *
 * Test Coverage:
 * - Unified rows carry the op type they represent, with the right prefix and
 *   both line-number gutters.
 * - Pure addition / pure deletion / mixed edit produce the expected op mix.
 * - Long unchanged runs collapse behind an expander and expand on click; short
 *   runs are never collapsed.
 * - Split mode pairs a removal with its replacement on one row, and emits a
 *   filler when one side has no counterpart.
 * - The +added/−removed summary counts the ops, not the rendered rows (which
 *   collapsing hides).
 * - The 1,500-changed-line cap still swaps the diff for a notice, and the
 *   prefix/suffix trim still keeps a small change in a large document diffable.
 *
 * Mocking: none. Renders with @testing-library/react and inspects the real DOM.
 *
 * @see components/admin/orchestration/knowledge/text-diff-viewer.tsx
 */

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { TextDiffViewer } from '@/components/admin/orchestration/knowledge/text-diff-viewer';

// ── helpers ───────────────────────────────────────────────────────────────────

function rowTypes(container: HTMLElement, testid = 'diff-row'): string[] {
  return Array.from(container.querySelectorAll(`[data-testid="${testid}"]`)).map(
    (el) => el.getAttribute('data-diff-type') ?? ''
  );
}

/** Line text of a unified row, with the two gutters and the +/- marker stripped. */
function rowText(el: Element): string {
  const spans = Array.from(el.querySelectorAll('span'));
  return spans[spans.length - 1]?.textContent ?? '';
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('TextDiffViewer', () => {
  describe('unified mode', () => {
    it('marks each row with its op type and renders both line-number gutters', () => {
      // 'b' replaced by 'x'; 'a' and 'c' unchanged.
      const { container } = render(<TextDiffViewer before={'a\nb\nc'} after={'a\nx\nc'} />);

      const types = rowTypes(container);
      expect(types.filter((t) => t === 'equal').length).toBe(2);
      expect(types.filter((t) => t === 'add').length).toBe(1);
      expect(types.filter((t) => t === 'del').length).toBe(1);

      // The deleted line carries a before-number but no after-number; the
      // added line the reverse. That asymmetry is what makes the gutters
      // readable, so assert it rather than just "a number appears".
      const del = container.querySelector('[data-diff-type="del"]');
      const add = container.querySelector('[data-diff-type="add"]');
      const gutters = (el: Element | null) =>
        Array.from(el?.querySelectorAll('span') ?? [])
          .slice(0, 2)
          .map((s) => s.textContent);
      expect(gutters(del)).toEqual(['2', '']);
      expect(gutters(add)).toEqual(['', '2']);
    });

    it('pure addition against empty input renders both new lines as adds', () => {
      const { container } = render(<TextDiffViewer before="" after={'a\nb'} />);
      expect(rowTypes(container).filter((t) => t === 'add').length).toBe(2);
    });

    it('pure deletion to empty input renders both old lines as deletions', () => {
      const { container } = render(<TextDiffViewer before={'a\nb'} after="" />);
      expect(rowTypes(container).filter((t) => t === 'del').length).toBe(2);
    });

    it('preserves a blank line as its own row rather than dropping it', async () => {
      // No changes at all, so the whole document sits behind one expander —
      // expand it to inspect the rows.
      const user = userEvent.setup();
      const { container } = render(
        <TextDiffViewer before={'first\n\nthird'} after={'first\n\nthird'} />
      );
      await user.click(screen.getByTestId('diff-gap'));

      const rows = container.querySelectorAll('[data-testid="diff-row"]');
      expect(rows.length).toBe(3);
      // The middle row renders a non-breaking placeholder so it still has height.
      expect(rowText(rows[1])).toBe(' ');
    });

    it('reports added and removed counts in the summary', () => {
      const { container } = render(<TextDiffViewer before={'a\nb\nc'} after={'a\nx\ny\nc'} />);
      expect(container.textContent).toMatch(/\+2 added/);
      expect(container.textContent).toMatch(/−1 removed/);
    });

    it('says "no differences" when the two sides are identical', () => {
      const { container } = render(<TextDiffViewer before="same" after="same" />);
      expect(container.textContent).toMatch(/no differences/i);
    });
  });

  describe('collapsing unchanged runs', () => {
    it('collapses a long unchanged run and keeps contextLines rows either side of the change', () => {
      // 20 unchanged lines, one changed line, 20 more unchanged.
      const before = [
        ...Array.from({ length: 20 }, (_, i) => `pre ${i}`),
        'target',
        ...Array.from({ length: 20 }, (_, i) => `post ${i}`),
      ].join('\n');
      const after = before.replace('target', 'target rewritten');

      const { container } = render(
        <TextDiffViewer before={before} after={after} contextLines={3} />
      );

      // Two gaps — one before the change, one after.
      expect(container.querySelectorAll('[data-testid="diff-gap"]').length).toBe(2);
      // Visible rows: 3 context + del + add + 3 context = 8. The other 34
      // unchanged lines are behind the expanders.
      expect(container.querySelectorAll('[data-testid="diff-row"]').length).toBe(8);
      expect(container.textContent).toMatch(/17 unchanged lines/);
    });

    it('expands a collapsed run in place when its expander is clicked', async () => {
      const before = [...Array.from({ length: 20 }, (_, i) => `pre ${i}`), 'target'].join('\n');
      const after = before.replace('target', 'target rewritten');

      const user = userEvent.setup();
      const { container } = render(
        <TextDiffViewer before={before} after={after} contextLines={3} />
      );

      const collapsedRows = container.querySelectorAll('[data-testid="diff-row"]').length;
      await user.click(screen.getByTestId('diff-gap'));

      // The 17 hidden lines are now rendered, and the expander is gone.
      expect(container.querySelectorAll('[data-testid="diff-row"]').length).toBe(
        collapsedRows + 17
      );
      expect(container.querySelector('[data-testid="diff-gap"]')).toBeNull();
    });

    it('does not collapse an unchanged run short enough to fit in the context', () => {
      // 4 unchanged lines between two changes, with contextLines=3 either
      // side — collapsing would hide nothing and cost a row.
      const before = ['x', 'a', 'b', 'c', 'd', 'y'].join('\n');
      const after = ['x1', 'a', 'b', 'c', 'd', 'y1'].join('\n');

      const { container } = render(
        <TextDiffViewer before={before} after={after} contextLines={3} />
      );

      expect(container.querySelector('[data-testid="diff-gap"]')).toBeNull();
      expect(rowTypes(container).filter((t) => t === 'equal').length).toBe(4);
    });
  });

  describe('split mode', () => {
    it('pairs a removal with its replacement on the same row', () => {
      const { container } = render(
        <TextDiffViewer before={'a\nb\nc'} after={'a\nx\nc'} mode="split" />
      );

      const rows = Array.from(container.querySelectorAll('.grid.grid-cols-2')).filter((el) =>
        el.querySelector('[data-testid="diff-half"]')
      );
      const replaced = rows.find((r) => r.querySelector('[data-diff-type="del"]'));
      expect(replaced).toBeDefined();
      // Same row carries the addition — this is the whole point of split view.
      expect(replaced?.querySelector('[data-diff-type="add"]')).not.toBeNull();
    });

    it('renders a filler opposite an unmatched addition', () => {
      const { container } = render(
        <TextDiffViewer before={'a\nc'} after={'a\nb\nc'} mode="split" />
      );
      expect(container.querySelector('[data-diff-type="filler"]')).not.toBeNull();
    });

    it('labels the two columns', () => {
      render(
        <TextDiffViewer
          before="a"
          after="b"
          mode="split"
          beforeLabel="Original"
          afterLabel="Cleaned"
        />
      );
      expect(screen.getByText('Original')).toBeInTheDocument();
      expect(screen.getByText('Cleaned')).toBeInTheDocument();
    });
  });

  describe('size guard', () => {
    it('renders a notice instead of a diff when more than 1500 lines changed on one side', () => {
      // The LCS table is (m+1)·(n+1) numbers, so an unbounded whole-document
      // diff on a cleanup-sized doc allocates tens of millions of slots and
      // hangs the tab. Nothing is shared here, so the changed span is the
      // whole input on both sides.
      const before = Array.from({ length: 2_000 }, (_, i) => `old line ${i}`).join('\n');
      const after = Array.from({ length: 2_000 }, (_, i) => `new line ${i}`).join('\n');

      const { container } = render(<TextDiffViewer before={before} after={after} />);

      expect(container.querySelector('[data-testid="diff-row"]')).toBeNull();
      expect(container.textContent).toMatch(/Too much changed to diff inline/i);
      expect(container.textContent).toMatch(/2,000 lines before/);
    });

    it('still diffs a large document when only a few lines changed', () => {
      // A section rewrite changes a handful of lines in an otherwise untouched
      // document. Trimming the common prefix/suffix keeps the table small, so
      // this must NOT hit the cap.
      const lines = Array.from({ length: 5_000 }, (_, i) => `line ${i}`);
      const before = lines.join('\n');
      const changed = [...lines];
      changed[2_500] = 'line 2500 — rewritten';
      const after = changed.join('\n');

      const { container } = render(<TextDiffViewer before={before} after={after} />);

      expect(container.textContent).not.toMatch(/Too much changed to diff inline/i);
      expect(rowTypes(container).filter((t) => t === 'del').length).toBe(1);
      expect(rowTypes(container).filter((t) => t === 'add').length).toBe(1);
    });

    it('short-circuits identical large inputs instead of building the table', () => {
      // The history view passes the same string on both sides whenever a
      // revision made no net change. That must not build a 5000×5000 table.
      const text = Array.from({ length: 5_000 }, (_, i) => `line ${i}`).join('\n');

      const { container } = render(<TextDiffViewer before={text} after={text} />);

      expect(container.textContent).not.toMatch(/Too much changed to diff inline/i);
      expect(container.textContent).toMatch(/5,000 unchanged lines/);
    });
  });
});
