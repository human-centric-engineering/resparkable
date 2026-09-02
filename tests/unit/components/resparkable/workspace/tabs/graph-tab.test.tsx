// @vitest-environment happy-dom

/**
 * Unit Tests: GraphTab.
 *
 * `useTabFetch` itself is covered by `use-tab-fetch.test.ts`; these tests
 * mock only `apiClient.get`. What's this adapter's own logic, and what's
 * pinned here: `endpoint` is `null` (no fetch at all) unless *both*
 * `focusType` and `focus` are supplied, in which case it builds the query
 * string from them — that's the one bit of real branching this component
 * owns, plus the loading/error/ready passthrough shared with the other
 * adapters.
 *
 * @see components/resparkable/workspace/tabs/graph-tab.tsx
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

import { GraphTab } from '@/components/resparkable/workspace/tabs/graph-tab';
import { apiClient, APIClientError } from '@/lib/api/client';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import type { GraphPayloadWire } from '@/lib/framework/resparkable/ui/payloads';

vi.mock('@/lib/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/client')>('@/lib/api/client');
  return { ...actual, apiClient: { ...actual.apiClient, get: vi.fn() } };
});

vi.mock('@/components/resparkable/graph/graph-view', () => ({
  GraphView: ({ payload }: { payload: GraphPayloadWire }) => (
    <div data-testid="graph-view">{JSON.stringify(payload)}</div>
  ),
}));

function makePayload(overrides: Partial<GraphPayloadWire> = {}): GraphPayloadWire {
  return {
    focus: { type: 'project', id: 'proj_1' },
    nodes: [],
    edges: [],
    truncated: false,
    nodeCap: 50,
    depth: 2,
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(apiClient.get).mockReset();
});

describe('GraphTab', () => {
  it('never fetches, and shows the pick-something empty state, when neither focus param is set', () => {
    render(<GraphTab />);

    expect(apiClient.get).not.toHaveBeenCalled();
    expect(screen.getByText('Pick something to look at')).toBeInTheDocument();
  });

  it('never fetches when only focusType is set (focus missing)', () => {
    render(<GraphTab focusType="project" />);

    expect(apiClient.get).not.toHaveBeenCalled();
    expect(screen.getByText('Pick something to look at')).toBeInTheDocument();
  });

  it('never fetches when only focus is set (focusType missing)', () => {
    render(<GraphTab focus="proj_1" />);

    expect(apiClient.get).not.toHaveBeenCalled();
    expect(screen.getByText('Pick something to look at')).toBeInTheDocument();
  });

  it('builds the graph endpoint from focus and focusType once both are set', () => {
    vi.mocked(apiClient.get).mockReturnValue(new Promise(() => {}));

    render(<GraphTab focusType="project" focus="proj_1" />);

    expect(apiClient.get).toHaveBeenCalledWith(
      `${RESPARKABLE_API.GRAPH}?focus=proj_1&focusType=project`
    );
  });

  it('shows a loading skeleton before the fetch resolves', () => {
    vi.mocked(apiClient.get).mockReturnValue(new Promise(() => {}));

    render(<GraphTab focusType="project" focus="proj_1" />);

    expect(screen.getByText('Loading graph')).toBeInTheDocument();
  });

  it('shows a load error naming the graph on fetch failure', async () => {
    vi.mocked(apiClient.get).mockRejectedValue(new APIClientError('Server is down.', 'ERR', 500));

    render(<GraphTab focusType="project" focus="proj_1" />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t load the graph.');
    expect(screen.getByText('Server is down.')).toBeInTheDocument();
  });

  it('passes the fetched payload straight through to GraphView once ready', async () => {
    const payload = makePayload();
    vi.mocked(apiClient.get).mockResolvedValue(payload);

    render(<GraphTab focusType="project" focus="proj_1" />);

    const view = await screen.findByTestId('graph-view');
    expect(JSON.parse(view.textContent ?? '{}')).toEqual(payload);
  });
});
