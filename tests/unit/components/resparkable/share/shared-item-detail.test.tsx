// @vitest-environment happy-dom

/**
 * Unit Tests: `SharedItemDetail` — one item somebody shared with you, opened.
 *
 * Test coverage, per the component's own docblock and §13:
 * - Title, owner, tags and status render.
 * - `via` present renders the "part of something else shared with you" line
 *   with a link to the parent; absent renders neither.
 * - `childrenTruncated` renders the "not everything is shown" line; `false`
 *   does not.
 * - `includeTaskDetail: false` renders the "task notes are not included" line.
 * - No body renders "No description was shared." rather than pretending the
 *   note was simply empty.
 *
 * `CommentThread` is a real child here, not mocked — it fetches on mount, so
 * every test stubs that fetch to 404, which makes it render nothing and keeps
 * these assertions about `SharedItemDetail` itself.
 *
 * @see components/resparkable/share/shared-item-detail.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

import { SharedItemDetail } from '@/components/resparkable/share/shared-item-detail';
import { RESPARKABLE_ROUTES } from '@/lib/framework/resparkable/ui/routes';
import type { SharedItemDetailWire } from '@/lib/framework/resparkable/ui/payloads';

// ─── Fetch mock ────────────────────────────────────────────────────────────
// `CommentThread` fetches on mount; 404 it so it renders nothing and stays
// out of the way of these assertions.

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockResolvedValue(
    new Response(JSON.stringify({ success: false, error: { code: 'NOT_FOUND' } }), {
      status: 404,
    })
  );
});

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeDetail(
  overrides: Partial<Omit<SharedItemDetailWire, 'item' | 'owner'>> = {},
  itemOverrides: Partial<SharedItemDetailWire['item']> = {},
  ownerOverrides: Partial<SharedItemDetailWire['owner']> = {}
): SharedItemDetailWire {
  return {
    item: {
      entityType: 'project',
      id: 'item-1',
      title: 'Acme Redesign',
      body: null,
      status: 'active',
      dueAt: null,
      horizon: null,
      archived: false,
      updatedAt: '2026-01-01T00:00:00Z',
      tags: [],
      checklist: null,
      ...itemOverrides,
    },
    children: [],
    childrenTruncated: false,
    includeTaskDetail: true,
    owner: {
      id: 'owner-1',
      name: 'Jane Owner',
      email: 'jane@example.com',
      ...ownerOverrides,
    },
    basis: 'grant',
    canComment: false,
    via: null,
    ...overrides,
  };
}

describe('SharedItemDetail', () => {
  it('renders the title, owner, tags and status', () => {
    render(
      <SharedItemDetail
        detail={makeDetail({}, { title: 'Acme Redesign', status: 'active', tags: ['urgent'] })}
      />
    );

    expect(screen.getByRole('heading', { name: 'Acme Redesign' })).toBeInTheDocument();
    expect(screen.getByText(/Shared with you by Jane Owner/)).toBeInTheDocument();
    expect(screen.getByText('urgent')).toBeInTheDocument();
    expect(screen.getByText('active')).toBeInTheDocument();
  });

  describe('via — reached through a cascade', () => {
    it('renders the parent link when via is present', () => {
      render(
        <SharedItemDetail
          detail={makeDetail({ via: { entityType: 'project', entityId: 'parent-1' } })}
        />
      );

      const link = screen.getByRole('link', { name: /something else shared with you/i });
      expect(link).toHaveAttribute('href', RESPARKABLE_ROUTES.sharedItem('project', 'parent-1'));
    });

    it('renders no cascade line when via is absent', () => {
      render(<SharedItemDetail detail={makeDetail({ via: null })} />);

      expect(screen.queryByText(/something else shared with you/i)).not.toBeInTheDocument();
    });
  });

  describe('childrenTruncated', () => {
    const oneChild = [
      {
        entityType: 'task',
        id: 'child-1',
        title: 'Child task',
        body: null,
        status: null,
        dueAt: null,
        horizon: null,
        archived: false,
        updatedAt: '2026-01-01T00:00:00Z',
        tags: [],
        checklist: null,
      },
    ];

    it('renders the "not everything is shown" line when truncated', () => {
      render(
        <SharedItemDetail detail={makeDetail({ children: oneChild, childrenTruncated: true })} />
      );

      expect(screen.getByText(/not everything is shown here/i)).toBeInTheDocument();
    });

    it('renders no truncation line when not truncated', () => {
      render(
        <SharedItemDetail detail={makeDetail({ children: oneChild, childrenTruncated: false })} />
      );

      expect(screen.queryByText(/not everything is shown here/i)).not.toBeInTheDocument();
    });
  });

  describe('includeTaskDetail', () => {
    it('renders "task notes are not included" when false', () => {
      render(
        <SharedItemDetail
          detail={makeDetail({ includeTaskDetail: false }, { entityType: 'project' })}
        />
      );

      expect(screen.getByText(/task notes are not included in this share/i)).toBeInTheDocument();
    });

    it('renders no such notice when task detail is included', () => {
      render(
        <SharedItemDetail
          detail={makeDetail({ includeTaskDetail: true }, { entityType: 'project' })}
        />
      );

      expect(
        screen.queryByText(/task notes are not included in this share/i)
      ).not.toBeInTheDocument();
    });
  });

  describe('the fields that only render when present', () => {
    it('shows a due date on the item when it has one, and no date row when it does not', () => {
      const { unmount } = render(<SharedItemDetail detail={makeDetail({}, { dueAt: null })} />);
      expect(screen.queryByText(/due/i)).toBeNull();
      unmount();

      render(<SharedItemDetail detail={makeDetail({}, { dueAt: '2026-03-04T00:00:00Z' })} />);
      expect(screen.getByText(/due/i)).toBeInTheDocument();
    });

    it('renders tags only when the item carries them', () => {
      const { unmount } = render(<SharedItemDetail detail={makeDetail({}, { tags: [] })} />);
      expect(screen.queryByText('urgent')).toBeNull();
      unmount();

      render(<SharedItemDetail detail={makeDetail({}, { tags: ['urgent', 'q3'] })} />);
      expect(screen.getByText('urgent')).toBeInTheDocument();
      expect(screen.getByText('q3')).toBeInTheDocument();
    });

    it('marks an item the owner has archived', () => {
      // The owner retired the thinking; they did not revoke the share. Saying
      // so is what stops a reader wondering whether they are looking at
      // something current.
      render(<SharedItemDetail detail={makeDetail({}, { archived: true })} />);
      expect(screen.getByText(/archived by its owner/i)).toBeInTheDocument();
    });

    it('renders a child card’s status, checklist and due date when it has them', () => {
      render(
        <SharedItemDetail
          detail={makeDetail({
            children: [
              {
                entityType: 'task',
                id: 'task-1',
                title: 'Draft the brief',
                body: 'Some notes',
                status: 'doing',
                dueAt: '2026-03-04T00:00:00Z',
                horizon: null,
                archived: false,
                updatedAt: '2026-01-01T00:00:00Z',
                tags: [],
                checklist: { done: 2, total: 5 },
              },
            ],
          })}
        />
      );

      expect(screen.getByText('Draft the brief')).toBeInTheDocument();
      expect(screen.getByText('doing')).toBeInTheDocument();
      expect(screen.getByText('2/5')).toBeInTheDocument();
      expect(screen.getByText('Some notes')).toBeInTheDocument();
    });

    it('omits a child card’s badges when it has none of them', () => {
      render(
        <SharedItemDetail
          detail={makeDetail({
            children: [
              {
                entityType: 'task',
                id: 'task-2',
                title: 'Bare task',
                body: null,
                status: null,
                dueAt: null,
                horizon: null,
                archived: false,
                updatedAt: '2026-01-01T00:00:00Z',
                tags: [],
                checklist: null,
              },
            ],
          })}
        />
      );

      expect(screen.getByText('Bare task')).toBeInTheDocument();
      expect(screen.queryByText('/')).toBeNull();
    });
  });

  describe('body', () => {
    it('renders "No description was shared." when there is no body', () => {
      render(<SharedItemDetail detail={makeDetail({}, { body: null })} />);

      expect(screen.getByText('No description was shared.')).toBeInTheDocument();
    });

    it('renders "No description was shared." for an empty-string body too', () => {
      render(<SharedItemDetail detail={makeDetail({}, { body: '' })} />);

      expect(screen.getByText('No description was shared.')).toBeInTheDocument();
    });

    it('renders the markdown body instead of the fallback when there is one', () => {
      render(<SharedItemDetail detail={makeDetail({}, { body: 'Some real notes here.' })} />);

      expect(screen.getByText('Some real notes here.')).toBeInTheDocument();
      expect(screen.queryByText('No description was shared.')).not.toBeInTheDocument();
    });
  });
});
