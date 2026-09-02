// @vitest-environment happy-dom

/**
 * Unit Tests: ResparkableAppHeader.
 *
 * Thin composition component — the interesting behaviour (search submit,
 * theme toggling, the account menu's own contents) is already pinned down
 * in `resparkable-search-box.test.tsx`, `theme-toggle`'s own coverage, and
 * `user-button.test.tsx`. What matters here is the contract this file's
 * header comment promises: the brand mark is a real link home (not text),
 * the search box renders in its `compact` size, and — since `/resparkable`
 * moved to its own route group specifically so this is the *only* header —
 * `UserButton` (Sunrise's own account menu) renders here now, not a second
 * copy of it and not nothing.
 *
 * @see components/resparkable/shell/app-header.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useRouter, useSearchParams } from 'next/navigation';

import { ResparkableAppHeader } from '@/components/resparkable/shell/app-header';
import { RESPARKABLE_ROUTES } from '@/lib/framework/resparkable/ui/routes';
import { createMockRouter } from '@/tests/types/mocks';

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

// UserButton's own state machine (loading/signed-out/signed-in) is covered
// by its own test file — a signed-in session here just proves this header
// actually renders it, not a second copy of Sunrise's header.
const mockUseSession = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/client', () => ({
  authClient: { signOut: vi.fn() },
  useSession: () => mockUseSession(),
}));

const mockedRouter = useRouter as unknown as ReturnType<typeof vi.fn>;
const mockedSearchParams = useSearchParams as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockedRouter.mockReturnValue(createMockRouter());
  mockedSearchParams.mockReturnValue(new URLSearchParams());
  mockUseSession.mockReturnValue({
    data: { user: { name: 'Jamie Doe', email: 'jamie@example.com', role: 'USER' } },
    isPending: false,
  });
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

  it('renders exactly one theme toggle and the account menu', () => {
    render(<ResparkableAppHeader />);

    expect(screen.getByRole('button', { name: /toggle theme/i })).toBeInTheDocument();
    // The avatar trigger's accessible name is the user's initials
    // (`AvatarFallback`) — "Jamie Doe" → "JD".
    expect(screen.getByRole('button', { name: 'JD' })).toBeInTheDocument();
  });

  it('surfaces Profile/Settings/Admin/sign-out via the avatar dropdown', async () => {
    mockUseSession.mockReturnValue({
      data: { user: { name: 'Jamie Doe', email: 'jamie@example.com', role: 'ADMIN' } },
      isPending: false,
    });
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    render(<ResparkableAppHeader />);

    await user.click(screen.getByRole('button', { name: 'JD' }));

    expect(screen.getByRole('menuitem', { name: /view profile/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /^settings/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /admin dashboard/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /sign out/i })).toBeInTheDocument();
  });

  it('renders no Present button when no handler is passed', () => {
    render(<ResparkableAppHeader />);

    expect(screen.queryByRole('button', { name: 'Present' })).not.toBeInTheDocument();
  });

  it('renders a Present button that calls onPresent when passed', async () => {
    const onPresent = vi.fn();
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    render(<ResparkableAppHeader onPresent={onPresent} />);

    await user.click(screen.getByRole('button', { name: 'Present' }));
    expect(onPresent).toHaveBeenCalledTimes(1);
  });
});
