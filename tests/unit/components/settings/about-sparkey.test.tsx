// @vitest-environment happy-dom

/**
 * AboutSparkey Component Tests
 *
 * Covers the introduction card that opens Settings and the pronoun
 * selector that drives it: renders with the current preference, saves a
 * change via the preferences API, and rolls back on failure.
 *
 * @see components/settings/about-sparkey.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AboutSparkey } from '@/components/settings/about-sparkey';

const mockRefresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({ refresh: mockRefresh })),
}));

const mockTrack = vi.fn();
vi.mock('@/lib/analytics', () => ({
  useAnalytics: vi.fn(() => ({ track: mockTrack })),
  EVENTS: { SPARKEY_PRONOUN_UPDATED: 'sparkey_pronoun_updated' },
}));

const mockPatch = vi.fn();
vi.mock('@/lib/api/client', () => ({
  apiClient: { patch: (...args: unknown[]) => mockPatch(...args) },
  APIClientError: class APIClientError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'APIClientError';
    }
  },
}));

describe('components/settings/about-sparkey', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('explains that Sparkey is a tool, not a person', () => {
    render(<AboutSparkey pronoun="it" />);

    expect(screen.getByText(/About Sparkey/i)).toBeInTheDocument();
    expect(screen.getByText(/Sparkey is a machine, not a human being/i)).toBeInTheDocument();
  });

  it('shows the current pronoun preference', () => {
    render(<AboutSparkey pronoun="she" />);

    expect(screen.getByRole('combobox')).toHaveTextContent('She');
  });

  it('saves a pronoun change and shows success', async () => {
    const user = userEvent.setup();
    mockPatch.mockResolvedValue({ sparkey: { pronoun: 'he' } });

    render(<AboutSparkey pronoun="it" />);

    await user.click(screen.getByRole('combobox'));
    await user.click(screen.getByRole('option', { name: 'He' }));

    expect(mockPatch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ body: { sparkey: { pronoun: 'he' } } })
    );

    await waitFor(() => {
      expect(screen.getByText('Saved')).toBeInTheDocument();
    });
    expect(mockTrack).toHaveBeenCalledWith('sparkey_pronoun_updated', { pronoun: 'he' });
    expect(mockRefresh).toHaveBeenCalled();
  });

  it('rolls back to the previous pronoun when the save fails', async () => {
    const user = userEvent.setup();
    mockPatch.mockRejectedValue(new Error('network down'));

    render(<AboutSparkey pronoun="it" />);

    await user.click(screen.getByRole('combobox'));
    await user.click(screen.getByRole('option', { name: 'He' }));

    await waitFor(() => {
      expect(screen.getByText(/failed to update preference/i)).toBeInTheDocument();
    });
    expect(screen.getByRole('combobox')).toHaveTextContent('It');
  });
});
