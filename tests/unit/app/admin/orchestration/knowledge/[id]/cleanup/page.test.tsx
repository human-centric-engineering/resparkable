// @vitest-environment happy-dom

/**
 * Cleanup page (Server Component) — branch coverage for the three SSR paths:
 *   1. doc not found → notFound()
 *   2. doc exists but status !== 'cleaning' → redirect to /admin/orchestration/knowledge
 *   3. happy path → CleanupView rendered with props derived from the doc + metadata
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';

// vi.hoisted so the spies are available inside vi.mock factories.
const {
  mockNotFound,
  mockRedirect,
  mockServerFetch,
  mockParseApiResponse,
  mockCleanupView,
  mockResolveCleanupAgentContextWindow,
} = vi.hoisted(() => ({
  mockNotFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
  mockRedirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
  mockServerFetch: vi.fn(),
  mockParseApiResponse: vi.fn(),
  mockCleanupView: vi.fn(() => null as unknown as React.ReactElement),
  mockResolveCleanupAgentContextWindow: vi.fn().mockResolvedValue(128_000),
}));

vi.mock('next/navigation', () => ({
  notFound: mockNotFound,
  redirect: mockRedirect,
}));

vi.mock('@/lib/api/server-fetch', () => ({
  serverFetch: mockServerFetch,
  parseApiResponse: mockParseApiResponse,
}));

vi.mock('@/lib/logging', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/components/admin/orchestration/knowledge/cleanup-view', () => ({
  CleanupView: mockCleanupView,
}));

vi.mock('@/lib/orchestration/knowledge/cleanup-agent', () => ({
  resolveCleanupAgentContextWindow: mockResolveCleanupAgentContextWindow,
}));

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

import CleanupPage from '@/app/admin/orchestration/knowledge/[id]/cleanup/page';

const DOC_ID = 'doc-xyz-999';

function makeDoc(overrides: Record<string, unknown> = {}) {
  return {
    id: DOC_ID,
    name: 'Transcript Q1',
    fileName: 'transcript-q1.md',
    status: 'cleaning',
    originalContent: 'Original raw text.',
    processedContent: 'Cleaned text.',
    metadata: { sizeClass: 'medium', sizeTokens: 5000, llmRewriteAllowed: true },
    ...overrides,
  };
}

function mockFetchResolves(doc: ReturnType<typeof makeDoc> | null) {
  mockServerFetch.mockResolvedValue({ ok: doc !== null });
  mockParseApiResponse.mockResolvedValue(
    doc === null ? { success: false } : { success: true, data: { document: doc } }
  );
}

describe('CleanupPage (Server Component)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls notFound() when the doc fetch returns a non-ok response', async () => {
    mockServerFetch.mockResolvedValue({ ok: false });

    await expect(CleanupPage({ params: Promise.resolve({ id: DOC_ID }) })).rejects.toThrow(
      'NEXT_NOT_FOUND'
    );

    expect(mockNotFound).toHaveBeenCalledTimes(1);
    expect(mockRedirect).not.toHaveBeenCalled();
    expect(mockCleanupView).not.toHaveBeenCalled();
  });

  it('calls notFound() when serverFetch throws', async () => {
    mockServerFetch.mockRejectedValue(new Error('network down'));

    await expect(CleanupPage({ params: Promise.resolve({ id: DOC_ID }) })).rejects.toThrow(
      'NEXT_NOT_FOUND'
    );

    expect(mockNotFound).toHaveBeenCalledTimes(1);
  });

  it('redirects to the KB list when the doc status is not "cleaning"', async () => {
    mockFetchResolves(makeDoc({ status: 'ready' }));

    await expect(CleanupPage({ params: Promise.resolve({ id: DOC_ID }) })).rejects.toThrow(
      'NEXT_REDIRECT:/admin/orchestration/knowledge'
    );

    expect(mockRedirect).toHaveBeenCalledWith('/admin/orchestration/knowledge');
    expect(mockCleanupView).not.toHaveBeenCalled();
  });

  it('renders CleanupView with props derived from the doc and metadata on the happy path', async () => {
    mockFetchResolves(makeDoc());

    const element = await CleanupPage({ params: Promise.resolve({ id: DOC_ID }) });
    render(element);

    expect(mockNotFound).not.toHaveBeenCalled();
    expect(mockRedirect).not.toHaveBeenCalled();
    expect(mockCleanupView).toHaveBeenCalledTimes(1);
    const props = (mockCleanupView.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(props.documentId).toBe(DOC_ID);
    expect(props.documentName).toBe('Transcript Q1');
    expect(props.fileName).toBe('transcript-q1.md');
    expect(props.originalContent).toBe('Original raw text.');
    expect(props.initialProcessedContent).toBe('Cleaned text.');
    expect(props.sizeClass).toBe('medium');
    expect(props.sizeTokens).toBe(5000);
    expect(props.llmRewriteAllowed).toBe(true);
  });

  it('falls back to originalContent for initialProcessedContent when processedContent is null', async () => {
    mockFetchResolves(makeDoc({ processedContent: null }));

    const element = await CleanupPage({ params: Promise.resolve({ id: DOC_ID }) });
    render(element);

    const props = (mockCleanupView.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(props.initialProcessedContent).toBe('Original raw text.');
  });

  it('falls back to defaults when the doc has no metadata', async () => {
    mockFetchResolves(makeDoc({ metadata: null }));

    const element = await CleanupPage({ params: Promise.resolve({ id: DOC_ID }) });
    render(element);

    const props = (mockCleanupView.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(props.sizeClass).toBe('small');
    expect(props.sizeTokens).toBe(0);
    expect(props.llmRewriteAllowed).toBe(true);
  });
});
