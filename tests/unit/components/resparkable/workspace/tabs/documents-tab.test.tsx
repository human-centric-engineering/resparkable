/**
 * Unit Tests: DocumentsTab.
 *
 * Same shape as AreasTab: no mapping of its own, just endpoint wiring and
 * hook-state → branch dispatch. `DocumentsView` is mocked to a props-dumping
 * marker so this file stays about DocumentsTab's own wiring, not the view's
 * rendering.
 *
 * @see components/resparkable/workspace/tabs/documents-tab.tsx
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { DocumentsTab } from '@/components/resparkable/workspace/tabs/documents-tab';
import { apiClient, APIClientError } from '@/lib/api/client';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';

vi.mock('@/lib/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/client')>('@/lib/api/client');
  return { ...actual, apiClient: { ...actual.apiClient, get: vi.fn() } };
});

vi.mock('@/components/resparkable/documents/documents-view', () => ({
  DocumentsView: (props: Record<string, unknown>) => (
    <div data-testid="documents-view">{JSON.stringify(props)}</div>
  ),
}));

function document(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'doc_1',
    title: 'Plan.md',
    fileName: 'plan.md',
    fileHash: 'abc123',
    mimeType: 'text/markdown',
    byteSize: 1024,
    status: 'indexed',
    chunkCount: 4,
    sourceUrl: null,
    errorMessage: null,
    archivedAt: null,
    archivedReason: null,
    hasOriginal: true,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(apiClient.get).mockReset();
});

describe('DocumentsTab', () => {
  it('requests the documents collection with a 100 limit', async () => {
    vi.mocked(apiClient.get).mockResolvedValue([]);

    render(<DocumentsTab />);

    await waitFor(() =>
      expect(apiClient.get).toHaveBeenCalledWith(`${RESPARKABLE_API.DOCUMENTS}?limit=100`)
    );
  });

  it('shows a labelled loading state before the fetch resolves', () => {
    vi.mocked(apiClient.get).mockReturnValue(new Promise(() => {}));

    render(<DocumentsTab />);

    expect(screen.getByText('Loading documents')).toBeInTheDocument();
  });

  it('renders TabLoadError with the API error message and retries through the hook', async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.get).mockRejectedValue(
      new APIClientError('Documents are unavailable.', 'ERR', 500)
    );

    render(<DocumentsTab />);

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByText('Documents are unavailable.')).toBeInTheDocument();
    expect(screen.getByText(/Couldn.t load your documents/)).toBeInTheDocument();

    vi.mocked(apiClient.get).mockResolvedValue([document()]);
    await user.click(screen.getByRole('button', { name: /try again/i }));

    await waitFor(() => expect(screen.getByTestId('documents-view')).toBeInTheDocument());
    expect(apiClient.get).toHaveBeenCalledTimes(2);
  });

  it('passes exactly the validated documents through to DocumentsView', async () => {
    vi.mocked(apiClient.get).mockResolvedValue([
      { ...document(), unexpectedField: 'stripped by the schema, not by DocumentsTab' },
    ]);

    render(<DocumentsTab />);

    await waitFor(() => expect(screen.getByTestId('documents-view')).toBeInTheDocument());
    const rendered = JSON.parse(screen.getByTestId('documents-view').textContent ?? '{}');
    expect(rendered.documents).toEqual([document()]);
  });

  it('renders an empty DocumentsView when there are no documents', async () => {
    vi.mocked(apiClient.get).mockResolvedValue([]);

    render(<DocumentsTab />);

    await waitFor(() => expect(screen.getByTestId('documents-view')).toBeInTheDocument());
    const rendered = JSON.parse(screen.getByTestId('documents-view').textContent ?? '{}');
    expect(rendered.documents).toEqual([]);
  });
});
