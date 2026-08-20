/**
 * Unit Tests: SectionHeader.
 *
 * Two things worth pinning down: an unrecognised route renders nothing at
 * all (no placeholder — see the component's own header comment), and the
 * `href` prop added for Phase 8's multi-pane shell overrides the browser's
 * own `usePathname()` rather than being merged with or ignored beside it —
 * a pane showing a tab that isn't the current URL still needs its own,
 * correct header.
 *
 * @see components/resparkable/layout/section-header.tsx
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { usePathname } from 'next/navigation';

import { SectionHeader } from '@/components/resparkable/layout/section-header';

vi.mock('next/navigation', () => ({
  usePathname: vi.fn(),
}));

const mockedPathname = usePathname as unknown as ReturnType<typeof vi.fn>;

describe('SectionHeader', () => {
  it('renders nothing for a route with no section-help entry', () => {
    mockedPathname.mockReturnValue('/resparkable/does-not-exist');
    const { container } = render(<SectionHeader />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the section for usePathname() when no href is given', () => {
    mockedPathname.mockReturnValue('/resparkable');
    render(<SectionHeader />);
    expect(screen.getByRole('heading', { name: /Today/i })).toBeInTheDocument();
  });

  it('renders the section for href, ignoring a different current pathname', () => {
    mockedPathname.mockReturnValue('/resparkable');
    render(<SectionHeader href="/resparkable/inbox" />);

    expect(screen.getByRole('heading', { name: /Inbox/i })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /^Today/i })).not.toBeInTheDocument();
  });
});
