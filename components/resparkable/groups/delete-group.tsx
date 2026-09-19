'use client';

/**
 * Delete a group: admin only, behind the group's name typed back (§23.6).
 *
 * ## Not a menu item beside "leave"
 *
 * Leaving takes one person out; deleting takes a workspace away from everyone
 * in it. They sit in different places on the page for that reason, and this one
 * is its own section at the bottom rather than a button in the member list.
 *
 * ## The confirmation is the server's, not this dialog's
 *
 * The button stays disabled until the name matches, which is a convenience.
 * The rule is `services/group-deletion.ts`'s, which checks the same name and
 * refuses a mismatch whatever sent it. If the two ever disagree (the group was
 * renamed while the dialog was open, say) the server's answer is shown and the
 * dialog stays open.
 */

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Trash2 } from 'lucide-react';

import { SaveStatus, useSaveStatus } from '@/components/resparkable/ui/save-status';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { apiClient } from '@/lib/api/client';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import { RESPARKABLE_ROUTES } from '@/lib/framework/resparkable/ui/routes';

export interface DeleteGroupProps {
  groupId: string;
  groupName: string;
  /** Joined members other than the viewer: the people who will be emailed. */
  otherMemberCount: number;
}

export function DeleteGroup({
  groupId,
  groupName,
  otherMemberCount,
}: DeleteGroupProps): React.ReactElement {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [typed, setTyped] = React.useState('');
  const { state, message, run } = useSaveStatus();

  // Mirrors `confirmationMatches` on the server: surrounding spaces forgiven,
  // case not.
  const matches = typed.trim() === groupName.trim();

  async function destroy(): Promise<void> {
    const ok = await run(() =>
      apiClient.delete(RESPARKABLE_API.group(groupId), { body: { confirmName: typed } })
    );
    if (!ok) return;

    setOpen(false);
    // The workspace is gone, so the switcher must lose it too.
    router.push(RESPARKABLE_ROUTES.GROUPS);
    router.refresh();
  }

  function onOpenChange(next: boolean): void {
    setOpen(next);
    if (!next) setTyped('');
  }

  const others =
    otherMemberCount === 0
      ? 'Nobody else is in this group.'
      : otherMemberCount === 1
        ? 'The other member will get an email saying you deleted it.'
        : `The other ${otherMemberCount} members will each get an email saying you deleted it.`;

  return (
    <section className="border-destructive/40 rounded-md border p-3">
      <h3 className="text-sm font-medium">Delete this group</h3>
      <p className="text-muted-foreground mt-1 mb-3 text-xs">
        Removes the group workspace and everything in it, for everyone. This cannot be undone.
      </p>

      <AlertDialog open={open} onOpenChange={onOpenChange}>
        <AlertDialogTrigger asChild>
          <Button variant="outline" size="sm" className="text-destructive">
            <Trash2 className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
            Delete group
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{groupName}”?</AlertDialogTitle>
            <AlertDialogDescription>
              Everything in this group workspace will be deleted, including what other members
              added. It cannot be restored. {others}
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div>
            <label
              className="text-muted-foreground mb-1 block text-xs"
              htmlFor="confirm-group-name"
            >
              Type <strong className="text-foreground">{groupName}</strong> to confirm
            </label>
            <Input
              id="confirm-group-name"
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </div>

          <SaveStatus state={state} message={message} />

          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            {/* A plain button rather than `AlertDialogAction`, which closes the
                dialog on click: a refusal from the server has to stay on screen. */}
            <Button
              variant="destructive"
              disabled={!matches || state === 'saving'}
              onClick={() => void destroy()}
            >
              Delete group
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
