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
 */

import * as React from 'react';

import { useWorkspace } from '@/components/resparkable/workspace/workspace-context';

/** Longer than this and a tab is wider than the strip — the strip truncates visually too. */
const MAX_TITLE_LENGTH = 60;

export function useTabTitle(tabId: string, title: string | null | undefined): void {
  const { setTabTitle } = useWorkspace();

  React.useEffect(() => {
    const trimmed = title?.trim();
    if (!trimmed) return;
    setTabTitle(tabId, trimmed.slice(0, MAX_TITLE_LENGTH));
  }, [setTabTitle, tabId, title]);
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
