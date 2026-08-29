'use client';

/**
 * MySharesView — everything you have given away, and the button that takes it
 * back.
 *
 * ## Why this surface exists at all
 *
 * `ShareDialog` is the only place a share can be revoked, and it is only
 * reachable through the entity's own control. That holds until the entity
 * stops being reachable, which happens three ordinary ways (the service
 * docblock lists them: replaced, archived, deleted). Before this page, a link
 * minted on a morning briefing became permanently live the next morning, and
 * the only thing that ever closed it was its own expiry.
 *
 * So the list is keyed on the **share**, not on the entity. That is the whole
 * design: an inventory ordered by the entity would have nowhere to put a share
 * whose entity you can no longer navigate to, which is precisely the row
 * somebody came here for.
 *
 * ## Unreachable first, and the count says how many
 *
 * The server orders gone-then-archived-then-live and the page keeps that order
 * rather than offering a sort. Somebody on this page is nearly always here to
 * close something, and the shares they cannot reach any other way must not sit
 * below the fold. The summary line names the unreachable count for the same
 * reason: it is the number that answers "was anything quietly still open?"
 *
 * ## Revoking is immediate, and it is not a soft action
 *
 * Both `DELETE` routes stamp `revokedAt`, and `resolveResparkableAccess` reads
 * that on every request rather than from a cache, so access ends on the
 * grantee's next request rather than their next session. Revoking the last live
 * link on an entity also flips its `visibility` back to `private`, in the same
 * transaction, which is why the copy says the item stops being public rather
 * than only that the link stops working.
 *
 * The row is removed optimistically and restored on failure, matching every
 * other decision surface in the tier. An unrevoke is not a thing, so the
 * confirmation is a real one: `AlertDialog`, naming what is about to close,
 * exactly as `ArchiveControls` does for the one destructive action it carries.
 */

import * as React from 'react';
import { AlertTriangle, Handshake, Link2, Trash2, UserPlus } from 'lucide-react';

import { EmptyState } from '@/components/resparkable/ui/empty-state';
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
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ClientDate } from '@/components/ui/client-date';
import { apiClient } from '@/lib/api/client';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import type { MyShareItemWire } from '@/lib/framework/resparkable/ui/payloads';

/** What each shareable type is called on screen. Mirrors the reader's list. */
const TYPE_LABEL: Record<string, string> = {
  area: 'Life area',
  goal: 'Goal',
  project: 'Project',
  review: 'Review',
  board: 'Board',
  task: 'Task',
};

export interface MySharesViewProps {
  items: MyShareItemWire[];
}

export function MySharesView({ items }: MySharesViewProps): React.ReactElement {
  const { state, message, run } = useSaveStatus();
  // Revoked ids, held locally so a closed share leaves immediately. Keyed by
  // the share's own id, which is unique across both kinds.
  const [revoked, setRevoked] = React.useState<Set<string>>(() => new Set());

  const revoke = React.useCallback(
    async (kind: 'grant' | 'link', id: string): Promise<void> => {
      setRevoked((current) => new Set(current).add(id));

      const path =
        kind === 'grant'
          ? RESPARKABLE_API.itemPath(RESPARKABLE_API.GRANTS, id)
          : RESPARKABLE_API.itemPath(RESPARKABLE_API.SHARE_LINKS, id);

      const ok = await run(() => apiClient.delete(path));

      if (!ok) {
        // Put it back. A share that looks closed and is not is the one failure
        // this page must never produce.
        setRevoked((current) => {
          const next = new Set(current);
          next.delete(id);
          return next;
        });
      }
    },
    [run]
  );

  const live = items
    .map((item) => ({
      ...item,
      grants: item.grants.filter((grant) => !revoked.has(grant.id)),
      links: item.links.filter((link) => !revoked.has(link.id)),
    }))
    .filter((item) => item.grants.length > 0 || item.links.length > 0);

  const unreachable = live.filter((item) => item.title === null || item.archived).length;

  if (live.length === 0) {
    return (
      <EmptyState
        icon={Handshake}
        title="You have not shared anything"
        description="Shares you create from a project, board, goal, life area, task or review are listed here, so you can close them without going back to the item."
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-muted-foreground text-sm">
          {live.length} {live.length === 1 ? 'thing' : 'things'} shared
          {unreachable > 0 && (
            <>
              {' · '}
              <span className="text-foreground font-medium">
                {unreachable} on {unreachable === 1 ? 'an item' : 'items'} you can no longer open
              </span>
            </>
          )}
        </p>
        <SaveStatus state={state} message={message} />
      </div>

      <ul className="space-y-2">
        {live.map((item) => (
          <li
            key={`${item.entityType}:${item.entityId}`}
            className="bg-card space-y-3 rounded-md border p-3"
          >
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" className="text-[11px]">
                {TYPE_LABEL[item.entityType] ?? item.entityType}
              </Badge>

              {item.title === null ? (
                // Rendered, not dropped. A share whose item is gone is the
                // clearest case of something that needed closing.
                <span className="text-muted-foreground font-medium italic">
                  This item no longer exists
                </span>
              ) : (
                <span className="font-medium">{item.title}</span>
              )}

              {item.archived && (
                <Badge variant="secondary" className="text-[11px]">
                  archived
                </Badge>
              )}

              {(item.title === null || item.archived) && (
                <span className="text-muted-foreground flex items-center gap-1 text-xs">
                  <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                  still shared
                </span>
              )}
            </div>

            {item.grants.map((grant) => (
              <ShareRow
                key={grant.id}
                icon={<UserPlus className="h-3.5 w-3.5" aria-hidden="true" />}
                what={grant.granteeEmail}
                detail={
                  <>
                    {grant.role}
                    {!grant.accepted && ' · not opened yet'}
                    {grant.expiresAt !== null && (
                      <>
                        {' · until '}
                        <ClientDate date={grant.expiresAt} />
                      </>
                    )}
                  </>
                }
                confirmTitle={`Stop sharing with ${grant.granteeEmail}?`}
                confirmBody="They lose access on their next request. Anything they wrote as a comment stays. You can share with them again later, which creates a new invitation."
                onRevoke={() => void revoke('grant', grant.id)}
              />
            ))}

            {item.links.map((link) => (
              <ShareRow
                key={link.id}
                icon={<Link2 className="h-3.5 w-3.5" aria-hidden="true" />}
                what={`Public link ${link.tokenPrefix}…`}
                detail={
                  <>
                    {link.viewCount} {link.viewCount === 1 ? 'view' : 'views'}
                    {link.expiresAt === null ? ' · never expires' : ' · until '}
                    {link.expiresAt !== null && <ClientDate date={link.expiresAt} />}
                  </>
                }
                confirmTitle="Revoke this public link?"
                confirmBody="Anyone holding the link stops being able to open it straight away. If this is the last live link on the item, the item stops being public as well. A revoked link cannot be switched back on: sharing again mints a new one."
                onRevoke={() => void revoke('link', link.id)}
              />
            ))}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** One grant or one link, with its confirmation. */
function ShareRow({
  icon,
  what,
  detail,
  confirmTitle,
  confirmBody,
  onRevoke,
}: {
  icon: React.ReactNode;
  what: string;
  detail: React.ReactNode;
  confirmTitle: string;
  confirmBody: string;
  onRevoke: () => void;
}): React.ReactElement {
  return (
    <div className="flex flex-wrap items-center gap-2 border-t pt-2 text-sm">
      <span className="text-muted-foreground">{icon}</span>
      <span>{what}</span>
      <span className="text-muted-foreground text-xs">{detail}</span>

      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button variant="ghost" size="sm" className="ml-auto" aria-label={`Revoke ${what}`}>
            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmTitle}</AlertDialogTitle>
            <AlertDialogDescription>{confirmBody}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction onClick={onRevoke}>Revoke</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
