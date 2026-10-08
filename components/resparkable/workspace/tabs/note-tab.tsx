'use client';

/**
 * NoteTab — manual hand-edit of a thought's body.
 *
 * The one genuinely new adapter (the build plan's own framing): every other
 * kind reuses an existing page's fetch and an existing View component. A
 * note has no page of its own to port — `thought-card.tsx` shows `content`
 * read-only via `MarkdownView`, and the only existing write path for a
 * thought is status changes (drop/promote), never the body. There's also no
 * debounce utility anywhere in this codebase to reuse (checked
 * `lib/hooks/`) — the debounce here is a plain `setTimeout`, not a shared
 * hook, since nothing else needs one yet.
 *
 * This is deliberately **not** the AI-mediated flow `context-summary-panel.tsx`
 * is: that panel proposes a description and asks you to accept or reject it.
 * This is the same kind of field a plain edit form would expose — direct,
 * immediate, no proposal step — writing straight through
 * `PATCH .../thoughts/:id` the same way `thought-card.tsx`'s own mutations do.
 *
 * In a group two people can have one note open, and an autosave that wrote
 * blind would hand the note to whoever paused typing last. So every save sends
 * the `rev` it last saw, and a 409 stops autosaving until this person chooses:
 * write their own text over the other version, or take the other version.
 * Phase 63 brought phase 58's Decision 3 (`rev` as an optional concurrency
 * token) to this, the one inline editor where text is typed.
 *
 * A 409 is not always a change to the words. Any write to the thought moves its
 * `rev` (a status change from the inbox, a snooze). When the text on the server
 * is still the text this editor last knew it held, nobody changed the words, so
 * the save takes the new `rev` and goes through rather than asking a question
 * with no real answer. Any other text is a real conflict and always asks, even
 * when the other version came from this same person in another pane.
 *
 * Except when there is no one left to ask. A save that finds a conflict after
 * its editor has closed (the flush of the last keystrokes, or a save still in
 * flight) keeps the closing text as a new note in the same workspace, rather
 * than writing over the other version or dropping the text. Nothing is lost and
 * nothing is overwritten. The workspace is the one the editor opened in, read
 * once at mount, so a save that outlives a workspace switch still lands where
 * the note lives.
 */

import * as React from 'react';
import { z } from 'zod';

import { SaveStatus, useSaveStatus } from '@/components/resparkable/ui/save-status';
import { SkeletonList } from '@/components/resparkable/ui/skeleton';
import { TabLoadError } from '@/components/resparkable/workspace/tabs/tab-load-error';
import { useTabFetch } from '@/components/resparkable/workspace/tabs/use-tab-fetch';
import {
  titleFromNoteBody,
  useTabTitle,
} from '@/components/resparkable/workspace/tabs/use-tab-title';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { apiClient } from '@/lib/api/client';
import { withActiveSpace } from '@/lib/framework/resparkable/api/client';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import { isEditConflict, readConflictCurrent } from '@/lib/framework/resparkable/ui/edit-conflict';
import { thoughtSchema } from '@/lib/framework/resparkable/ui/payloads';

/** How long to wait after the last keystroke before writing. */
const SAVE_DEBOUNCE_MS = 800;

/** What a person is told when the note's text changed under them. */
export const NOTE_CONFLICT_MESSAGE =
  'This note was changed somewhere else while you were writing. Your text is still here, but it will not save until you choose. Closing the tab now leaves the other version in place.';

/**
 * What a successful save returns, read without asserting. The `content` is the
 * server's, which is trimmed, so it and not the text sent is what the next
 * conflict compares against.
 */
const savedRowSchema = z.object({ rev: z.number().int(), content: z.string() });

/** The slice of a 409's current row this editor needs: its token and its words. */
const conflictRowSchema = z.object({ rev: z.number().int(), content: z.string() });

type Conflict = z.infer<typeof conflictRowSchema>;

/** How many times a save follows a `rev` that moved without the words changing. */
const MAX_SAVE_ATTEMPTS = 3;

/**
 * One save queue per note, shared by every editor of it on this page. Saves to
 * one note run one at a time, whichever editor sent them: two in flight would
 * send the same `rev` and the second would collide with the first. Shared
 * rather than per editor because an editor that closes flushes its last
 * keystrokes, and a reopened editor's first save must wait for that flush
 * rather than race it. Module scope because the closing editor is gone by then.
 */
const saveQueues = new Map<string, Promise<unknown>>();

function enqueueSave(id: string, task: () => Promise<unknown>): void {
  // A save that rejects must not stop the ones queued behind it.
  const tail = (saveQueues.get(id) ?? Promise.resolve()).catch(() => undefined).then(task);
  saveQueues.set(id, tail);
  // Drop the entry once this is the last save queued for the note.
  void tail.then(() => {
    if (saveQueues.get(id) === tail) saveQueues.delete(id);
  });
}

/** What a save returns when a closed editor's text went to a new note instead. */
const KEPT_AS_NEW_NOTE = Symbol('kept as a new note');

/** Thrown inside a save once a real conflict is held, to report it without retrying. */
class HeldConflict extends Error {}

export interface NoteTabProps {
  /** This tab's id — what `useTabTitle` names from the note's own first line. */
  tabId: string;
  id: string;
}

export function NoteTab({ tabId, id }: NoteTabProps): React.ReactElement {
  const [thought, retry] = useTabFetch(
    RESPARKABLE_API.itemPath(RESPARKABLE_API.THOUGHTS, id),
    thoughtSchema
  );

  if (thought.status === 'loading') return <SkeletonList label="Loading note" />;
  if (thought.status === 'error') {
    return <TabLoadError what="this note" message={thought.message} onRetry={retry} />;
  }
  return (
    <NoteEditor
      tabId={tabId}
      id={id}
      initialContent={thought.data.content}
      initialRev={thought.data.rev}
    />
  );
}

function NoteEditor({
  tabId,
  id,
  initialContent,
  initialRev,
}: {
  tabId: string;
  id: string;
  initialContent: string;
  /** Absent only if the row predates `rev`, in which case saves stay last-write-wins. */
  initialRev: number | undefined;
}): React.ReactElement {
  const [content, setContent] = React.useState(initialContent);
  const { state, message, run, reset } = useSaveStatus();
  // Tracks the live editor value rather than the fetched one, so a note being
  // retitled in its first line renames its own tab as you type. `useTabTitle`
  // debounces the write itself: this is the one caller that passes a value
  // changing per keystroke, and the write beneath it serializes the whole
  // workspace tree to localStorage rather than being the plain `useState`
  // update an earlier note here claimed.
  useTabTitle(tabId, titleFromNoteBody(content));
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  // This note's paths in the workspace it opened in, fixed at mount. Saves can
  // run after the editor is gone, by when the address bar may name another one.
  const [paths] = React.useState(() => ({
    note: withActiveSpace(RESPARKABLE_API.itemPath(RESPARKABLE_API.THOUGHTS, id)),
    notes: withActiveSpace(RESPARKABLE_API.THOUGHTS),
  }));
  // False once the editor has closed: a conflict found after that has nobody to ask.
  const mountedRef = React.useRef(true);
  // Tracks the latest content a pending debounce would save, so unmount can
  // flush it — a ref rather than reading `content` in the effect below,
  // since that effect's cleanup only runs once (empty deps) and would
  // otherwise close over the initial, stale value.
  const pendingRef = React.useRef<string | null>(null);
  // The `rev` the next save sends: the one this note opened with, then each
  // save's own answer. A ref because saves are queued and each must read the
  // value the one before it left, not the value at the time it was queued.
  const revRef = React.useRef(initialRev);
  // The text the server held at `revRef`: what this editor opened with, then
  // each save's text. A conflict whose current text is this one changed the
  // row but not the words.
  const baseRef = React.useRef(initialContent);
  // The other version, while this person has not yet chosen. Held twice: the
  // state renders the choice, the ref stops saves already queued from writing.
  const [conflict, setConflict] = React.useState<Conflict | null>(null);
  const conflictRef = React.useRef<Conflict | null>(null);
  // Moves on each settled conflict, so saves queued before it never run after it.
  const generationRef = React.useRef(0);

  function holdConflict(next: Conflict | null): void {
    conflictRef.current = next;
    setConflict(next);
  }

  function patch(next: string, rev: number | undefined): Promise<unknown> {
    return apiClient.patch<unknown>(paths.note, {
      body: rev === undefined ? { content: next } : { content: next, rev },
    });
  }

  /**
   * The row as it stands after a 409. Read from the error when it carries the
   * row, and fetched when it does not, so a conflict always ends in a choice
   * rather than every later save repeating the same stale `rev`.
   */
  async function currentAfterConflict(error: unknown): Promise<Conflict | null> {
    const carried = readConflictCurrent(error, conflictRowSchema);
    if (carried) return carried;
    const row = thoughtSchema.safeParse(await apiClient.get<unknown>(paths.note));
    return row.success && row.data.rev !== undefined
      ? { rev: row.data.rev, content: row.data.content }
      : null;
  }

  /**
   * Sends `next`, following a `rev` that moved without the words changing. A
   * different text on the server is held as a conflict and never written over.
   */
  async function send(next: string): Promise<unknown> {
    let rev = revRef.current;
    for (let attempt = 1; ; attempt++) {
      try {
        return await patch(next, rev);
      } catch (error) {
        if (!isEditConflict(error)) throw error;
        const current = await currentAfterConflict(error);
        if (!current) throw error;
        if (current.content !== baseRef.current) {
          if (!mountedRef.current) {
            await apiClient.post<unknown>(paths.notes, { body: { content: next } });
            return KEPT_AS_NEW_NOTE;
          }
          holdConflict(current);
          throw new HeldConflict();
        }
        if (attempt === MAX_SAVE_ATTEMPTS) throw error;
        rev = current.rev;
      }
    }
  }

  function write(next: string): Promise<boolean> {
    return run(
      async () => {
        const saved = await send(next);
        // The text went to a new note: this note's `rev` and words are unchanged.
        if (saved === KEPT_AS_NEW_NOTE) return;
        const row = savedRowSchema.safeParse(saved);
        if (row.success) revRef.current = row.data.rev;
        baseRef.current = row.success ? row.data.content : next;
      },
      (error) => {
        if (error instanceof HeldConflict) return NOTE_CONFLICT_MESSAGE;
        return error instanceof Error ? error.message : 'Something went wrong';
      }
    );
  }

  function save(next: string): void {
    // A save queued before a conflict was settled carries text the person has
    // since chosen between, so it is dropped rather than sent with the new `rev`.
    const generation = generationRef.current;
    enqueueSave(id, () =>
      conflictRef.current || generation !== generationRef.current ? Promise.resolve() : write(next)
    );
  }

  /**
   * Ends a conflict: stops the pending keystroke save, arms the next save with
   * the other version's `rev`, and hands that version back. `null` if there was
   * no conflict to end.
   */
  function resolveConflict(): Conflict | null {
    const current = conflictRef.current;
    if (!current) return null;
    if (timerRef.current) clearTimeout(timerRef.current);
    pendingRef.current = null;
    revRef.current = current.rev;
    baseRef.current = current.content;
    generationRef.current += 1;
    holdConflict(null);
    return current;
  }

  /** Write this person's text over the other version, deliberately. */
  function saveMine(): void {
    if (resolveConflict()) save(content);
  }

  /** Replace what this person typed with the other version. */
  function takeTheirs(): void {
    const current = resolveConflict();
    if (!current) return;
    setContent(current.content);
    reset();
  }

  // Flushes a still-pending debounced save on unmount instead of just
  // cancelling it — switching tabs, closing the pane, or closing the tab
  // inside the debounce window would otherwise silently drop the last
  // keystrokes, which this app's one rule above all others (never lose a
  // thought) can't accept.
  React.useEffect(() => {
    // Set here as well as at creation: development's double mount runs the
    // cleanup below once before the editor is really in use.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timerRef.current === null) return;
      clearTimeout(timerRef.current);
      if (pendingRef.current !== null) save(pendingRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onChange(next: string): void {
    setContent(next);
    pendingRef.current = next;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      pendingRef.current = null;
      save(next);
    }, SAVE_DEBOUNCE_MS);
  }

  return (
    <div className="flex h-full flex-col gap-2 p-4">
      <Textarea
        value={content}
        onChange={(event) => onChange(event.target.value)}
        className="flex-1 resize-none font-mono text-sm"
        aria-label="Note body"
      />
      <SaveStatus state={state} message={message} />
      {conflict ? (
        <div className="flex gap-2">
          <Button size="sm" onClick={saveMine}>
            Save my version
          </Button>
          <Button size="sm" variant="outline" onClick={takeTheirs}>
            Use their version
          </Button>
        </div>
      ) : null}
    </div>
  );
}
