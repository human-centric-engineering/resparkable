/**
 * Unit Tests: EntityTab.
 *
 * Mocks only `apiClient.get` (the boundary `useTabFetch` calls, itself
 * covered by `use-tab-fetch.test.ts`) so the hook's real state machine
 * runs. What's specific to this adapter, and worth pinning here: the
 * `viewPath` endpoint it builds from `id`, the inline 404 branch (this
 * adapter's one piece of real conditional logic — a 404 renders an
 * `EmptyState`, not `TabLoadError`, and every other error status still
 * goes through `TabLoadError`), and that the fetched view reaches
 * `EntityDetail` unmodified.
 *
 * @see components/resparkable/workspace/tabs/entity-tab.tsx
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

import { EntityTab } from '@/components/resparkable/workspace/tabs/entity-tab';
import { apiClient, APIClientError } from '@/lib/api/client';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import type { EntityViewWire } from '@/lib/framework/resparkable/ui/payloads';

vi.mock('@/lib/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/client')>('@/lib/api/client');
  return { ...actual, apiClient: { ...actual.apiClient, get: vi.fn() } };
});

vi.mock('@/components/resparkable/entities/entity-detail', () => ({
  EntityDetail: ({ view }: { view: EntityViewWire }) => (
    <div data-testid="entity-detail">{JSON.stringify(view)}</div>
  ),
}));

function makeView(overrides: Partial<EntityViewWire> = {}): EntityViewWire {
  return {
    entity: {
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
    },
    related: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(apiClient.get).mockReset();
});

describe('EntityTab', () => {
  it('fetches the entity view endpoint built from the given id', () => {
    vi.mocked(apiClient.get).mockReturnValue(new Promise(() => {}));

    render(<EntityTab id="ent_42" />);

    expect(apiClient.get).toHaveBeenCalledWith(
      RESPARKABLE_API.viewPath(RESPARKABLE_API.ENTITIES, 'ent_42')
    );
  });

  it('shows a loading skeleton before the fetch resolves', () => {
    vi.mocked(apiClient.get).mockReturnValue(new Promise(() => {}));

    render(<EntityTab id="ent_1" />);

    expect(screen.getByText('Loading')).toBeInTheDocument();
  });

  it('renders an inline not-found state for a 404, not the generic load error', async () => {
    vi.mocked(apiClient.get).mockRejectedValue(new APIClientError('Not found.', 'NOT_FOUND', 404));

    render(<EntityTab id="ent_1" />);

    expect(await screen.findByText('Not found')).toBeInTheDocument();
    expect(
      screen.getByText('This person or company may have been deleted, or the link is out of date.')
    ).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('renders the generic load error for a non-404 failure', async () => {
    vi.mocked(apiClient.get).mockRejectedValue(new APIClientError('Server is down.', 'ERR', 500));

    render(<EntityTab id="ent_1" />);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Couldn’t load this person or company.'
    );
    expect(screen.getByText('Server is down.')).toBeInTheDocument();
    expect(screen.queryByText('Not found')).not.toBeInTheDocument();
  });

  it('passes the fetched view straight through to EntityDetail once ready', async () => {
    const view = makeView();
    vi.mocked(apiClient.get).mockResolvedValue(view);

    render(<EntityTab id="ent_1" />);

    const detail = await screen.findByTestId('entity-detail');
    expect(JSON.parse(detail.textContent ?? '{}')).toEqual(view);
  });
});
