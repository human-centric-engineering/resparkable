'use client';

/**
 * useTabTitle — names a tab from the content it just loaded.
 *
 * The four detail kinds (`project`, `entity`, `board`, `note`) open with the
 * registry's generic `defaultTitle` ("Project", "Person", "Board", "Note")
 * because that is all that is known before the fetch resolves. Three Project
 * tabs open side by side were therefore three tabs all labelled "Project",
 * which is a tab strip you cannot navigate. This writes the real name back
 * onto `TabState.title` the moment it is known.
 *
 * Called unconditionally with `null` while the fetch is still in flight — a
 * hook can't sit behind the adapters' early `return`s for the loading and
 * error states, and "no title yet" is a legitimate value rather than a reason
 * to skip the effect.
 *
 * The write goes through `setTabTitle`, which no-ops when the title already
 * matches, so this settles after exactly one render rather than looping: the
 * effect writes, the context returns the same state, nothing re-renders.
 *
 * ## Why the write is debounced
 *
 * "No-ops" is true of the *reducer* and not of the write beneath it.
 * `setTabTitle` goes through `WorkspaceProvider`'s `useLocalStorage` setter,
 * which serializes the entire workspace tree and dispatches a sync event
 * whether or not the reducer changed anything — and that event's own listener
 * re-parses the tree into a fresh object, re-rendering every pane and floating
 * panel.
 *
 * For the three fetch-driven callers that costs nothing: their title changes
 * once, when the fetch lands. `NoteTab` is the exception and the reason this
 * exists — it passes the *live editor value*, so a note being retitled in its
 * first line paid that whole-tree round trip on every keystroke. The delay is
 * short enough to read as immediate on a tab strip nobody is looking at while
 * typing, and the trailing edge always wins, so the settled title is exact.
 */

import * as React from 'react';

import { useWorkspace } from '@/components/resparkable/workspace/workspace-context';

/** Longer than this and a tab is wider than the strip — the strip truncates visually too. */
const MAX_TITLE_LENGTH = 60;

/** Long enough to coalesce a burst of typing, short enough to feel immediate. */
const TITLE_DEBOUNCE_MS = 300;

export function useTabTitle(tabId: string, title: string | null | undefined): void {
  const { setTabTitle } = useWorkspace();
  /**
   * The title a pending debounce would have written. Read only by the
   * unmount flush below, which is why it is a ref rather than state.
   */
  const pendingRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    const trimmed = title?.trim();
    if (!trimmed) return;
    const next = trimmed.slice(0, MAX_TITLE_LENGTH);
    pendingRef.current = next;
    const timer = setTimeout(() => {
      pendingRef.current = null;
      setTabTitle(tabId, next);
    }, TITLE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [setTabTitle, tabId, title]);

  // Flush on unmount rather than dropping the pending write. `TabContent`
  // renders only the *active* tab, so switching tabs within the debounce
  // window unmounts this hook — without the flush, typing a note's first line
  // and immediately clicking a sibling tab left the strip still saying "Note".
  // Empty deps, so this runs on real unmount only; the mutable ref is what
  // lets its cleanup see the latest title rather than the first one.
  React.useEffect(
    () => () => {
      if (pendingRef.current !== null) setTabTitle(tabId, pendingRef.current);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- unmount-only by design; see above
    []
  );
}

/**
 * A note's title, since a thought has no name field — its first non-empty
 * line, with any leading Markdown heading marks stripped so a note that opens
 * `# Kickoff notes` is titled "Kickoff notes" rather than "# Kickoff notes".
 * `null` for an empty note, which keeps the generic "Note" default.
 */
export function titleFromNoteBody(content: string): string | null {
  const firstLine = content
    .split('\n')
    .map((line) => line.replace(/^#{1,6}\s*/, '').trim())
    .find((line) => line.length > 0);
  return firstLine ?? null;
}
