// @vitest-environment happy-dom

/**
 * Unit Tests: EntitiesTab.
 *
 * `useTabFetch` itself is covered by `use-tab-fetch.test.ts` — these tests
 * mock only its underlying `apiClient.get` call so the hook's real
 * loading/error/ready transitions run, and assert what this adapter's own
 * code does with each state: which endpoint it fetches, which copy it
 * shows for loading/error, and that the fetched entities reach
 * `EntitiesView` unmodified. `EntitiesView` itself is mocked to a marker so
 * this file stays about the adapter, not that view's own rendering.
 *
 * @see components/resparkable/workspace/tabs/entities-tab.tsx
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { EntitiesTab } from '@/components/resparkable/workspace/tabs/entities-tab';
import { apiClient, APIClientError } from '@/lib/api/client';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import type { EntityWire } from '@/lib/framework/resparkable/ui/payloads';

vi.mock('@/lib/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/client')>('@/lib/api/client');
  return { ...actual, apiClient: { ...actual.apiClient, get: vi.fn() } };
});

vi.mock('@/components/resparkable/entities/entities-view', () => ({
  EntitiesView: ({ entities }: { entities: EntityWire[] }) => (
    <div data-testid="entities-view">{JSON.stringify(entities)}</div>
  ),
}));

function makeEntity(overrides: Partial<EntityWire> = {}): EntityWire {
  return {
    id: 'ent_1',
    name: 'Acme Corp',
    slug: 'acme-corp',
    kind: 'company',
    description: null,
    website: null,
    status: 'active',
    lastActivityAt: null,
    snoozedUntil: null,
    archivedAt: null,
    archivedReason: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(apiClient.get).mockReset();
});

describe('EntitiesTab', () => {
  it('fetches the entities collection with a 200 limit', () => {
    vi.mocked(apiClient.get).mockReturnValue(new Promise(() => {}));

    render(<EntitiesTab />);

    expect(apiClient.get).toHaveBeenCalledWith(`${RESPARKABLE_API.ENTITIES}?limit=200`);
  });

  it('shows a loading skeleton before the fetch resolves', () => {
    vi.mocked(apiClient.get).mockReturnValue(new Promise(() => {}));

    render(<EntitiesTab />);

    expect(screen.getByText('Loading people and companies')).toBeInTheDocument();
    expect(screen.queryByTestId('entities-view')).not.toBeInTheDocument();
  });

  it('shows a load error naming people and companies, and wires retry back to the fetch', async () => {
    vi.mocked(apiClient.get).mockRejectedValue(new APIClientError('Server is down.', 'ERR', 500));
    const user = userEvent.setup();

    render(<EntitiesTab />);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Couldn’t load your people and companies.'
    );
    expect(screen.getByText('Server is down.')).toBeInTheDocument();

    vi.mocked(apiClient.get).mockResolvedValueOnce([makeEntity()]);
    await user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByTestId('entities-view')).toBeInTheDocument();
    expect(apiClient.get).toHaveBeenCalledTimes(2);
  });

  it('passes the fetched entities straight through to EntitiesView once ready', async () => {
    const entities = [
      makeEntity({ id: 'ent_1', name: 'Acme Corp' }),
      makeEntity({ id: 'ent_2', name: 'Jane Doe', kind: 'person' }),
    ];
    vi.mocked(apiClient.get).mockResolvedValue(entities);

    render(<EntitiesTab />);

    const view = await screen.findByTestId('entities-view');
    expect(JSON.parse(view.textContent ?? '[]')).toEqual(entities);
  });

  it('renders a load error when the response fails schema validation', async () => {
    vi.mocked(apiClient.get).mockResolvedValue([{ nope: true }]);

    render(<EntitiesTab />);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Couldn’t load your people and companies.'
    );
    expect(screen.getByText('That response wasn’t what we expected.')).toBeInTheDocument();
  });
});
