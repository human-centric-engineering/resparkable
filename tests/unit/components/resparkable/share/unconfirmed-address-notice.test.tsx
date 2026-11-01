// @vitest-environment happy-dom

/**
 * Unit Tests: `UnconfirmedAddressNotice`. Why "Shared with me" may be short
 * (phase 66).
 *
 * The account is read from `GET /api/v1/users/me`, not the session, so a
 * confirmation made on another device shows at once. The notice appears only
 * when that read says the address is unconfirmed, and says nothing when the
 * read fails or comes back in a shape it does not recognise.
 *
 * @see components/resparkable/share/unconfirmed-address-notice.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

import { UnconfirmedAddressNotice } from '@/components/resparkable/share/unconfirmed-address-notice';
import { apiClient } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';

vi.mock('@/lib/api/client', () => ({
  apiClient: { get: vi.fn() },
}));

beforeEach(() => {
  vi.mocked(apiClient.get).mockReset();
});

describe('UnconfirmedAddressNotice', () => {
  it('reads the account, not the session', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ emailVerified: true });

    render(<UnconfirmedAddressNotice />);

    await waitFor(() => expect(apiClient.get).toHaveBeenCalledWith(API.USERS.ME));
  });

  it('asks an unconfirmed account to confirm, linking to where the email is sent', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ emailVerified: false });

    render(<UnconfirmedAddressNotice />);

    expect(
      await screen.findByText(
        'Things shared with your email address appear here once you confirm it.'
      )
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Confirm my address' })).toHaveAttribute(
      'href',
      '/dashboard'
    );
  });

  it('says nothing to a confirmed account', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ emailVerified: true });

    const { container } = render(<UnconfirmedAddressNotice />);

    await waitFor(() => expect(apiClient.get).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('says nothing when the read fails', async () => {
    vi.mocked(apiClient.get).mockRejectedValue(new Error('offline'));

    const { container } = render(<UnconfirmedAddressNotice />);

    await waitFor(() => expect(apiClient.get).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('says nothing when the response is not the shape it expects', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ emailVerified: 'no' });

    const { container } = render(<UnconfirmedAddressNotice />);

    await waitFor(() => expect(apiClient.get).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});
