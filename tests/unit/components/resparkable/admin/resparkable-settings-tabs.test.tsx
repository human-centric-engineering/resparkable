/**
 * Unit Test: ResparkableSettingsTabs
 *
 * Tests `components/resparkable/admin/resparkable-settings-tabs.tsx` directly
 * (not the parent server page). The component owns two independent
 * null-vs-present branches — one per tab — and this test's job is to prove
 * both branches for both tabs, with the child components mocked to
 * lightweight stand-ins so we're verifying ResparkableSettingsTabs' own
 * branching and prop-passing, not DocumentSettingsForm / BillingSettingsForm /
 * CreditAccountsTable internals (those have their own tests).
 *
 * Coverage gap this closes: the integration test at
 * `tests/integration/app/admin/resparkable/settings/page.test.tsx` only ever
 * renders the page with `billingSettings: null`, so the Billing tab's
 * success path (BillingSettingsForm + CreditAccountsTable rendering with
 * real props) was never exercised — 66.66% function coverage on this file.
 *
 * @see components/resparkable/admin/resparkable-settings-tabs.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ResparkableSettingsTabs } from '@/components/resparkable/admin/resparkable-settings-tabs';
import type { ResparkableDocumentSettings } from '@/components/resparkable/admin/document-settings-form';
import type {
  ResparkableAdminBillingSettingsResponse,
  ResparkableAdminCreditAccountRow,
} from '@/lib/framework/resparkable/validations';
import { createMockRouter } from '@/tests/types/mocks';

// ─── Mocks ────────────────────────────────────────────────────────────────────

// Mock next/navigation, following the convention in
// tests/unit/components/settings/settings-tabs.test.tsx.
vi.mock('next/navigation', async () => {
  const { createMockRouter } = await import('@/tests/types/mocks');
  return {
    useRouter: vi.fn(() => createMockRouter()),
    usePathname: vi.fn(() => '/admin/resparkable/settings'),
    useSearchParams: vi.fn(() => new URLSearchParams()),
  };
});

// Mock the three child components with lightweight stand-ins that surface the
// props they received, so assertions can verify ResparkableSettingsTabs'
// prop-passing without depending on the children's own rendering logic.
vi.mock('@/components/resparkable/admin/document-settings-form', () => ({
  DocumentSettingsForm: vi.fn(({ initial }: { initial: ResparkableDocumentSettings }) => (
    <div data-testid="document-settings-form">{JSON.stringify(initial)}</div>
  )),
}));

vi.mock('@/components/resparkable/admin/billing-settings-form', () => ({
  BillingSettingsForm: vi.fn(
    ({ initial }: { initial: ResparkableAdminBillingSettingsResponse }) => (
      <div data-testid="billing-settings-form">{JSON.stringify(initial)}</div>
    )
  ),
}));

vi.mock('@/components/resparkable/admin/credit-accounts-table', () => ({
  CreditAccountsTable: vi.fn(
    ({
      accounts,
      currencyLabel,
    }: {
      accounts: ResparkableAdminCreditAccountRow[];
      currencyLabel: string;
    }) => (
      <div data-testid="credit-accounts-table" data-currency-label={currencyLabel}>
        {JSON.stringify(accounts)}
      </div>
    )
  ),
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const DOCUMENT_SETTINGS: ResparkableDocumentSettings = {
  documentOriginals: 'discard',
  maxDocumentBytes: 25 * 1024 * 1024,
  isDefault: true,
  storage: { capable: true, provider: 's3', reason: null },
};

const BILLING_SETTINGS: ResparkableAdminBillingSettingsResponse = {
  creditsPerUsd: 1,
  serviceChargePercent: 0,
  costVisibleToUsersDefault: true,
  currencyLabel: 'credits',
  newUserGrantCredits: 0,
  isDefault: false,
};

const CREDIT_ACCOUNTS: ResparkableAdminCreditAccountRow[] = [
  { userId: 'user-1', balanceCredits: 42, userName: 'Ada Lovelace', userEmail: 'ada@example.com' },
];

let mockReplace: Mock;

describe('components/resparkable/admin/resparkable-settings-tabs', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockReplace = vi.fn();

    const { useSearchParams, usePathname, useRouter } = await import('next/navigation');
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams() as unknown as ReturnType<typeof useSearchParams>
    );
    vi.mocked(usePathname).mockReturnValue('/admin/resparkable/settings');
    vi.mocked(useRouter).mockReturnValue(createMockRouter({ replace: mockReplace }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('settings tab', () => {
    it('renders DocumentSettingsForm with the document settings when non-null', () => {
      render(
        <ResparkableSettingsTabs
          documentSettings={DOCUMENT_SETTINGS}
          billingSettings={null}
          creditAccounts={[]}
        />
      );

      const form = screen.getByTestId('document-settings-form');
      expect(form).toBeInTheDocument();
      expect(form).toHaveTextContent(JSON.stringify(DOCUMENT_SETTINGS));
      expect(screen.queryByText(/couldn.?t load settings/i)).not.toBeInTheDocument();
    });

    it('renders the document-specific fallback copy when documentSettings is null', () => {
      render(
        <ResparkableSettingsTabs
          documentSettings={null}
          billingSettings={null}
          creditAccounts={[]}
        />
      );

      expect(screen.queryByTestId('document-settings-form')).not.toBeInTheDocument();
      expect(
        screen.getByText(/originals discarded after parsing, 25 MB upload ceiling/)
      ).toBeInTheDocument();
    });
  });

  describe('billing tab', () => {
    // The Tabs component is controlled by useUrlTabs, which derives the active
    // tab from useSearchParams. Clicking a trigger calls router.replace (mocked
    // to a no-op vi.fn()) but doesn't feed back into useSearchParams the way a
    // real navigation would, so — following the convention in
    // tests/unit/components/settings/settings-tabs.test.tsx — tests that need
    // the Billing tab active pre-set useSearchParams to `tab=billing` before
    // rendering, rather than simulating a click and expecting content to
    // switch.
    async function mockBillingTabActive() {
      const { useSearchParams } = await import('next/navigation');
      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams('tab=billing') as unknown as ReturnType<typeof useSearchParams>
      );
    }

    it('renders BillingSettingsForm and CreditAccountsTable with props when billingSettings is non-null', async () => {
      await mockBillingTabActive();

      render(
        <ResparkableSettingsTabs
          documentSettings={DOCUMENT_SETTINGS}
          billingSettings={BILLING_SETTINGS}
          creditAccounts={CREDIT_ACCOUNTS}
        />
      );

      expect(screen.getByRole('tab', { name: 'Billing' })).toHaveAttribute('data-state', 'active');

      const billingForm = screen.getByTestId('billing-settings-form');
      expect(billingForm).toBeInTheDocument();
      expect(billingForm).toHaveTextContent(JSON.stringify(BILLING_SETTINGS));

      const accountsTable = screen.getByTestId('credit-accounts-table');
      expect(accountsTable).toBeInTheDocument();
      expect(accountsTable).toHaveAttribute('data-currency-label', BILLING_SETTINGS.currencyLabel);
      expect(accountsTable).toHaveTextContent(JSON.stringify(CREDIT_ACCOUNTS));

      expect(screen.queryByText(/couldn.?t load settings/i)).not.toBeInTheDocument();
    });

    it('renders the billing-specific fallback copy, without CreditAccountsTable, when billingSettings is null', async () => {
      await mockBillingTabActive();

      render(
        <ResparkableSettingsTabs
          documentSettings={DOCUMENT_SETTINGS}
          billingSettings={null}
          creditAccounts={null}
        />
      );

      expect(screen.queryByTestId('billing-settings-form')).not.toBeInTheDocument();
      expect(screen.queryByTestId('credit-accounts-table')).not.toBeInTheDocument();
      expect(
        screen.getByText(/1 credit per US dollar, no service charge, no new-user grant/)
      ).toBeInTheDocument();
    });

    /**
     * REGRESSION. The two fetches (billing policy, credit accounts) are
     * independent requests — one failing must not discard the other's
     * already-fetched, valid data. `CreditAccountsTable` used to be nested
     * inside the `billingSettings ?` branch, so a billing-settings-only
     * failure silently dropped a perfectly good accounts list.
     */
    it('still renders CreditAccountsTable (with the default currency label) when only billingSettings fails to load', async () => {
      await mockBillingTabActive();

      render(
        <ResparkableSettingsTabs
          documentSettings={DOCUMENT_SETTINGS}
          billingSettings={null}
          creditAccounts={CREDIT_ACCOUNTS}
        />
      );

      const accountsTable = screen.getByTestId('credit-accounts-table');
      expect(accountsTable).toBeInTheDocument();
      expect(accountsTable).toHaveTextContent(JSON.stringify(CREDIT_ACCOUNTS));
      // No `billingSettings.currencyLabel` to read — falls back to the same
      // default `resolveBillingSettings` would apply server-side.
      expect(accountsTable).toHaveAttribute('data-currency-label', 'credits');
    });

    /**
     * The other half of the same independence property: a genuinely failed
     * accounts fetch (`creditAccounts: null`) must not be conflated with "no
     * users yet" (`creditAccounts: []`), and must not be hidden just because
     * billingSettings loaded fine.
     */
    it('renders an accounts-specific fallback, distinct from the settings fallback, when only the accounts fetch fails', async () => {
      await mockBillingTabActive();

      render(
        <ResparkableSettingsTabs
          documentSettings={DOCUMENT_SETTINGS}
          billingSettings={BILLING_SETTINGS}
          creditAccounts={null}
        />
      );

      expect(screen.getByTestId('billing-settings-form')).toBeInTheDocument();
      expect(screen.queryByTestId('credit-accounts-table')).not.toBeInTheDocument();
      expect(screen.getByText(/couldn.?t load account balances/i)).toBeInTheDocument();
      // Distinct from the billing-settings fallback copy — not the same
      // boilerplate message doing double duty for two different failures.
      expect(
        screen.queryByText(/1 credit per US dollar, no service charge, no new-user grant/)
      ).not.toBeInTheDocument();
    });

    it('shows visually distinct fallback copy for the settings vs billing tabs', async () => {
      // Settings tab (default, no URL param): only the document-specific
      // fallback should be present anywhere in the document.
      const { rerender } = render(
        <ResparkableSettingsTabs
          documentSettings={null}
          billingSettings={null}
          creditAccounts={[]}
        />
      );

      expect(
        screen.getByText(/originals discarded after parsing, 25 MB upload ceiling/)
      ).toBeInTheDocument();
      expect(
        screen.queryByText(/1 credit per US dollar, no service charge, no new-user grant/)
      ).not.toBeInTheDocument();

      // Switch to the billing tab (via URL, per the convention above) and
      // re-render: now the billing-specific fallback shows, and it reads as
      // distinct copy from the settings one — not shared boilerplate.
      await mockBillingTabActive();
      rerender(
        <ResparkableSettingsTabs
          documentSettings={null}
          billingSettings={null}
          creditAccounts={[]}
        />
      );

      expect(
        screen.getByText(/1 credit per US dollar, no service charge, no new-user grant/)
      ).toBeInTheDocument();
      expect(
        screen.queryByText(/originals discarded after parsing, 25 MB upload ceiling/)
      ).not.toBeInTheDocument();
    });

    it('updates the URL via router.replace when the Billing tab trigger is clicked', async () => {
      // Exercises the `onValueChange` handler itself, rather than the
      // rendered-state branches the other tests here cover — `useUrlTabs`'s
      // `setActiveTab` calls `router.replace`, mocked to a no-op, which is why
      // the other tests pre-set `useSearchParams` instead of relying on a
      // click to flip the rendered tab (see the module comment above).
      const user = userEvent.setup();
      render(
        <ResparkableSettingsTabs
          documentSettings={DOCUMENT_SETTINGS}
          billingSettings={BILLING_SETTINGS}
          creditAccounts={CREDIT_ACCOUNTS}
        />
      );

      await user.click(screen.getByRole('tab', { name: 'Billing' }));

      expect(mockReplace).toHaveBeenCalledWith('/admin/resparkable/settings?tab=billing', {
        scroll: false,
      });
    });
  });
});
