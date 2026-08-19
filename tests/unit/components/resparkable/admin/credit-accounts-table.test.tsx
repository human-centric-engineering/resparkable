/**
 * CreditAccountsTable Component Tests
 *
 * `CreditAccountsTable` is the admin per-user balance table with a
 * "Grant credits" action per row. Unlike `UserTable`, it does no client-side
 * fetching of its own: the accounts list comes in as a prop, and a successful
 * grant closes the dialog and calls `router.refresh()` so the server
 * component re-fetches, rather than reimplementing a merge path here.
 *
 * Test Coverage:
 * - Renders one row per account with the balance formatted and the currency
 *   label appended
 * - Name/email display: name as primary line + email as secondary line when
 *   a name exists; just the email when `userName` is null
 * - Explicit empty state ("No users yet.") when `accounts` is `[]`
 * - "Grant credits" opens a dialog scoped to that row's user
 * - The Grant button is disabled until amount is a valid nonzero finite
 *   number (0 and empty both keep it disabled)
 * - A valid submit posts to `RESPARKABLE_API.ADMIN.BILLING_GRANTS` with the
 *   right body (note omitted when blank), closes the dialog, and refreshes
 * - A negative amount is accepted as a documented correction case
 * - A POST failure surfaces an error message and keeps the dialog open
 *   (no refresh)
 * - Cancel closes the dialog without submitting
 *
 * @see components/resparkable/admin/credit-accounts-table.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRouter } from 'next/navigation';

import { CreditAccountsTable } from '@/components/resparkable/admin/credit-accounts-table';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import type { ResparkableAdminCreditAccountRow } from '@/lib/framework/resparkable/validations';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('@/lib/api/client', () => ({
  apiClient: { post: vi.fn() },
  APIClientError: class APIClientError extends Error {
    constructor(
      message: string,
      public code = 'INTERNAL_ERROR',
      public status = 500
    ) {
      super(message);
      this.name = 'APIClientError';
    }
  },
}));

import { apiClient, APIClientError } from '@/lib/api/client';

const mockedPost = apiClient.post as ReturnType<typeof vi.fn>;
const mockedRouter = useRouter as unknown as ReturnType<typeof vi.fn>;
const refresh = vi.fn();

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeAccount(
  overrides: Partial<ResparkableAdminCreditAccountRow> = {}
): ResparkableAdminCreditAccountRow {
  return {
    userId: 'user_1',
    userName: 'Alice Johnson',
    userEmail: 'alice@example.com',
    balanceCredits: 1000,
    ...overrides,
  };
}

/** The body of the single POST the test triggered. */
function postedBody(): Record<string, unknown> {
  return mockedPost.mock.calls[0]?.[1]?.body as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedRouter.mockReturnValue({
    push: vi.fn(),
    replace: vi.fn(),
    refresh,
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  });
});

describe('CreditAccountsTable', () => {
  // ── Rendering ──────────────────────────────────────────────────────────────

  describe('rendering', () => {
    it('renders one row per account with balance formatted and currency label appended', () => {
      const accounts = [
        makeAccount({ userId: 'user_1', userName: 'Alice Johnson', balanceCredits: 1234567 }),
        makeAccount({
          userId: 'user_2',
          userName: 'Bob Smith',
          userEmail: 'bob@example.com',
          balanceCredits: 50,
        }),
      ];

      render(<CreditAccountsTable accounts={accounts} currencyLabel="credits" />);

      // Large balance is thousands-separated by toLocaleString(), not raw digits.
      expect(screen.getByText('1,234,567 credits')).toBeInTheDocument();
      expect(screen.getByText('50 credits')).toBeInTheDocument();

      // One "Grant credits" button per row.
      expect(screen.getAllByRole('button', { name: /grant credits/i })).toHaveLength(2);
    });

    it('shows the name as the primary line and the email as a secondary line when a name exists', () => {
      const accounts = [makeAccount({ userName: 'Alice Johnson', userEmail: 'alice@example.com' })];

      render(<CreditAccountsTable accounts={accounts} currencyLabel="credits" />);

      expect(screen.getByText('Alice Johnson')).toBeInTheDocument();
      expect(screen.getByText('alice@example.com')).toBeInTheDocument();
    });

    it('shows just the email when userName is null', () => {
      const accounts = [makeAccount({ userName: null, userEmail: 'noname@example.com' })];

      render(<CreditAccountsTable accounts={accounts} currencyLabel="credits" />);

      // Email appears exactly once — as the primary line, not duplicated as a
      // secondary line under itself.
      expect(screen.getAllByText('noname@example.com')).toHaveLength(1);
    });

    it('renders the empty state when accounts is empty', () => {
      render(<CreditAccountsTable accounts={[]} currencyLabel="credits" />);

      expect(screen.getByText('No users yet.')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /grant credits/i })).not.toBeInTheDocument();
    });
  });

  // ── Dialog scoping ────────────────────────────────────────────────────────

  describe('dialog scoping', () => {
    it('opens a dialog scoped to the clicked row’s user', async () => {
      const user = userEvent.setup();
      const accounts = [
        makeAccount({
          userId: 'user_1',
          userName: 'Alice Johnson',
          userEmail: 'alice@example.com',
        }),
        makeAccount({ userId: 'user_2', userName: 'Bob Smith', userEmail: 'bob@example.com' }),
      ];

      render(<CreditAccountsTable accounts={accounts} currencyLabel="credits" />);

      const grantButtons = screen.getAllByRole('button', { name: /grant credits/i });
      await user.click(grantButtons[1]);

      // Dialog title identifies Bob's email (the userLabel), not Alice's.
      expect(
        await screen.findByRole('heading', { name: /grant credits to bob@example\.com/i })
      ).toBeInTheDocument();
    });
  });

  // ── Amount validation ─────────────────────────────────────────────────────

  describe('amount validation', () => {
    it('keeps the Grant button disabled when the amount is empty', async () => {
      const user = userEvent.setup();
      render(<CreditAccountsTable accounts={[makeAccount()]} currencyLabel="credits" />);

      await user.click(screen.getByRole('button', { name: /grant credits/i }));
      const grantButton = await screen.findByRole('button', { name: /^grant$/i });

      expect(grantButton).toBeDisabled();
    });

    it('keeps the Grant button disabled when the amount is 0', async () => {
      const user = userEvent.setup();
      render(<CreditAccountsTable accounts={[makeAccount()]} currencyLabel="credits" />);

      await user.click(screen.getByRole('button', { name: /grant credits/i }));
      await user.type(document.getElementById('grant-amount') as HTMLInputElement, '0');

      expect(screen.getByRole('button', { name: /^grant$/i })).toBeDisabled();
    });

    it('enables the Grant button for a valid nonzero amount', async () => {
      const user = userEvent.setup();
      render(<CreditAccountsTable accounts={[makeAccount()]} currencyLabel="credits" />);

      await user.click(screen.getByRole('button', { name: /grant credits/i }));
      await user.type(document.getElementById('grant-amount') as HTMLInputElement, '100');

      expect(screen.getByRole('button', { name: /^grant$/i })).not.toBeDisabled();
    });
  });

  // ── Submit ─────────────────────────────────────────────────────────────────

  describe('submit', () => {
    it('posts to BILLING_GRANTS with the right body, closes the dialog, and refreshes', async () => {
      mockedPost.mockResolvedValueOnce({});
      const user = userEvent.setup();
      const accounts = [makeAccount({ userId: 'user_1' })];

      render(<CreditAccountsTable accounts={accounts} currencyLabel="credits" />);

      await user.click(screen.getByRole('button', { name: /grant credits/i }));
      await user.type(document.getElementById('grant-amount') as HTMLInputElement, '250');
      await user.type(
        document.getElementById('grant-note') as HTMLTextAreaElement,
        'Goodwill credit'
      );
      await user.click(screen.getByRole('button', { name: /^grant$/i }));

      await waitFor(() => expect(mockedPost).toHaveBeenCalledTimes(1));
      expect(mockedPost).toHaveBeenCalledWith(RESPARKABLE_API.ADMIN.BILLING_GRANTS, {
        body: { userId: 'user_1', amount: 250, note: 'Goodwill credit' },
      });

      // Dialog closes on success.
      await waitFor(() => {
        expect(
          screen.queryByRole('heading', { name: /grant credits to/i })
        ).not.toBeInTheDocument();
      });
      expect(refresh).toHaveBeenCalled();
    });

    it('omits note from the body when the textarea was left blank', async () => {
      mockedPost.mockResolvedValueOnce({});
      const user = userEvent.setup();

      render(<CreditAccountsTable accounts={[makeAccount()]} currencyLabel="credits" />);

      await user.click(screen.getByRole('button', { name: /grant credits/i }));
      await user.type(document.getElementById('grant-amount') as HTMLInputElement, '100');
      await user.click(screen.getByRole('button', { name: /^grant$/i }));

      await waitFor(() => expect(mockedPost).toHaveBeenCalled());
      expect(postedBody()).not.toHaveProperty('note');
      expect(postedBody()).toEqual({ userId: 'user_1', amount: 100 });
    });

    it('accepts a negative amount as a documented correction', async () => {
      mockedPost.mockResolvedValueOnce({});
      const user = userEvent.setup();

      render(<CreditAccountsTable accounts={[makeAccount()]} currencyLabel="credits" />);

      await user.click(screen.getByRole('button', { name: /grant credits/i }));
      await user.type(document.getElementById('grant-amount') as HTMLInputElement, '-75');

      const grantButton = screen.getByRole('button', { name: /^grant$/i });
      expect(grantButton).not.toBeDisabled();

      await user.click(grantButton);

      await waitFor(() => expect(mockedPost).toHaveBeenCalled());
      expect(postedBody().amount).toBe(-75);
    });

    it('shows an error and keeps the dialog open on POST failure', async () => {
      mockedPost.mockRejectedValueOnce(
        new APIClientError('Insufficient ledger permissions', 'FORBIDDEN', 403)
      );
      const user = userEvent.setup();

      render(<CreditAccountsTable accounts={[makeAccount()]} currencyLabel="credits" />);

      await user.click(screen.getByRole('button', { name: /grant credits/i }));
      await user.type(document.getElementById('grant-amount') as HTMLInputElement, '100');
      await user.click(screen.getByRole('button', { name: /^grant$/i }));

      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent('Insufficient ledger permissions');
      });

      // Dialog stays open; no refresh happened.
      expect(screen.getByRole('heading', { name: /grant credits to/i })).toBeInTheDocument();
      expect(refresh).not.toHaveBeenCalled();
    });

    it('cancel closes the dialog without submitting', async () => {
      const user = userEvent.setup();

      render(<CreditAccountsTable accounts={[makeAccount()]} currencyLabel="credits" />);

      await user.click(screen.getByRole('button', { name: /grant credits/i }));
      await user.type(document.getElementById('grant-amount') as HTMLInputElement, '100');
      await user.click(screen.getByRole('button', { name: /^cancel$/i }));

      await waitFor(() => {
        expect(
          screen.queryByRole('heading', { name: /grant credits to/i })
        ).not.toBeInTheDocument();
      });
      expect(mockedPost).not.toHaveBeenCalled();
      expect(refresh).not.toHaveBeenCalled();
    });
  });
});
