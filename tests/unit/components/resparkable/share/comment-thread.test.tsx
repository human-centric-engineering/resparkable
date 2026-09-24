// @vitest-environment happy-dom

/**
 * Unit Tests: `CommentThread` — the one thing a grantee can write.
 *
 * Test coverage, per the component's own docblock:
 * - A 404 on the comments GET renders nothing (`null`), not an error. That
 *   basis carries no comments — a public link or a cascaded grant.
 * - Author names render, and the owner's own comments say "shared this".
 * - `canComment: false` renders no compose form; `true` renders one.
 * - Edit and delete are drawn from the server's per-comment `canEdit` and
 *   `canDelete`, never re-derived from `mine`. The case that matters: the
 *   reader's own comment after they lost the right to comment shows Delete
 *   and no Edit, because an Edit there would always fail.
 * - Delete on someone else's comment appears only when the server says the
 *   reader moderates the item.
 * - The body renders as plain text: markdown syntax in a comment must appear
 *   literally, never rendered.
 * - Submitting a comment POSTs it and re-renders from the returned thread;
 *   a failed post surfaces an error rather than losing the draft silently.
 * - Editing PATCHes the comment and clears the edit form on success; Cancel
 *   discards the edit with no request at all.
 * - Deleting DELETEs the comment, addressed by id and scoped by
 *   `?entityType=&entityId=`.
 *
 * @see components/resparkable/share/comment-thread.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { CommentThread } from '@/components/resparkable/share/comment-thread';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import type { CommentWire } from '@/lib/framework/resparkable/ui/payloads';

// ─── Fetch mock ────────────────────────────────────────────────────────────

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeComment(
  overrides: Partial<Omit<CommentWire, 'author'>> = {},
  authorOverrides: Partial<CommentWire['author']> = {}
): CommentWire {
  const mine = overrides.mine ?? false;
  return {
    id: 'comment-1',
    body: 'Looks good to me.',
    mine,
    // The server's usual answer for a reader who can still comment.
    canEdit: mine,
    canDelete: mine,
    editedAt: null,
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
    author: {
      id: 'author-1',
      name: 'Alex Grantee',
      isOwner: false,
      ...authorOverrides,
    },
  };
}

beforeEach(() => {
  mockFetch.mockReset();
  window.history.replaceState(null, '', '/resparkable/shared');
});

describe('CommentThread', () => {
  it('renders nothing when the comments GET 404s', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ success: false, error: { code: 'NOT_FOUND' } }, 404)
    );

    const { container } = render(
      <CommentThread entityType="project" entityId="item-1" canComment={false} />
    );

    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(screen.queryByText('Comments')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('renders nothing when the comments GET rejects outright', async () => {
    mockFetch.mockRejectedValueOnce(new Error('network down'));

    const { container } = render(
      <CommentThread entityType="project" entityId="item-1" canComment={false} />
    );

    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it("renders author names and marks the owner's own comments", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: [makeComment({}, { name: 'Jane Owner', isOwner: true })],
      })
    );

    render(<CommentThread entityType="project" entityId="item-1" canComment={false} />);

    expect(await screen.findByText('Jane Owner')).toBeInTheDocument();
    expect(screen.getByText(/shared this/)).toBeInTheDocument();
  });

  it('does not mark a non-owner comment as "shared this"', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: [makeComment({}, { name: 'Alex Grantee', isOwner: false })],
      })
    );

    render(<CommentThread entityType="project" entityId="item-1" canComment={false} />);

    expect(await screen.findByText('Alex Grantee')).toBeInTheDocument();
    expect(screen.queryByText(/shared this/)).not.toBeInTheDocument();
  });

  describe('compose form', () => {
    it('renders no compose form when the reader cannot comment', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ success: true, data: [] }));

      render(<CommentThread entityType="project" entityId="item-1" canComment={false} />);

      await waitFor(() =>
        expect(screen.getByText('Nothing has been said yet.')).toBeInTheDocument()
      );
      expect(screen.queryByLabelText('Write a comment')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Comment' })).not.toBeInTheDocument();
    });

    it('renders a compose form when the reader can comment', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ success: true, data: [] }));

      render(<CommentThread entityType="project" entityId="item-1" canComment={true} />);

      await waitFor(() => expect(screen.getByLabelText('Write a comment')).toBeInTheDocument());
      expect(screen.getByRole('button', { name: 'Comment' })).toBeInTheDocument();
    });
  });

  describe('edit button', () => {
    it('appears only where the server says the reader may edit', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: [
            makeComment({ id: 'mine', mine: true }, { name: 'Me' }),
            makeComment({ id: 'theirs', mine: false }, { name: 'Someone Else' }),
          ],
        })
      );

      render(<CommentThread entityType="project" entityId="item-1" canComment={true} />);

      await screen.findByText('Me');
      expect(screen.getAllByRole('button', { name: /edit your comment/i })).toHaveLength(1);
    });

    it('is withheld on the reader’s own comment once they can no longer comment, while delete stays', async () => {
      // A grant lowered to viewer, or a group member demoted to viewer: the
      // comment is still theirs, but an Edit would always be refused.
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: [makeComment({ id: 'mine', mine: true, canEdit: false, canDelete: true })],
        })
      );

      render(<CommentThread entityType="project" entityId="item-1" canComment={false} />);

      await screen.findByText('Alex Grantee');
      expect(screen.queryByRole('button', { name: /edit your comment/i })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /remove this comment/i })).toBeInTheDocument();
    });
  });

  describe('delete button', () => {
    it("shows delete on the reader's own comment", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ success: true, data: [makeComment({ id: 'mine', mine: true })] })
      );

      render(<CommentThread entityType="project" entityId="item-1" canComment={true} />);

      await screen.findByText('Alex Grantee');
      expect(screen.getByRole('button', { name: /remove this comment/i })).toBeInTheDocument();
    });

    it("shows delete on someone else's comment when the server says the reader moderates", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: [makeComment({ id: 'theirs', mine: false, canDelete: true })],
        })
      );

      render(<CommentThread entityType="project" entityId="item-1" canComment={false} />);

      await screen.findByText('Alex Grantee');
      expect(screen.getByRole('button', { name: /remove this comment/i })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /edit your comment/i })).not.toBeInTheDocument();
    });

    it('shows no delete when the server gives none', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ success: true, data: [makeComment({ id: 'theirs', mine: false })] })
      );

      render(<CommentThread entityType="project" entityId="item-1" canComment={false} />);

      await screen.findByText('Alex Grantee');
      expect(
        screen.queryByRole('button', { name: /remove this comment/i })
      ).not.toBeInTheDocument();
    });
  });

  it('renders the body as plain text — markdown syntax appears literally', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: [makeComment({ body: '**bold** and _italic_' })],
      })
    );

    const { container } = render(
      <CommentThread entityType="project" entityId="item-1" canComment={false} />
    );

    expect(await screen.findByText('**bold** and _italic_')).toBeInTheDocument();
    expect(container.querySelector('strong')).toBeNull();
    expect(container.querySelector('em')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    expect(container.querySelector('i')).toBeNull();
  });

  describe('inside a group workspace', () => {
    it('reads and writes the thread with the workspace, so the group grant is the one resolved', async () => {
      window.history.replaceState(null, '', '/resparkable/shared/project/item-1?space=space_b');
      const user = userEvent.setup();
      mockFetch
        .mockResolvedValueOnce(jsonResponse({ success: true, data: [] })) // load
        .mockResolvedValueOnce(jsonResponse({ success: true, data: [makeComment()] })); // POST

      render(<CommentThread entityType="project" entityId="item-1" canComment={true} />);

      await waitFor(() => expect(screen.getByLabelText('Write a comment')).toBeInTheDocument());
      await user.type(screen.getByLabelText('Write a comment'), 'Hello');
      await user.click(screen.getByRole('button', { name: 'Comment' }));
      await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));

      for (const [url] of mockFetch.mock.calls) {
        expect(new URL(String(url), 'http://localhost').searchParams.get('space')).toBe('space_b');
      }
    });
  });

  describe('submitting a comment', () => {
    it('POSTs the draft and re-renders from the returned thread', async () => {
      const user = userEvent.setup();
      const posted = makeComment({ id: 'new-1', body: 'A new comment', mine: true });

      mockFetch
        .mockResolvedValueOnce(jsonResponse({ success: true, data: [] })) // load
        .mockResolvedValueOnce(jsonResponse({ success: true, data: [posted] })); // POST

      render(<CommentThread entityType="project" entityId="item-1" canComment={true} />);

      await waitFor(() => expect(screen.getByLabelText('Write a comment')).toBeInTheDocument());
      await user.type(screen.getByLabelText('Write a comment'), 'A new comment');
      await user.click(screen.getByRole('button', { name: 'Comment' }));

      expect(await screen.findByText('A new comment')).toBeInTheDocument();
      expect(mockFetch).toHaveBeenNthCalledWith(2, RESPARKABLE_API.COMMENTS, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entityType: 'project', entityId: 'item-1', body: 'A new comment' }),
      });
      // The draft is cleared after a successful post.
      expect(screen.getByLabelText('Write a comment')).toHaveValue('');
    });

    it('renders an error and keeps the draft when the post fails', async () => {
      const user = userEvent.setup();

      mockFetch
        .mockResolvedValueOnce(jsonResponse({ success: true, data: [] })) // load
        .mockResolvedValueOnce(jsonResponse({ success: false, error: { code: 'X' } }, 500)); // POST fails

      render(<CommentThread entityType="project" entityId="item-1" canComment={true} />);

      await waitFor(() => expect(screen.getByLabelText('Write a comment')).toBeInTheDocument());
      await user.type(screen.getByLabelText('Write a comment'), 'Will fail');
      await user.click(screen.getByRole('button', { name: 'Comment' }));

      expect(await screen.findByRole('alert')).toHaveTextContent('Could not add your comment.');
      // The draft is not lost on failure.
      expect(screen.getByLabelText('Write a comment')).toHaveValue('Will fail');
    });

    it('renders an error when the post request itself rejects', async () => {
      const user = userEvent.setup();

      mockFetch
        .mockResolvedValueOnce(jsonResponse({ success: true, data: [] })) // load
        .mockRejectedValueOnce(new Error('network down')); // POST rejects

      render(<CommentThread entityType="project" entityId="item-1" canComment={true} />);

      await waitFor(() => expect(screen.getByLabelText('Write a comment')).toBeInTheDocument());
      await user.type(screen.getByLabelText('Write a comment'), 'Will fail');
      await user.click(screen.getByRole('button', { name: 'Comment' }));

      expect(await screen.findByRole('alert')).toHaveTextContent('Could not add your comment.');
    });
  });

  describe('editing a comment', () => {
    it('opens the edit form pre-filled, saves via PATCH, and clears the form on success', async () => {
      const user = userEvent.setup();
      const original = makeComment({ id: 'mine', body: 'Original text', mine: true });
      const edited = makeComment({ id: 'mine', body: 'Edited text', mine: true });

      mockFetch
        .mockResolvedValueOnce(jsonResponse({ success: true, data: [original] })) // load
        .mockResolvedValueOnce(jsonResponse({ success: true, data: [edited] })); // PATCH

      render(<CommentThread entityType="project" entityId="item-1" canComment={true} />);

      await screen.findByText('Original text');
      await user.click(screen.getByRole('button', { name: /edit your comment/i }));

      const editBox = screen.getByLabelText('Edit your comment');
      expect(editBox).toHaveValue('Original text');
      await user.clear(editBox);
      await user.type(editBox, 'Edited text');
      await user.click(screen.getByRole('button', { name: 'Save' }));

      expect(mockFetch).toHaveBeenNthCalledWith(2, RESPARKABLE_API.comment('mine'), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entityType: 'project',
          entityId: 'item-1',
          body: 'Edited text',
        }),
      });
      expect(await screen.findByText('Edited text')).toBeInTheDocument();
      expect(screen.queryByLabelText('Edit your comment')).not.toBeInTheDocument();
    });

    it('cancel discards the edit without any request', async () => {
      const user = userEvent.setup();
      const original = makeComment({ id: 'mine', body: 'Original text', mine: true });

      mockFetch.mockResolvedValueOnce(jsonResponse({ success: true, data: [original] })); // load

      render(<CommentThread entityType="project" entityId="item-1" canComment={true} />);

      await screen.findByText('Original text');
      await user.click(screen.getByRole('button', { name: /edit your comment/i }));
      await user.clear(screen.getByLabelText('Edit your comment'));
      await user.type(screen.getByLabelText('Edit your comment'), 'Unsaved change');
      await user.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(screen.queryByLabelText('Edit your comment')).not.toBeInTheDocument();
      expect(screen.getByText('Original text')).toBeInTheDocument();
      // Only the initial load — cancel never talked to the server.
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('renders an error when saving the edit fails', async () => {
      const user = userEvent.setup();
      const original = makeComment({ id: 'mine', body: 'Original text', mine: true });

      mockFetch
        .mockResolvedValueOnce(jsonResponse({ success: true, data: [original] })) // load
        .mockResolvedValueOnce(jsonResponse({ success: false, error: { code: 'X' } }, 500)); // PATCH fails

      render(<CommentThread entityType="project" entityId="item-1" canComment={true} />);

      await screen.findByText('Original text');
      await user.click(screen.getByRole('button', { name: /edit your comment/i }));
      await user.click(screen.getByRole('button', { name: 'Save' }));

      expect(await screen.findByRole('alert')).toHaveTextContent('Could not save your change.');
      // The edit form is still open — nothing was lost.
      expect(screen.getByLabelText('Edit your comment')).toBeInTheDocument();
    });
  });

  describe('deleting a comment', () => {
    it('DELETEs the comment scoped by entityType/entityId and re-renders the thread', async () => {
      const user = userEvent.setup();
      const comment = makeComment({ id: 'to-delete', mine: true });

      mockFetch
        .mockResolvedValueOnce(jsonResponse({ success: true, data: [comment] })) // load
        .mockResolvedValueOnce(jsonResponse({ success: true, data: [] })); // DELETE

      render(<CommentThread entityType="project" entityId="item-1" canComment={true} />);

      await screen.findByText('Alex Grantee');
      await user.click(screen.getByRole('button', { name: /remove this comment/i }));

      expect(mockFetch).toHaveBeenNthCalledWith(
        2,
        `${RESPARKABLE_API.comment('to-delete')}?entityType=project&entityId=item-1`,
        { method: 'DELETE' }
      );
      await waitFor(() =>
        expect(screen.getByText('Nothing has been said yet.')).toBeInTheDocument()
      );
    });

    it('renders an error when the delete fails', async () => {
      const user = userEvent.setup();
      const comment = makeComment({ id: 'to-delete', mine: true });

      mockFetch
        .mockResolvedValueOnce(jsonResponse({ success: true, data: [comment] })) // load
        .mockResolvedValueOnce(jsonResponse({ success: false, error: { code: 'X' } }, 500)); // DELETE fails

      render(<CommentThread entityType="project" entityId="item-1" canComment={true} />);

      await screen.findByText('Alex Grantee');
      await user.click(screen.getByRole('button', { name: /remove this comment/i }));

      expect(await screen.findByRole('alert')).toHaveTextContent('Could not remove that comment.');
    });
  });

  it('shows "edited" next to a comment that has been edited', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: [makeComment({ editedAt: '2026-01-02T00:00:00Z' })],
      })
    );

    render(<CommentThread entityType="project" entityId="item-1" canComment={false} />);

    expect(await screen.findByText(/edited/)).toBeInTheDocument();
  });
});
