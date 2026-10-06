// @vitest-environment happy-dom

/**
 * Unit Tests: `GroupCommentThread` (§23.13, phase 58).
 *
 * Two things to prove, per the component's own docblock:
 * - A personal workspace has nobody else to talk to, so this renders nothing
 *   and never asks the server for a thread.
 * - A group workspace renders the real `CommentThread`, reading and writing
 *   it with the active space, so the group's own grants are the ones the
 *   comments route resolves rather than the viewer's personal ones.
 *
 * Whether the composer shows is left entirely to `CommentThread`'s own
 * `meta.canComment` read: this component passes no `canComment` prop, by
 * design, so that behaviour is covered there and not duplicated here.
 *
 * @see components/resparkable/groups/group-comment-thread.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { useSearchParams } from 'next/navigation';

import { GroupCommentThread } from '@/components/resparkable/groups/group-comment-thread';

vi.mock('next/navigation', () => ({
  useSearchParams: vi.fn(),
}));

// ─── Fetch mock ────────────────────────────────────────────────────────────

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  mockFetch.mockReset();
  window.history.replaceState(null, '', '/resparkable/projects/item-1');
});

describe('GroupCommentThread', () => {
  it('renders nothing and makes no fetch in a personal workspace', async () => {
    // `useActiveSpaceId` reads `useSearchParams()`, and no `?space=` means the
    // personal workspace: there is nobody else in it to talk to.
    vi.mocked(useSearchParams).mockReturnValue(new URLSearchParams() as never);

    const { container } = render(<GroupCommentThread entityType="project" entityId="item-1" />);

    expect(container).toBeEmptyDOMElement();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('renders the thread and reads it with the active space, in a group workspace', async () => {
    // `withActiveSpace` (what the thread's own fetch uses) reads the address
    // bar directly, so the URL has to carry the same space the mocked
    // `useSearchParams()` answers with.
    window.history.replaceState(null, '', '/resparkable/projects/item-1?space=space_g');
    vi.mocked(useSearchParams).mockReturnValue(new URLSearchParams('space=space_g') as never);
    mockFetch.mockResolvedValueOnce(jsonResponse({ success: true, data: [] }));

    render(<GroupCommentThread entityType="project" entityId="item-1" />);

    await waitFor(() => expect(screen.getByText('Comments')).toBeInTheDocument());
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url] = mockFetch.mock.calls[0];
    expect(new URL(String(url), 'http://localhost').searchParams.get('space')).toBe('space_g');
    expect(new URL(String(url), 'http://localhost').searchParams.get('entityType')).toBe('project');
  });
});
