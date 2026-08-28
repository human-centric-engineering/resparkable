'use client';

/**
 * CommentThread — the one thing a grantee can write.
 *
 * ## Plain text, rendered as plain text
 *
 * The body is not markdown and is not rendered as markdown. That is a decision
 * about **whose screen this appears on**: a comment written by a grantee is
 * third-party content displayed to the owner, and giving it a rendering pipeline
 * widens the surface for nothing a comment needs. A comment is a sentence.
 *
 * ## Edit is the author's; delete is the author's or the owner's
 *
 * The asymmetry is deliberate and the UI mirrors it. Rewriting somebody's words
 * while leaving their name on them is worse than removing them — so the owner
 * gets a delete and no edit. Somebody else's words standing in your own notes
 * with no way to remove them is what makes people stop sharing.
 *
 * The server enforces both in its `where` clauses; this only decides which
 * buttons to draw.
 *
 * ## Why the whole thread comes back from every write
 *
 * A conversation with two people in it changes between reads. Appending the one
 * row a POST returned would leave the reader looking at a thread missing
 * whatever was said in between, and looking confidently at it.
 */

import * as React from 'react';
import { Pencil, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { ClientDate } from '@/components/ui/client-date';
import { Textarea } from '@/components/ui/textarea';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import { commentsSchema, type CommentWire } from '@/lib/framework/resparkable/ui/payloads';

export interface CommentThreadProps {
  entityType: string;
  entityId: string;
  /** Whether this reader may write. False renders the thread read-only. */
  canComment: boolean;
  /** True when the reader owns the item, so delete is offered on every row. */
  isOwner: boolean;
}

export function CommentThread({
  entityType,
  entityId,
  canComment,
  isOwner,
}: CommentThreadProps): React.ReactElement | null {
  const [comments, setComments] = React.useState<CommentWire[] | null>(null);
  const [unavailable, setUnavailable] = React.useState(false);
  const [draft, setDraft] = React.useState('');
  const [editing, setEditing] = React.useState<{ id: string; body: string } | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const ref = `entityType=${encodeURIComponent(entityType)}&entityId=${encodeURIComponent(entityId)}`;

  const load = React.useCallback(async () => {
    const result = await read(`${RESPARKABLE_API.COMMENTS}?${ref}`);
    // A 404 here means this basis carries no comments — a public link or a
    // cascaded grant. Not an error, and not something to explain: the thread
    // simply is not part of what was shared.
    if (result === null) setUnavailable(true);
    else setComments(result);
  }, [ref]);

  React.useEffect(() => {
    void load();
  }, [load]);

  if (unavailable) return null;

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (draft.trim().length === 0) return;

    setBusy(true);
    setError(null);
    const result = await write(RESPARKABLE_API.COMMENTS, 'POST', {
      entityType,
      entityId,
      body: draft,
    });
    setBusy(false);

    if (result === null) {
      setError('Could not add your comment.');
      return;
    }
    setDraft('');
    setComments(result);
  }

  async function saveEdit(): Promise<void> {
    if (!editing || editing.body.trim().length === 0) return;

    setBusy(true);
    setError(null);
    const result = await write(RESPARKABLE_API.comment(editing.id), 'PATCH', {
      entityType,
      entityId,
      body: editing.body,
    });
    setBusy(false);

    if (result === null) {
      setError('Could not save your change.');
      return;
    }
    setEditing(null);
    setComments(result);
  }

  async function remove(id: string): Promise<void> {
    setBusy(true);
    setError(null);
    const result = await write(`${RESPARKABLE_API.comment(id)}?${ref}`, 'DELETE');
    setBusy(false);

    if (result === null) {
      setError('Could not remove that comment.');
      return;
    }
    setComments(result);
  }

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-medium">Comments</h2>

      {comments === null ? (
        <p className="text-muted-foreground text-sm">Loading comments…</p>
      ) : comments.length === 0 ? (
        <p className="text-muted-foreground text-sm">Nothing has been said yet.</p>
      ) : (
        <ul className="space-y-3">
          {comments.map((comment) => (
            <li key={comment.id} className="bg-card space-y-1 rounded-md border p-3">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="text-sm font-medium">
                  {comment.author.name ?? 'Someone'}
                  {comment.author.isOwner && (
                    <span className="text-muted-foreground font-normal"> · shared this</span>
                  )}
                </span>
                <span className="text-muted-foreground text-xs">
                  <ClientDate date={comment.createdAt} />
                  {comment.editedAt !== null && ' · edited'}
                </span>

                {/* Edit only for the author; delete for the author or the
                    owner. The server enforces both — this decides what to
                    draw. */}
                {comment.mine && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="ml-auto"
                    onClick={() => setEditing({ id: comment.id, body: comment.body })}
                  >
                    <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                    <span className="sr-only">Edit your comment</span>
                  </Button>
                )}
                {(comment.mine || isOwner) && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className={comment.mine ? undefined : 'ml-auto'}
                    onClick={() => void remove(comment.id)}
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    <span className="sr-only">Remove this comment</span>
                  </Button>
                )}
              </div>

              {editing?.id === comment.id ? (
                <div className="space-y-2">
                  <Textarea
                    value={editing.body}
                    onChange={(event) => setEditing({ id: comment.id, body: event.target.value })}
                    aria-label="Edit your comment"
                  />
                  <div className="flex gap-2">
                    <Button type="button" size="sm" disabled={busy} onClick={() => void saveEdit()}>
                      Save
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => setEditing(null)}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                // Plain text, deliberately. Not markdown, not HTML — see the
                // header. `whitespace-pre-wrap` keeps the line breaks somebody
                // typed without giving them any other syntax.
                <p className="text-sm whitespace-pre-wrap">{comment.body}</p>
              )}
            </li>
          ))}
        </ul>
      )}

      {error !== null && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}

      {canComment && (
        <form className="space-y-2" onSubmit={(event) => void submit(event)}>
          <Textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Say something"
            aria-label="Write a comment"
          />
          <Button type="submit" size="sm" disabled={busy || draft.trim().length === 0}>
            Comment
          </Button>
        </form>
      )}
    </section>
  );
}

async function read(url: string): Promise<CommentWire[] | null> {
  try {
    const response = await fetch(url);
    const payload: unknown = await response.json();
    if (!response.ok || !isSuccess(payload)) return null;
    const parsed = commentsSchema.safeParse(payload.data);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function write(
  url: string,
  method: 'POST' | 'PATCH' | 'DELETE',
  body?: unknown
): Promise<CommentWire[] | null> {
  try {
    const response = await fetch(url, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
    const payload: unknown = await response.json();
    if (!response.ok || !isSuccess(payload)) return null;
    const parsed = commentsSchema.safeParse(payload.data);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function isSuccess(payload: unknown): payload is { success: true; data: unknown } {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    'success' in payload &&
    payload.success === true &&
    'data' in payload
  );
}
