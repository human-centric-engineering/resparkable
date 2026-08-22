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
 */

import * as React from 'react';

import { SaveStatus, useSaveStatus } from '@/components/resparkable/ui/save-status';
import { SkeletonList } from '@/components/resparkable/ui/skeleton';
import { TabLoadError } from '@/components/resparkable/workspace/tabs/tab-load-error';
import { useTabFetch } from '@/components/resparkable/workspace/tabs/use-tab-fetch';
import {
  titleFromNoteBody,
  useTabTitle,
} from '@/components/resparkable/workspace/tabs/use-tab-title';
import { Textarea } from '@/components/ui/textarea';
import { apiClient } from '@/lib/api/client';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import { thoughtSchema } from '@/lib/framework/resparkable/ui/payloads';

/** How long to wait after the last keystroke before writing. */
const SAVE_DEBOUNCE_MS = 800;

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
  return <NoteEditor tabId={tabId} id={id} initialContent={thought.data.content} />;
}

function NoteEditor({
  tabId,
  id,
  initialContent,
}: {
  tabId: string;
  id: string;
  initialContent: string;
}): React.ReactElement {
  const [content, setContent] = React.useState(initialContent);
  const { state, message, run } = useSaveStatus();
  // Tracks the live editor value rather than the fetched one, so a note being
  // retitled in its first line renames its own tab as you type. Debouncing
  // this would be pointless — `setTabTitle` no-ops on an unchanged title, and
  // the write it guards is a `useState` update, not a request.
  useTabTitle(tabId, titleFromNoteBody(content));
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  // Tracks the latest content a pending debounce would save, so unmount can
  // flush it — a ref rather than reading `content` in the effect below,
  // since that effect's cleanup only runs once (empty deps) and would
  // otherwise close over the initial, stale value.
  const pendingRef = React.useRef<string | null>(null);

  function save(next: string): void {
    void run(() =>
      apiClient.patch(RESPARKABLE_API.itemPath(RESPARKABLE_API.THOUGHTS, id), {
        body: { content: next },
      })
    );
  }

  // Flushes a still-pending debounced save on unmount instead of just
  // cancelling it — switching tabs, closing the pane, or closing the tab
  // inside the debounce window would otherwise silently drop the last
  // keystrokes, which this app's one rule above all others (never lose a
  // thought) can't accept.
  React.useEffect(
    () => () => {
      if (timerRef.current === null) return;
      clearTimeout(timerRef.current);
      if (pendingRef.current !== null) save(pendingRef.current);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

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
    </div>
  );
}
