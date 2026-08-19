/**
 * Unit Tests: ResparkableAppHeader.
 *
 * Thin composition component — the interesting behaviour (search submit,
 * theme toggling) is already pinned down in `resparkable-search-box.test.tsx`
 * and `theme-toggle`'s own coverage. What matters here is the contract this
 * file's header comment promises: the brand mark is a real link home (not
 * text), the search box renders in its `compact` size, and there is exactly
 * one theme toggle — no `UserButton`, since Sunrise's own header still owns
 * the account menu.
 *
 * @see components/resparkable/shell/app-header.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useRouter, useSearchParams } from 'next/navigation';

import { ResparkableAppHeader } from '@/components/resparkable/shell/app-header';
import { RESPARKABLE_ROUTES } from '@/lib/framework/resparkable/ui/routes';

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(),
  useSearchParams: vi.fn(),
}));

// ThemeToggle's `useTheme` throws outside a `ThemeProvider` — mocked rather
// than wrapped, since this header's own contract doesn't extend to theme
// switching itself (that's `ThemeToggle`'s own coverage).
vi.mock('@/hooks/use-theme', () => ({
  useTheme: () => ({ theme: 'light', setTheme: vi.fn() }),
}));

const mockedRouter = useRouter as unknown as ReturnType<typeof vi.fn>;
const mockedSearchParams = useSearchParams as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockedRouter.mockReturnValue({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  });
  mockedSearchParams.mockReturnValue(new URLSearchParams());
});

describe('ResparkableAppHeader', () => {
  it('links the brand mark home to Today', () => {
    render(<ResparkableAppHeader />);

    const link = screen.getByRole('link', { name: /go to today/i });
    expect(link).toHaveAttribute('href', RESPARKABLE_ROUTES.TODAY);
  });

  it('renders the compact search box', () => {
    render(<ResparkableAppHeader />);

    const search = screen.getByLabelText('Search everything in your brain');
    expect(search.className).toContain('h-8');
  });

  it('renders exactly one theme toggle and no account menu', () => {
    render(<ResparkableAppHeader />);

    expect(screen.getByRole('button', { name: /toggle theme/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /account/i })).not.toBeInTheDocument();
  });
});
