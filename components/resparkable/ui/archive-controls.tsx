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
import { useOptionalTabClose } from '@/components/resparkable/workspace/tabs/tab-close-context';
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
  /** Shown in the confirmation, so the dialog names what is about to go. */
  label: string;
  /** Singular noun for the copy — "project", "person", "area". */
  noun: string;
  archived: boolean;
  /**
   * Set this when the surface rendering these controls is *about* this item:
   * a detail view rather than a row in a list.
   *
   * It carries a URL because that is what a plain page under `app/` needs
   * after a destroy, but the flag matters more than the destination: it is
   * what tells `destroy()` that the surface should not outlive the item. Left
   * unset, a destroy refreshes and the surface stays, which is what a list
   * wants. Set, and inside the workspace the tab closes instead.
   *
   * Only the two detail views pass it. Setting it on a list row would close
   * the list tab when a row is deleted.
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
  const closeSelf = useOptionalTabClose();
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

    // Four situations, and `redirectTo` is what separates the first from the
    // rest. It marks "this surface is *about* the thing just deleted"; only
    // the two detail views pass it. A list row deleted from a list must leave
    // the list alone; the surface outlives the row.
    if (!redirectTo) {
      refresh(change);
      return;
    }

    // A launcher-opened or floating detail tab. Tested before `workspace`
    // because it is the stronger signal: something knowing how to close this
    // tab means there is a tab to close, whatever else is or isn't above.
    //
    // Announce first so panes showing the same thing catch up, then close this
    // one. Both are state updates on providers above this component, so React
    // batches them into one render in which the tab is already gone: the
    // refetch that used to leave it sitting on its "not found" empty state
    // never runs.
    if (closeSelf) {
      refresh(change);
      closeSelf();
      return;
    }

    // A plain page under `app/`, outside the shell. It would 404 on a refresh,
    // so it goes somewhere that still exists.
    if (!workspace) {
      router.push(withActiveSpace(redirectTo));
      return;
    }

    // The route-backed tab. The browser URL *is* this tab, so navigating
    // changes this tab and nothing else. Pane-local, which is what the old
    // blanket "never push inside the workspace" rule could not express.
    // `notify` rather than `refresh`: with no boundary above it, `refresh`
    // would be a `router.refresh()` into a 404 immediately before the push,
    // flashing the not-found page on the way out.
    // Guarded because `change` is undefined for a collection with no mapped
    // change type: `refresh` takes that as "no announcement", `notify` does not.
    if (change) notify(change);
    router.push(withActiveSpace(redirectTo));
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
