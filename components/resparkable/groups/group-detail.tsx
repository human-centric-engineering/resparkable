'use client';

/**
 * One group: who is in it, who has been invited, and the way out.
 *
 * ## Reuse rather than rebuild
 *
 * Three patterns already exist in this tier and all three apply here, which is
 * why this file is short for what it does. `ShareDialog`'s grants half is
 * already an invite-a-person-with-a-role form. `MySharesView` is the
 * list-with-revoke pattern, optimistic with a rollback. `AcceptInvite` plus the
 * token page is the whole token-to-session-to-bind flow, and phase 46 shipped
 * the group version of it.
 *
 * ## An invitation grants nothing until it is accepted
 *
 * That is the difference between this and a share invite, and it is why there
 * are two lists below rather than one. A grant is live from the moment it is
 * written, so its invite is a row on the same object; a group invitation must
 * grant nothing until accepted, because membership is write access to an entire
 * brain. Two objects, two lifetimes, two lists.
 *
 * ## What is not here yet
 *
 * Deleting a group, and admin succession when the last admin is erased. Both
 * are phase 48's, and both need more than a button: a typed confirmation and a
 * notification to every member, because deleting a group destroys a workspace
 * several people were writing into.
 *
 * ## Not on the space-carrying client
 *
 * These routes are keyed on the actor and the group id, and read no `?space=`.
 * See `groups-view.tsx`'s header.
 */

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Mail, UserMinus, X } from 'lucide-react';

import { SaveStatus, useSaveStatus } from '@/components/resparkable/ui/save-status';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { apiClient } from '@/lib/api/client';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import type { GroupDetailWire, GroupInviteWire } from '@/lib/framework/resparkable/ui/payloads';
import { RESPARKABLE_ROUTES } from '@/lib/framework/resparkable/ui/routes';

/** The three a group has. `owner` is deliberately absent (§23.2). */
const ROLES = ['admin', 'member', 'viewer'] as const;

export interface GroupDetailProps {
  detail: GroupDetailWire;
  invites: GroupInviteWire[];
  /** The signed-in user, so the member list can say which row is you. */
  viewerUserId: string;
}

export function GroupDetail({
  detail,
  invites: initialInvites,
  viewerUserId,
}: GroupDetailProps): React.ReactElement {
  const router = useRouter();
  const [members, setMembers] = React.useState(detail.members);
  const [invites, setInvites] = React.useState(initialInvites);
  const [email, setEmail] = React.useState('');
  const [inviteRole, setInviteRole] = React.useState<string>('member');
  const { state, message, run } = useSaveStatus();

  const isAdmin = detail.yourRole === 'admin';
  const groupId = detail.group.groupId;

  async function invite(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const address = email.trim();
    if (!address) return;

    const box: { invite: { inviteId: string; sent: boolean } | null } = { invite: null };
    const ok = await run(async () => {
      box.invite = await apiClient.post(RESPARKABLE_API.groupInvites(groupId), {
        body: { email: address, role: inviteRole },
      });
    });

    const created = box.invite;
    if (ok && created) {
      setEmail('');
      setInvites((prev) => [
        ...prev,
        {
          id: created.inviteId,
          email: address,
          role: inviteRole,
          invitedAt: new Date().toISOString(),
          expiresAt: null,
          revokedAt: null,
          acceptedAt: null,
        },
      ]);
    }
  }

  async function revokeInvite(inviteId: string): Promise<void> {
    const previous = invites;
    // Optimistic, with a real rollback. The list is small and the action is
    // final, so seeing it go is worth more than waiting to be told.
    setInvites((prev) => prev.filter((row) => row.id !== inviteId));

    const ok = await run(() => apiClient.delete(RESPARKABLE_API.groupInvite(groupId, inviteId)));
    if (!ok) setInvites(previous);
  }

  async function changeRole(userId: string, role: string): Promise<void> {
    const previous = members;
    setMembers((prev) => prev.map((row) => (row.userId === userId ? { ...row, role } : row)));

    const ok = await run(() =>
      apiClient.patch(RESPARKABLE_API.groupMember(groupId, userId), { body: { role } })
    );
    // The service refuses demoting the last admin, and the message it returns
    // says why. Rolling back is what makes that message true on screen.
    if (!ok) setMembers(previous);
  }

  async function remove(userId: string): Promise<void> {
    const previous = members;
    setMembers((prev) => prev.filter((row) => row.userId !== userId));

    const ok = await run(() => apiClient.delete(RESPARKABLE_API.groupMember(groupId, userId)));
    if (!ok) {
      setMembers(previous);
      return;
    }

    // Leaving takes the workspace with you, so the page you are on stops being
    // yours to look at. Back to the list, and a refresh so the header switcher
    // loses the entry rather than offering a workspace that now 404s.
    if (userId === viewerUserId) {
      router.push(RESPARKABLE_ROUTES.GROUPS);
      router.refresh();
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h2 className="font-display text-base font-semibold">{detail.group.name}</h2>
        {detail.group.description && (
          <p className="text-muted-foreground mt-1 text-sm">{detail.group.description}</p>
        )}
        <p className="text-muted-foreground mt-1 text-[11px]">
          You are {detail.yourRole === 'admin' ? 'an admin' : `a ${detail.yourRole}`} here.
        </p>
      </header>

      <section>
        <h3 className="mb-2 text-sm font-medium">
          Members ({members.length} of {detail.group.maxMembers})
        </h3>
        <ul className="flex flex-col gap-1.5">
          {members.map((member) => {
            const isYou = member.userId === viewerUserId;
            return (
              <li
                key={member.userId}
                className="border-border/60 flex items-center justify-between gap-3 rounded-md border px-3 py-2"
              >
                <span className="min-w-0 truncate text-sm">
                  {/* Ids rather than addresses, deliberately: every member can
                      see who else is in the group, which §23.4 makes
                      unavoidable, but handing out everybody's email is a
                      separate decision nobody made. */}
                  {isYou ? 'You' : member.userId}
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  {isAdmin && !isYou ? (
                    <Select
                      value={member.role}
                      onValueChange={(next) => void changeRole(member.userId, next)}
                    >
                      <SelectTrigger
                        className="h-7 w-28 text-xs"
                        aria-label={`Role for ${member.userId}`}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {ROLES.map((role) => (
                          <SelectItem key={role} value={role}>
                            {role}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <span className="text-muted-foreground text-[11px] capitalize">
                      {member.role}
                    </span>
                  )}

                  {(isAdmin || isYou) && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void remove(member.userId)}
                      aria-label={isYou ? 'Leave this group' : `Remove ${member.userId}`}
                    >
                      <UserMinus className="h-3.5 w-3.5" aria-hidden="true" />
                      {isYou ? 'Leave' : null}
                    </Button>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      </section>

      {isAdmin && (
        <section>
          <h3 className="mb-2 text-sm font-medium">Invitations</h3>

          <form className="mb-3 flex items-end gap-2" onSubmit={(event) => void invite(event)}>
            <div className="flex-1">
              <label className="text-muted-foreground mb-1 block text-xs" htmlFor="invite-email">
                Email address
              </label>
              <Input
                id="invite-email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="them@example.com"
              />
            </div>
            <Select value={inviteRole} onValueChange={setInviteRole}>
              <SelectTrigger className="h-9 w-28 text-xs" aria-label="Role for this invitation">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ROLES.map((role) => (
                  <SelectItem key={role} value={role}>
                    {role}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button type="submit" size="sm" disabled={!email.trim() || state === 'saving'}>
              <Mail className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
              Invite
            </Button>
          </form>

          {/* The sentence that makes the two lists make sense. */}
          <p className="text-muted-foreground mb-2 text-[11px]">
            An invitation gives no access until the person opens it and accepts. You can withdraw it
            until then.
          </p>

          {invites.length === 0 ? (
            <p className="text-muted-foreground text-xs">Nobody is waiting on an invitation.</p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {invites.map((row) => (
                <li
                  key={row.id}
                  className="border-border/60 flex items-center justify-between gap-3 rounded-md border px-3 py-2"
                >
                  <span className="min-w-0 truncate text-sm">{row.email}</span>
                  <span className="flex shrink-0 items-center gap-2">
                    <span className="text-muted-foreground text-[11px] capitalize">{row.role}</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void revokeInvite(row.id)}
                      aria-label={`Withdraw the invitation to ${row.email}`}
                    >
                      <X className="h-3.5 w-3.5" aria-hidden="true" />
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <SaveStatus state={state} message={message} />
    </div>
  );
}
