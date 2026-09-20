// @vitest-environment happy-dom

/**
 * Unit Tests: ConnectAssistantCard
 *
 * Covers the five states the docblock on the component names, in the order a
 * person meets them: loading, server off, no key, a key exists, a key was just
 * minted. `apiClient` is the only seam mocked — `useSaveStatus` and
 * `useCopyToClipboard` run for real, because the save/error text and the
 * clipboard wiring are exactly what a person watching this card sees.
 *
 * Two rules get their own tests rather than a passing mention: every live key
 * renders, not just the first (a database can hold two even though minting
 * only ever offers one), and Revoke is a two-step inline confirm, not a single
 * click. Both are called out in the component's own comments as deliberate,
 * and both are the kind of thing a careless rewrite silently breaks.
 *
 * @see components/resparkable/settings/connect-assistant-card.tsx
 * @see lib/framework/resparkable/mcp/client-snippets.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ConnectAssistantCard } from '@/components/resparkable/settings/connect-assistant-card';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import {
  MCP_CLIENT_SNIPPETS,
  RESPARKABLE_MCP_PATH,
} from '@/lib/framework/resparkable/mcp/client-snippets';

// ─── Mocks ────────────────────────────────────────────────────────────────────

// Hand-rolled rather than `importOriginal`, matching this repo's convention
// (see about-sparkey.test.tsx, contact-form.test.tsx): the component checks
// `error instanceof APIClientError`, and this class is the one both sides see
// since it comes from the same mocked module.
vi.mock('@/lib/api/client', () => ({
  apiClient: {
    get: vi.fn(),
    post: vi.fn(),
    delete: vi.fn(),
  },
  APIClientError: class APIClientError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'APIClientError';
    }
  },
}));

import { apiClient, APIClientError } from '@/lib/api/client';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const SPACE_ID = 'spc_1';
const SPACE_NAME = 'Study Group B';

interface ConnectionKey {
  id: string;
  keyPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
}

function makeKey(overrides: Partial<ConnectionKey> = {}): ConnectionKey {
  return {
    id: 'key_1',
    keyPrefix: 'rsk_abc',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastUsedAt: null,
    ...overrides,
  };
}

function mintedFrom(key: ConnectionKey, plaintext: string) {
  return { ...key, plaintext };
}

/** A promise that never settles, for pinning the loading state. */
function pending<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

beforeEach(() => {
  vi.clearAllMocks();
  // happy-dom exposes a real clipboard behind a non-writable getter, so spy on
  // the prototype's writeText rather than reassigning navigator.clipboard.
  vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
});

// ─── Loading ──────────────────────────────────────────────────────────────────

describe('loading state', () => {
  it('shows a checking message before the GET resolves', () => {
    vi.mocked(apiClient.get).mockReturnValue(pending());

    render(<ConnectAssistantCard spaceId={SPACE_ID} spaceName={SPACE_NAME} />);

    expect(screen.getByText('Checking this workspace…')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Generate a key' })).not.toBeInTheDocument();
  });
});

// ─── Server off ───────────────────────────────────────────────────────────────

describe('server off', () => {
  it('renders the server-off notice and offers no Generate button', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ serverEnabled: false, keys: [] });

    render(<ConnectAssistantCard spaceId={SPACE_ID} spaceName={SPACE_NAME} />);

    expect(
      await screen.findByText('Assistants cannot connect to this install yet.')
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Generate a key' })).not.toBeInTheDocument();
  });

  it('still shows an existing key, so it can be revoked while the server is off', async () => {
    // The notice used to replace the whole body. A key you cannot see is a key
    // you cannot revoke, and revoking does not depend on the server being on:
    // somebody who learns their key has leaked, on a day an admin happens to
    // have the server switched off, would have been shown an explanation and no
    // way to act. The key is inert meanwhile, but it returns with the switch.
    vi.mocked(apiClient.get).mockResolvedValue({
      serverEnabled: false,
      keys: [makeKey({ id: 'key_1', keyPrefix: 'rsk_abc' })],
    });

    render(<ConnectAssistantCard spaceId={SPACE_ID} spaceName={SPACE_NAME} />);

    expect(
      await screen.findByText('Assistants cannot connect to this install yet.')
    ).toBeInTheDocument();
    expect(screen.getByText('rsk_abc…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Revoke' })).toBeInTheDocument();
  });
});

// ─── No key ───────────────────────────────────────────────────────────────────

describe('no key yet', () => {
  it('offers a Generate button once the server is on and no key exists', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ serverEnabled: true, keys: [] });

    render(<ConnectAssistantCard spaceId={SPACE_ID} spaceName={SPACE_NAME} />);

    expect(await screen.findByText('No assistant is connected yet.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Generate a key' })).toBeInTheDocument();
  });
});

// ─── Has key(s) ───────────────────────────────────────────────────────────────

describe('a key exists', () => {
  it('renders a row for the key, with Regenerate and Revoke controls', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({
      serverEnabled: true,
      keys: [makeKey({ id: 'key_1', keyPrefix: 'rsk_abc' })],
    });

    render(<ConnectAssistantCard spaceId={SPACE_ID} spaceName={SPACE_NAME} />);

    expect(await screen.findByText('rsk_abc…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Regenerate' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Revoke' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Generate a key' })).not.toBeInTheDocument();
  });

  it('renders every live key, not just the first', async () => {
    // Deliberate per the component's own comment: one key per workspace is a
    // rule the mint flow applies, not a database constraint, so a second row
    // can exist and hiding it would hide a working credential.
    vi.mocked(apiClient.get).mockResolvedValue({
      serverEnabled: true,
      keys: [
        makeKey({ id: 'key_1', keyPrefix: 'rsk_aaa' }),
        makeKey({ id: 'key_2', keyPrefix: 'rsk_bbb' }),
      ],
    });

    render(<ConnectAssistantCard spaceId={SPACE_ID} spaceName={SPACE_NAME} />);

    expect(await screen.findByText('rsk_aaa…')).toBeInTheDocument();
    expect(screen.getByText('rsk_bbb…')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Regenerate' })).toHaveLength(2);
  });

  it('shows a last-used date for a key that has been used, not the "not used yet" default', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({
      serverEnabled: true,
      keys: [makeKey({ lastUsedAt: '2026-03-14T00:00:00.000Z' })],
    });

    render(<ConnectAssistantCard spaceId={SPACE_ID} spaceName={SPACE_NAME} />);

    expect(await screen.findByText(/^Last used /)).toBeInTheDocument();
    expect(screen.queryByText('Not used yet')).not.toBeInTheDocument();
  });
});

// ─── Generate ─────────────────────────────────────────────────────────────────

describe('generating a key', () => {
  it('POSTs to the space key path and shows the plaintext exactly once', async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.get).mockResolvedValue({ serverEnabled: true, keys: [] });
    const minted = mintedFrom(makeKey(), 'rsk_plaintext_secret_001');
    vi.mocked(apiClient.post).mockResolvedValue(minted);

    render(<ConnectAssistantCard spaceId={SPACE_ID} spaceName={SPACE_NAME} />);
    await user.click(await screen.findByRole('button', { name: 'Generate a key' }));

    // getByDisplayValue throws on more than one match, so this doubles as the
    // "exactly once" assertion the plan calls for.
    const field = await screen.findByLabelText('Your new key');
    expect(field).toHaveDisplayValue('rsk_plaintext_secret_001');
    expect(apiClient.post).toHaveBeenCalledWith(RESPARKABLE_API.spaceMcpKeys(SPACE_ID));
    expect(screen.getByText('Copy this key now. It is not shown again.')).toBeInTheDocument();
  });

  it('wires the copy button to the clipboard for the minted key', async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.get).mockResolvedValue({ serverEnabled: true, keys: [] });
    const minted = mintedFrom(makeKey(), 'rsk_plaintext_secret_002');
    vi.mocked(apiClient.post).mockResolvedValue(minted);

    render(<ConnectAssistantCard spaceId={SPACE_ID} spaceName={SPACE_NAME} />);
    await user.click(await screen.findByRole('button', { name: 'Generate a key' }));
    await screen.findByLabelText('Your new key');

    await user.click(screen.getByRole('button', { name: 'Copy key' }));

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('rsk_plaintext_secret_002');
  });

  it('wires the per-snippet copy button to the clipboard with that snippet body, not the bare key', async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.get).mockResolvedValue({ serverEnabled: true, keys: [] });
    const plaintext = 'rsk_plaintext_secret_003';
    vi.mocked(apiClient.post).mockResolvedValue(mintedFrom(makeKey(), plaintext));

    render(<ConnectAssistantCard spaceId={SPACE_ID} spaceName={SPACE_NAME} />);
    await user.click(await screen.findByRole('button', { name: 'Generate a key' }));
    await screen.findByLabelText('Your new key');

    // Default-selected tab is the first entry (Claude Code), which has both a
    // command button and a configuration button.
    await user.click(screen.getByRole('button', { name: 'Copy the configuration' }));

    const url = `${window.location.origin}${RESPARKABLE_MCP_PATH}`;
    const expectedBody = MCP_CLIENT_SNIPPETS[0].config({ url, key: plaintext });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expectedBody);
  });

  it('falls back to a generic message when the create request fails with a non-API error', async () => {
    // message() only reads .message off an APIClientError; anything else — a
    // network hiccup fetch() itself throws, say — must not leak an internal
    // error string to the person looking at this card.
    const user = userEvent.setup();
    vi.mocked(apiClient.get).mockResolvedValue({ serverEnabled: true, keys: [] });
    vi.mocked(apiClient.post).mockRejectedValue(new Error('ECONNRESET'));

    render(<ConnectAssistantCard spaceId={SPACE_ID} spaceName={SPACE_NAME} />);
    await user.click(await screen.findByRole('button', { name: 'Generate a key' }));

    expect(await screen.findByText('Could not create a key.')).toBeInTheDocument();
    expect(screen.queryByText('ECONNRESET')).not.toBeInTheDocument();
  });
});

// ─── Regenerate ───────────────────────────────────────────────────────────────

describe('regenerating a key', () => {
  it('POSTs to the rotate path for the clicked key id', async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.get).mockResolvedValue({
      serverEnabled: true,
      keys: [makeKey({ id: 'key_9', keyPrefix: 'rsk_old' })],
    });
    const minted = mintedFrom(makeKey({ id: 'key_9' }), 'rsk_rotated_plaintext');
    vi.mocked(apiClient.post).mockResolvedValue(minted);

    render(<ConnectAssistantCard spaceId={SPACE_ID} spaceName={SPACE_NAME} />);
    await user.click(await screen.findByRole('button', { name: 'Regenerate' }));

    expect(await screen.findByLabelText('Your new key')).toHaveDisplayValue(
      'rsk_rotated_plaintext'
    );
    expect(apiClient.post).toHaveBeenCalledWith(
      RESPARKABLE_API.spaceMcpKeyRotate(SPACE_ID, 'key_9')
    );
  });

  it('keeps the shown key when a regenerate fails, because that key still works', async () => {
    // The card used to clear the panel on any failure, and that was wrong in
    // the one case it mattered. A rotate that failed wrote nothing, so the
    // plaintext on screen is still the working credential, and it is the only
    // copy in existence. Clearing it in response to a network blip destroys a
    // live secret that nothing can show again.
    const user = userEvent.setup();
    vi.mocked(apiClient.get).mockResolvedValue({
      serverEnabled: true,
      keys: [makeKey({ id: 'key_9' })],
    });
    vi.mocked(apiClient.post)
      .mockResolvedValueOnce(mintedFrom(makeKey({ id: 'key_9' }), 'rsk_first_mint'))
      .mockRejectedValueOnce(new APIClientError('rotate exploded'));

    render(<ConnectAssistantCard spaceId={SPACE_ID} spaceName={SPACE_NAME} />);
    await user.click(await screen.findByRole('button', { name: 'Regenerate' }));
    await screen.findByDisplayValue('rsk_first_mint');

    await user.click(screen.getByRole('button', { name: 'Regenerate' }));

    // The failure is reported, and the still-valid key is still copyable.
    expect(await screen.findByText('rotate exploded')).toBeInTheDocument();
    expect(screen.getByDisplayValue('rsk_first_mint')).toBeInTheDocument();
  });
});

// ─── Revoke (two-step confirm) ────────────────────────────────────────────────

describe('revoking a key', () => {
  it('does not call the API on the first Revoke click, only after Confirm', async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.get)
      .mockResolvedValueOnce({ serverEnabled: true, keys: [makeKey({ id: 'key_1' })] })
      .mockResolvedValue({ serverEnabled: true, keys: [] });

    render(<ConnectAssistantCard spaceId={SPACE_ID} spaceName={SPACE_NAME} />);
    await user.click(await screen.findByRole('button', { name: 'Revoke' }));

    // The question replaces the row's controls in place, not a browser dialog.
    expect(await screen.findByText('Revoke this key?')).toBeInTheDocument();
    expect(apiClient.delete).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Revoke' }));

    expect(apiClient.delete).toHaveBeenCalledWith(RESPARKABLE_API.spaceMcpKey(SPACE_ID, 'key_1'));
    expect(await screen.findByText('No assistant is connected yet.')).toBeInTheDocument();
  });

  it('returns to the idle row without calling the API when Cancel is clicked', async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.get).mockResolvedValue({
      serverEnabled: true,
      keys: [makeKey({ id: 'key_1', keyPrefix: 'rsk_abc' })],
    });

    render(<ConnectAssistantCard spaceId={SPACE_ID} spaceName={SPACE_NAME} />);
    await user.click(await screen.findByRole('button', { name: 'Revoke' }));
    await screen.findByText('Revoke this key?');

    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByText('Revoke this key?')).not.toBeInTheDocument();
    expect(screen.getByText('rsk_abc…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Regenerate' })).toBeInTheDocument();
    expect(apiClient.delete).not.toHaveBeenCalled();
  });

  it('falls back to a generic message when the delete request fails with a non-API error', async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.get).mockResolvedValue({
      serverEnabled: true,
      keys: [makeKey({ id: 'key_1' })],
    });
    vi.mocked(apiClient.delete).mockRejectedValue(new Error('ECONNRESET'));

    render(<ConnectAssistantCard spaceId={SPACE_ID} spaceName={SPACE_NAME} />);
    await user.click(await screen.findByRole('button', { name: 'Revoke' }));
    await screen.findByText('Revoke this key?');
    await user.click(screen.getByRole('button', { name: 'Revoke' }));

    expect(await screen.findByText('Could not revoke this key.')).toBeInTheDocument();
    expect(screen.queryByText('ECONNRESET')).not.toBeInTheDocument();
    // A throw from apiClient.delete short-circuits before `setConfirmingRevoke(null)`
    // runs, so the confirm question is still the honest state of the row: the
    // key was NOT revoked, and a second Confirm click can retry.
    expect(screen.getByText('Revoke this key?')).toBeInTheDocument();
  });
});

// ─── Errors ───────────────────────────────────────────────────────────────────

describe('a failed GET', () => {
  it('renders the error as an alert and offers no Generate button', async () => {
    vi.mocked(apiClient.get).mockRejectedValue(new APIClientError('workspace lookup exploded'));

    render(<ConnectAssistantCard spaceId={SPACE_ID} spaceName={SPACE_NAME} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('workspace lookup exploded');
    expect(screen.queryByRole('button', { name: 'Generate a key' })).not.toBeInTheDocument();
    expect(screen.queryByText('Checking this workspace…')).not.toBeInTheDocument();
  });
});

// ─── Snippet tabs ─────────────────────────────────────────────────────────────

describe('snippet tabs on a minted key', () => {
  it('renders one tab per MCP_CLIENT_SNIPPETS entry, each showing that clients own config with the plaintext key', async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.get).mockResolvedValue({ serverEnabled: true, keys: [] });
    const plaintext = 'rsk_snippet_plaintext';
    vi.mocked(apiClient.post).mockResolvedValue(mintedFrom(makeKey(), plaintext));

    render(<ConnectAssistantCard spaceId={SPACE_ID} spaceName={SPACE_NAME} />);
    await user.click(await screen.findByRole('button', { name: 'Generate a key' }));
    await screen.findByLabelText('Your new key');

    expect(screen.getAllByRole('tab')).toHaveLength(MCP_CLIENT_SNIPPETS.length);

    const url = `${window.location.origin}${RESPARKABLE_MCP_PATH}`;
    for (const client of MCP_CLIENT_SNIPPETS) {
      const tab = screen.getByRole('tab', { name: client.label });
      await user.click(tab);

      const panel = screen.getByRole('tabpanel');
      const expectedConfig = client.config({ url, key: plaintext });
      // Both sides collapsed to single spaces: `<pre>` preserves the JSON
      // pretty-printer's newlines and indentation verbatim, which `textContent`
      // reports raw. Asserted against the client's own builder, not a
      // hardcoded string, so this fails the moment a snippet's shape drifts
      // from what is on screen.
      const normalizedPanelText = (panel.textContent ?? '').replace(/\s+/g, ' ').trim();
      expect(normalizedPanelText).toContain(expectedConfig.replace(/\s+/g, ' ').trim());
    }
  });
});

// ─── Workspace naming ─────────────────────────────────────────────────────────

describe('workspace naming', () => {
  it('names the workspace in its description', () => {
    vi.mocked(apiClient.get).mockReturnValue(pending());

    render(<ConnectAssistantCard spaceId={SPACE_ID} spaceName={SPACE_NAME} />);

    expect(screen.getByText(SPACE_NAME)).toBeInTheDocument();
  });
});
