/**
 * BillingSettingsForm Component Tests
 *
 * Mirrors `DocumentSettingsForm`'s save/dirty/error state machine
 * (see document-settings-form.test.tsx) against the billing settings shape.
 *
 * Test Coverage:
 * - Initial render shows the `initial` values in each field
 * - Save button dirty-tracking: disabled until something changes
 * - Invalid values (creditsPerUsd <= 0, non-numeric/out-of-range
 *   serviceChargePercent, empty/too-long currencyLabel) keep Save disabled
 *   even though the form is otherwise dirty
 * - A valid, dirty save PATCHes the billing settings endpoint with exactly
 *   the five fields, parses the response, and shows "Saved"
 * - A PATCH failure surfaces the error message and never shows "Saved"
 * - The "these are defaults" hint follows `isDefault` and is suppressed
 *   right after a save (`justSaved`)
 * - serviceChargePercent / currencyLabel boundary values
 *
 * @see components/resparkable/admin/billing-settings-form.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { BillingSettingsForm } from '@/components/resparkable/admin/billing-settings-form';
import type { ResparkableAdminBillingSettingsResponse } from '@/lib/framework/resparkable/validations';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('@/lib/api/client', () => ({
  apiClient: {
    patch: vi.fn(),
  },
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

const mockedPatch = apiClient.patch as ReturnType<typeof vi.fn>;

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeSettings(
  overrides: Partial<ResparkableAdminBillingSettingsResponse> = {}
): ResparkableAdminBillingSettingsResponse {
  return {
    creditsPerUsd: 1,
    serviceChargePercent: 10,
    costVisibleToUsersDefault: true,
    currencyLabel: 'credits',
    newUserGrantCredits: 100,
    isDefault: true,
    ...overrides,
  };
}

function getCreditsPerUsdInput(): HTMLInputElement {
  return document.getElementById('resparkable-credits-per-usd') as HTMLInputElement;
}

function getServiceChargeInput(): HTMLInputElement {
  return document.getElementById('resparkable-service-charge') as HTMLInputElement;
}

function getCurrencyLabelInput(): HTMLInputElement {
  return document.getElementById('resparkable-currency-label') as HTMLInputElement;
}

function getNewUserGrantInput(): HTMLInputElement {
  return document.getElementById('resparkable-new-user-grant') as HTMLInputElement;
}

function getCostVisibleSwitch(): HTMLElement {
  return screen.getByRole('switch', { name: /show cost to users/i });
}

function getSaveButton(): HTMLElement {
  return screen.getByRole('button', { name: /^save$/i });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('BillingSettingsForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── 1. Initial render ────────────────────────────────────────────────────

  describe('initial render', () => {
    it('shows the initial values in each field', () => {
      render(
        <BillingSettingsForm
          initial={makeSettings({
            creditsPerUsd: 2.5,
            serviceChargePercent: 15,
            costVisibleToUsersDefault: false,
            currencyLabel: 'sparks',
            newUserGrantCredits: 50,
          })}
        />
      );

      expect(getCreditsPerUsdInput()).toHaveValue(2.5);
      expect(getServiceChargeInput()).toHaveValue(15);
      expect(getCurrencyLabelInput()).toHaveValue('sparks');
      expect(getNewUserGrantInput()).toHaveValue(50);
      expect(getCostVisibleSwitch()).not.toBeChecked();
    });

    it('reflects a checked cost-visible switch when the default is true', () => {
      render(<BillingSettingsForm initial={makeSettings({ costVisibleToUsersDefault: true })} />);

      expect(getCostVisibleSwitch()).toBeChecked();
    });
  });

  // ── 2. Save button dirty tracking ────────────────────────────────────────

  describe('Save button dirty tracking', () => {
    it('is disabled when nothing has changed', () => {
      render(<BillingSettingsForm initial={makeSettings()} />);

      expect(getSaveButton()).toBeDisabled();
    });

    it('becomes enabled after a field is changed', () => {
      render(<BillingSettingsForm initial={makeSettings()} />);

      fireEvent.change(getCreditsPerUsdInput(), { target: { value: '3' } });

      expect(getSaveButton()).not.toBeDisabled();
    });

    it('becomes enabled after toggling the cost-visible switch', async () => {
      const user = userEvent.setup();
      render(<BillingSettingsForm initial={makeSettings()} />);

      await user.click(getCostVisibleSwitch());

      expect(getSaveButton()).not.toBeDisabled();
    });
  });

  // ── 3. Validation blocks Save even though the form is dirty ─────────────

  describe('validation gating', () => {
    it('keeps Save disabled when creditsPerUsd is set to 0', () => {
      render(<BillingSettingsForm initial={makeSettings()} />);

      fireEvent.change(getCreditsPerUsdInput(), { target: { value: '0' } });

      expect(getCreditsPerUsdInput()).toHaveAttribute('aria-invalid', 'true');
      expect(getSaveButton()).toBeDisabled();
    });

    it('keeps Save disabled when serviceChargePercent is non-numeric', () => {
      render(<BillingSettingsForm initial={makeSettings()} />);

      fireEvent.change(getServiceChargeInput(), { target: { value: 'abc' } });

      expect(getServiceChargeInput()).toHaveAttribute('aria-invalid', 'true');
      expect(getSaveButton()).toBeDisabled();
    });

    it('keeps Save disabled when currencyLabel is cleared to empty', () => {
      render(<BillingSettingsForm initial={makeSettings()} />);

      fireEvent.change(getCurrencyLabelInput(), { target: { value: '' } });

      expect(getCurrencyLabelInput()).toHaveAttribute('aria-invalid', 'true');
      expect(getSaveButton()).toBeDisabled();
    });

    it('keeps Save disabled when currencyLabel exceeds 32 characters', () => {
      render(<BillingSettingsForm initial={makeSettings()} />);

      // First prove the form CAN be dirty/enabled with a valid change...
      fireEvent.change(getCurrencyLabelInput(), { target: { value: 'valid label' } });
      expect(getSaveButton()).not.toBeDisabled();

      // ...then a too-long value must block it regardless.
      fireEvent.change(getCurrencyLabelInput(), { target: { value: 'a'.repeat(33) } });

      expect(getCurrencyLabelInput()).toHaveAttribute('aria-invalid', 'true');
      expect(getSaveButton()).toBeDisabled();
    });

    it('does not block Save when currencyLabel is exactly 32 characters', () => {
      render(<BillingSettingsForm initial={makeSettings()} />);

      fireEvent.change(getCurrencyLabelInput(), { target: { value: 'a'.repeat(32) } });

      expect(getCurrencyLabelInput()).toHaveAttribute('aria-invalid', 'false');
      expect(getSaveButton()).not.toBeDisabled();
    });

    it('accepts serviceChargePercent at the 0 boundary', () => {
      render(<BillingSettingsForm initial={makeSettings({ serviceChargePercent: 10 })} />);

      fireEvent.change(getServiceChargeInput(), { target: { value: '0' } });

      expect(getServiceChargeInput()).toHaveAttribute('aria-invalid', 'false');
      expect(getSaveButton()).not.toBeDisabled();
    });

    it('accepts serviceChargePercent at the 1000 boundary', () => {
      render(<BillingSettingsForm initial={makeSettings()} />);

      fireEvent.change(getServiceChargeInput(), { target: { value: '1000' } });

      expect(getServiceChargeInput()).toHaveAttribute('aria-invalid', 'false');
      expect(getSaveButton()).not.toBeDisabled();
    });

    it('rejects a negative serviceChargePercent', () => {
      render(<BillingSettingsForm initial={makeSettings()} />);

      fireEvent.change(getServiceChargeInput(), { target: { value: '-1' } });

      expect(getServiceChargeInput()).toHaveAttribute('aria-invalid', 'true');
      expect(getSaveButton()).toBeDisabled();
    });

    it('rejects a serviceChargePercent above 1000', () => {
      render(<BillingSettingsForm initial={makeSettings()} />);

      fireEvent.change(getServiceChargeInput(), { target: { value: '1001' } });

      expect(getServiceChargeInput()).toHaveAttribute('aria-invalid', 'true');
      expect(getSaveButton()).toBeDisabled();
    });
  });

  // ── 4. Save payload and success ──────────────────────────────────────────

  describe('save payload', () => {
    it('PATCHes the billing settings endpoint with exactly the five fields and shows Saved', async () => {
      mockedPatch.mockResolvedValueOnce({
        creditsPerUsd: 3,
        serviceChargePercent: 12,
        costVisibleToUsersDefault: false,
        currencyLabel: 'sparks',
        newUserGrantCredits: 25,
        isDefault: false,
      });

      const user = userEvent.setup();
      render(<BillingSettingsForm initial={makeSettings()} />);

      fireEvent.change(getCreditsPerUsdInput(), { target: { value: '3' } });
      fireEvent.change(getServiceChargeInput(), { target: { value: '12' } });
      fireEvent.change(getCurrencyLabelInput(), { target: { value: 'sparks' } });
      fireEvent.change(getNewUserGrantInput(), { target: { value: '25' } });
      await user.click(getCostVisibleSwitch());

      await user.click(getSaveButton());

      await waitFor(() => {
        expect(mockedPatch).toHaveBeenCalledTimes(1);
      });

      const [url, options] = mockedPatch.mock.calls[0] as [
        string,
        { body: Record<string, unknown> },
      ];
      expect(url).toBe('/api/v1/admin/resparkable/billing/settings');
      expect(options.body).toEqual({
        creditsPerUsd: 3,
        serviceChargePercent: 12,
        costVisibleToUsersDefault: false,
        currencyLabel: 'sparks',
        newUserGrantCredits: 25,
      });

      await waitFor(() => {
        expect(screen.getByText(/saved/i)).toBeInTheDocument();
      });
    });

    it('is disabled again after a successful save', async () => {
      mockedPatch.mockResolvedValueOnce({
        ...makeSettings(),
        creditsPerUsd: 5,
        isDefault: false,
      });

      const user = userEvent.setup();
      render(<BillingSettingsForm initial={makeSettings()} />);

      fireEvent.change(getCreditsPerUsdInput(), { target: { value: '5' } });
      expect(getSaveButton()).not.toBeDisabled();

      await user.click(getSaveButton());

      await waitFor(() => {
        expect(getSaveButton()).toBeDisabled();
      });
    });
  });

  // ── 5. Save failure ──────────────────────────────────────────────────────

  describe('save failure', () => {
    it('surfaces the API error message and does not show Saved', async () => {
      mockedPatch.mockRejectedValueOnce(
        new APIClientError('Billing settings rejected the update', 'VALIDATION_ERROR', 400)
      );

      const user = userEvent.setup();
      render(<BillingSettingsForm initial={makeSettings()} />);

      fireEvent.change(getCreditsPerUsdInput(), { target: { value: '4' } });
      await user.click(getSaveButton());

      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent('Billing settings rejected the update');
      });

      expect(screen.queryByText(/^saved$/i)).not.toBeInTheDocument();
      // The failed edit must not be discarded: value stays as typed and the
      // form remains dirty (Save still enabled) so nothing is silently lost.
      expect(getCreditsPerUsdInput()).toHaveValue(4);
      expect(getSaveButton()).not.toBeDisabled();
    });

    it('renders a generic message when a non-API error is thrown', async () => {
      mockedPatch.mockRejectedValueOnce(new Error('network down'));

      const user = userEvent.setup();
      render(<BillingSettingsForm initial={makeSettings()} />);

      fireEvent.change(getCreditsPerUsdInput(), { target: { value: '4' } });
      await user.click(getSaveButton());

      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent('network down');
      });
    });
  });

  // ── 6. isDefault hint ─────────────────────────────────────────────────────

  describe('defaults hint', () => {
    it('renders the "nothing saved yet" hint when isDefault is true', () => {
      render(<BillingSettingsForm initial={makeSettings({ isDefault: true })} />);

      expect(screen.getByText(/nothing has been saved yet/i)).toBeInTheDocument();
    });

    it('does not render the hint when isDefault is false', () => {
      render(<BillingSettingsForm initial={makeSettings({ isDefault: false })} />);

      expect(screen.queryByText(/nothing has been saved yet/i)).not.toBeInTheDocument();
    });

    it('suppresses the hint immediately after a save even if the response reports isDefault', async () => {
      // The response parser sets `saved` from the API response; simulate a
      // (contrived) response that still reports isDefault: true to prove the
      // suppression is driven by `justSaved`, not just `saved.isDefault`.
      mockedPatch.mockResolvedValueOnce({
        ...makeSettings(),
        creditsPerUsd: 7,
        isDefault: true,
      });

      const user = userEvent.setup();
      render(<BillingSettingsForm initial={makeSettings({ isDefault: true })} />);

      expect(screen.getByText(/nothing has been saved yet/i)).toBeInTheDocument();

      fireEvent.change(getCreditsPerUsdInput(), { target: { value: '7' } });
      await user.click(getSaveButton());

      await waitFor(() => {
        expect(screen.getByText(/saved/i)).toBeInTheDocument();
      });
      expect(screen.queryByText(/nothing has been saved yet/i)).not.toBeInTheDocument();
    });
  });
});
