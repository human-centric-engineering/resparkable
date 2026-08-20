/**
 * Unit Tests: SearchTab.
 *
 * The own logic worth pinning down: an empty/whitespace-only `query` never
 * fetches at all and shows the "search your material" prompt instead
 * (`useTabFetch`'s `endpoint: null` contract — see that hook's own test file
 * for the loading/error/ready transitions this reuses once a real query is
 * present). `includeArchived` is hard-coded `false` here — this tab's own
 * header comment explains why (`SearchResults`' own checkbox for it is left
 * unmodified, the params registry has no field for it).
 *
 * `SearchControls`/`SearchResults` are mocked to markers so this file stays
 * about SearchTab's own state wiring, not either component's own rendering.
 *
 * @see components/resparkable/workspace/tabs/search-tab.tsx
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

import { SearchTab } from '@/components/resparkable/workspace/tabs/search-tab';
import { apiClient, APIClientError } from '@/lib/api/client';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import type { SearchHitWire } from '@/lib/framework/resparkable/ui/payloads';

vi.mock('@/lib/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/client')>('@/lib/api/client');
  return { ...actual, apiClient: { ...actual.apiClient, get: vi.fn() } };
});

vi.mock('@/components/resparkable/search/search-controls', () => ({
  SearchControls: ({ query }: { query: string }) => (
    <div data-testid="search-controls">{query}</div>
  ),
}));

vi.mock('@/components/resparkable/search/search-results', () => ({
  SearchResults: ({
    query,
    hits,
    includeArchived,
  }: {
    query: string;
    hits: SearchHitWire[];
    includeArchived: boolean;
  }) => <div data-testid="search-results">{JSON.stringify({ query, hits, includeArchived })}</div>,
}));

const hit: SearchHitWire = {
  id: 'proj_1',
  entityType: 'project',
  title: 'Kitchen remodel',
  subtitle: null,
  archivedAt: null,
  updatedAt: '2026-01-01T00:00:00.000Z',
  score: 0.9,
  matchedBy: 'semantic',
  snippet: null,
};

beforeEach(() => {
  vi.mocked(apiClient.get).mockReset();
});

describe('SearchTab', () => {
  it('shows the empty-search prompt and never fetches when no query is given', () => {
    render(<SearchTab />);

    expect(screen.getByText('Search your material')).toBeInTheDocument();
    expect(apiClient.get).not.toHaveBeenCalled();
  });

  it('treats a whitespace-only query the same as no query', () => {
    render(<SearchTab query="   " />);

    expect(screen.getByText('Search your material')).toBeInTheDocument();
    expect(apiClient.get).not.toHaveBeenCalled();
  });

  it('fetches the trimmed query against the SEARCH endpoint', () => {
    vi.mocked(apiClient.get).mockReturnValue(new Promise(() => {}));

    render(<SearchTab query="  roadmap  " />);

    expect(apiClient.get).toHaveBeenCalledWith(`${RESPARKABLE_API.SEARCH}?q=roadmap`);
    expect(screen.getByTestId('search-controls')).toHaveTextContent('roadmap');
    expect(screen.getByText('Searching')).toBeInTheDocument();
  });

  it('renders TabLoadError with the "your search" label when the fetch fails, alongside the controls', async () => {
    vi.mocked(apiClient.get).mockRejectedValue(new APIClientError('Server unwell.', 'ERR', 500));

    render(<SearchTab query="roadmap" />);

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByText(/Couldn.t load your search/)).toBeInTheDocument();
    expect(screen.getByTestId('search-controls')).toBeInTheDocument();
  });

  it('renders SearchResults with the parsed hits and includeArchived hard-coded false', async () => {
    vi.mocked(apiClient.get).mockResolvedValue([hit]);

    render(<SearchTab query="roadmap" />);

    await waitFor(() => expect(screen.getByTestId('search-results')).toBeInTheDocument());
    const content = screen.getByTestId('search-results');
    expect(content).toHaveTextContent('"query":"roadmap"');
    expect(content).toHaveTextContent('"includeArchived":false');
    expect(content).toHaveTextContent('"title":"Kitchen remodel"');
  });
});
