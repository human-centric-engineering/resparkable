'use client';

/**
 * ArchiveControls — archive, restore, and (behind a confirmation) destroy.
 *
 * ## Three states, and only one of them destroys anything
 *
 * §11 is the design here, and the API already encodes it: `DELETE` archives, and
 * `?permanent=true` destroys. This component's job is to make that difference
 * visible, because a UI that presents both as "delete" makes the reversible action
 * feel as frightening as the irreversible one — and then people stop archiving and
 * the brain fills up instead.
 *
 * So archiving is a plain button with no confirmation: it is reversible, the copy
 * says so, and a confirmation dialog on a reversible action is just a click tax.
 * Destroying gets an `AlertDialog` that names the thing and says the word
 * "permanently".
 *
 * ## Restoring is not just un-archiving
 *
 * `POST .../restore` nulls `indexedHash`, which is what queues the item to be
 * re-embedded. Archiving deleted its vectors outright (§17 risk 5b), so a restored
 * item is absent from meaning-search until the next indexing pass — findable by
 * wording in the meantime. The copy says that rather than letting someone conclude
 * search is broken.
 */

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Archive, ArchiveRestore, Trash2 } from 'lucide-react';

import { SaveStatus, useSaveStatus } from '@/components/resparkable/ui/save-status';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { useNotifyDataChange } from '@/components/resparkable/workspace/data-change-context';
import { useIsRouteTab } from '@/components/resparkable/workspace/tabs/route-tab-context';
import { useResparkableRefresh } from '@/components/resparkable/workspace/tabs/tab-refresh-context';
import { useOptionalWorkspace } from '@/components/resparkable/workspace/workspace-context';
import { Button } from '@/components/ui/button';
import { resparkableApi, withActiveSpace } from '@/lib/framework/resparkable/api/client';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import { changeTypeForCollection } from '@/lib/framework/resparkable/ui/workspace/change-scope';

export interface ArchiveControlsProps {
  /** One of the `RESPARKABLE_API` collection constants. */
  collection: string;
  id: string;
  /**
   * The record's slug, for a record whose tabs are keyed by it rather than by
   * the id (a board). Lets a permanent delete close those tabs too.
   */
  slug?: string;
  /** Shown in the confirmation, so the dialog names what is about to go. */
  label: string;
  /** Singular noun for the copy — "project", "person", "area". */
  noun: string;
  archived: boolean;
  /**
   * Where to go after a destroy when the surface showing these controls is a
   * page *about* this item, which cannot outlive it. Only the two detail views
   * pass it.
   *
   * It matters on a plain page under `app/`, which would 404 on a refresh, and
   * on the workspace's route-backed tab when the delete is made from that page,
   * whose identity is the URL. Every other tab about the item is closed by the
   * workspace instead (`closeTabsAbout`), whether or not this is set, so a list
   * row needs nothing here.
   */
  redirectTo?: string;
  /**
   * Icon-only, for rows rather than pages.
   *
   * A tree or table with "Delete permanently" spelled out on every row reads as a
   * page about deleting things. The accessible names stay full sentences, so the
   * words are still there for anyone who needs them.
   */
  compact?: boolean;
  onDone?: () => void;
}

export function ArchiveControls({
  collection,
  id,
  slug,
  label,
  noun,
  archived,
  redirectTo,
  compact = false,
  onDone,
}: ArchiveControlsProps): React.ReactElement {
  const router = useRouter();
  const refresh = useResparkableRefresh();
  const notify = useNotifyDataChange();
  const workspace = useOptionalWorkspace();
  const inRouteTab = useIsRouteTab();
  const { state, message, run } = useSaveStatus();

  // Archiving, restoring and deleting all change the same row, and this
  // component is handed a collection rather than a domain noun — so the type
  // is looked up once here rather than at each of the three call sites.
  const changed = changeTypeForCollection(collection);
  const change = changed ? { type: changed, id } : undefined;

  async function archive(): Promise<void> {
    const ok = await run(() => resparkableApi.delete(RESPARKABLE_API.itemPath(collection, id)));
    if (ok) {
      onDone?.();
      refresh(change);
    }
  }

  async function restore(): Promise<void> {
    const ok = await run(() => resparkableApi.post(RESPARKABLE_API.restorePath(collection, id)));
    if (ok) {
      onDone?.();
      refresh(change);
    }
  }

  async function destroy(): Promise<void> {
    const ok = await run(() =>
      resparkableApi.delete(`${RESPARKABLE_API.itemPath(collection, id)}?permanent=true`)
    );
    if (!ok) return;
    onDone?.();

    // A plain page under `app/`, outside the shell. A detail page would 404 on
    // a refresh, so it goes somewhere that still exists; a list refreshes.
    if (!workspace) {
      if (redirectTo) router.push(withActiveSpace(redirectTo));
      else refresh(change);
      return;
    }

    // Inside the workspace, every tab about this record closes, docked or
    // floating, wherever each one is now: not just the one the delete was
    // pressed in, and not wherever this one was when the request went out.
    // It is announced as well, so the lists showing it drop the row. Both are
    // state updates on providers above this component, so React batches them
    // into one render in which the closed tabs are already gone and never
    // refetch into "not found".
    if (change?.id) workspace.closeTabsAbout({ type: change.type, id: change.id, slug });

    // The route-backed tab cannot be closed, because the browser URL *is* that
    // tab, so when the delete came from that page it goes to `redirectTo`.
    // That is known from where this control renders (`RouteTabMarker`), not
    // from the stored tree, which another browser window sharing it may have
    // pointed somewhere else. Navigating changes that tab and nothing
    // else. A route-backed tab about the record but in another pane is left as
    // it is: navigating it would bring it to the front and pull focus there.
    if (inRouteTab && redirectTo) {
      // `notify` rather than `refresh`: with no boundary above the route-backed
      // tab, `refresh` would be a `router.refresh()` into a 404 immediately
      // before the push, flashing the not-found page on the way out.
      if (change) notify(change);
      router.push(withActiveSpace(redirectTo));
      return;
    }

    refresh(change);
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {archived ? (
        <Button
          variant={compact ? 'ghost' : 'outline'}
          size="sm"
          onClick={() => void restore()}
          aria-label={`Restore ${label}`}
        >
          <ArchiveRestore
            className={compact ? 'h-3.5 w-3.5' : 'mr-1.5 h-3.5 w-3.5'}
            aria-hidden="true"
          />
          {!compact && 'Restore'}
        </Button>
      ) : (
        // No confirmation: it is reversible, and gating a reversible action
        // teaches people to fear the safe one.
        <Button
          variant={compact ? 'ghost' : 'outline'}
          size="sm"
          onClick={() => void archive()}
          aria-label={`Archive ${label}`}
        >
          <Archive className={compact ? 'h-3.5 w-3.5' : 'mr-1.5 h-3.5 w-3.5'} aria-hidden="true" />
          {!compact && 'Archive'}
        </Button>
      )}

      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive"
            aria-label={`Delete ${label} permanently`}
          >
            <Trash2 className={compact ? 'h-3.5 w-3.5' : 'mr-1.5 h-3.5 w-3.5'} aria-hidden="true" />
            {!compact && 'Delete permanently'}
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{label}” for good?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the {noun} permanently. Archiving is the reversible option — an archived{' '}
              {noun} stays searchable by wording and can be brought back at any time.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction onClick={() => void destroy()}>Delete permanently</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {archived && !compact && (
        <p className="text-muted-foreground text-xs">
          Restoring re-queues this for indexing, so it comes back to meaning-search after the next
          pass. Until then it is findable by wording.
        </p>
      )}

      <SaveStatus state={state} message={message} />
    </div>
  );
}
