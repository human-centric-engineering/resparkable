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
 * ## Members and requests are two lists
 *
 * A request to join (a `request` join link, phase 57) is a membership row with
 * no `joinedAt`, and it is not a member: it resolves to no scope and cannot read
 * anything. So it is not counted against the cap, not listed as a member, and
 * shown to admins in its own list with the two answers an admin can give.
 *
 * ## Deleting the group
 *
 * Its own section at the bottom, admins only, and never beside "leave": see
 * `delete-group.tsx`. Admin succession itself happens in the erasure hook, but
 * what it would do, and the one setting that changes it, are shown to admins in
 * `group-succession.tsx`.
 *
 * ## Not on the space-carrying client
 *
 * These routes are keyed on the actor and the group id, and read no `?space=`.
 * See `groups-view.tsx`'s header.
 */

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Check, Mail, UserMinus, X } from 'lucide-react';

import { DeleteGroup } from '@/components/resparkable/groups/delete-group';
import { GroupBudget } from '@/components/resparkable/groups/group-budget';
import { GroupJoinLinks } from '@/components/resparkable/groups/group-join-links';
import { GroupSuccession } from '@/components/resparkable/groups/group-succession';
import { SaveStatus, useSaveStatus } from '@/components/resparkable/ui/save-status';
import { Button } from '@/components/ui/button';
import { ClientDate } from '@/components/ui/client-date';
import { FieldHelp } from '@/components/ui/field-help';
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
import type {
  GroupBudgetWire,
  GroupDetailWire,
  GroupInviteWire,
  GroupJoinLinkWire,
} from '@/lib/framework/resparkable/ui/payloads';
import { RESPARKABLE_ROUTES } from '@/lib/framework/resparkable/ui/routes';

/** The three a group has. `owner` is deliberately absent (§23.2). */
const ROLES = ['admin', 'member', 'viewer'] as const;

export interface GroupDetailProps {
  detail: GroupDetailWire;
  invites: GroupInviteWire[];
  /** The group's join links. Admins only; empty for everybody else. */
  joinLinks: GroupJoinLinkWire[];
  /** The group's credits, or `null` when they could not be read. */
  budget: GroupBudgetWire | null;
  /** The signed-in user, so the member list can say which row is you. */
  viewerUserId: string;
}

export function GroupDetail({
  detail,
  invites: initialInvites,
  joinLinks,
  budget,
  viewerUserId,
}: GroupDetailProps): React.ReactElement {
  const router = useRouter();
  const [allMembers, setMembers] = React.useState(detail.members);
  const members = allMembers.filter((member) => member.joinedAt !== null);
  const requests = allMembers.filter((member) => member.joinedAt === null);
  const [invites, setInvites] = React.useState(initialInvites);
  const [maxMembers, setMaxMembers] = React.useState(detail.group.maxMembers);
  const [limitDraft, setLimitDraft] = React.useState(String(detail.group.maxMembers));
  const [refusedFullAt, setRefusedFullAt] = React.useState(detail.group.joinRefusedFullAt);
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
    const previous = allMembers;
    setMembers((prev) => prev.map((row) => (row.userId === userId ? { ...row, role } : row)));

    const ok = await run(() =>
      apiClient.patch(RESPARKABLE_API.groupMember(groupId, userId), { body: { role } })
    );
    // The service refuses demoting the last admin, and the message it returns
    // says why. Rolling back is what makes that message true on screen.
    if (!ok) setMembers(previous);
  }

  async function remove(userId: string): Promise<void> {
    const previous = allMembers;
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

  /**
   * Change the member limit. The server clears the "turned away" notice on any
   * change, whichever way it moved, so the page does the same on success.
   */
  async function saveLimit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const next = Number(limitDraft);
    if (!Number.isInteger(next) || next === maxMembers) return;

    const ok = await run(() =>
      apiClient.patch(RESPARKABLE_API.group(groupId), { body: { maxMembers: next } })
    );
    if (ok) {
      setMaxMembers(next);
      setRefusedFullAt(null);
    } else {
      setLimitDraft(String(maxMembers));
    }
  }

  async function answerRequest(userId: string, approve: boolean): Promise<void> {
    const previous = allMembers;
    const now = new Date().toISOString();
    setMembers((prev) =>
      approve
        ? prev.map((row) => (row.userId === userId ? { ...row, joinedAt: now } : row))
        : prev.filter((row) => row.userId !== userId)
    );

    const url = RESPARKABLE_API.groupJoinRequest(groupId, userId);
    const ok = await run(() => (approve ? apiClient.post(url) : apiClient.delete(url)));
    // A full group refuses the approval, and the message says so. Rolling back
    // is what keeps the request on screen for the admin to answer later.
    if (!ok) setMembers(previous);
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
          Members ({members.length} of {maxMembers})
        </h3>
        {isAdmin && (
          <form className="mb-2 flex items-end gap-2" onSubmit={(event) => void saveLimit(event)}>
            <div>
              <label
                className="text-muted-foreground mb-1 flex items-center gap-1 text-xs"
                htmlFor="group-member-limit"
              >
                Member limit
                <FieldHelp title="Member limit">
                  <p>
                    The most people who can be in the group. Somebody using a join link when the
                    group is full is turned away, and you are told here.
                  </p>
                  <p>It does not stop you inviting somebody by email.</p>
                </FieldHelp>
              </label>
              <Input
                id="group-member-limit"
                type="number"
                min={1}
                max={500}
                inputMode="numeric"
                className="h-8 w-20"
                value={limitDraft}
                onChange={(event) => setLimitDraft(event.target.value)}
              />
            </div>
            <Button
              type="submit"
              size="sm"
              variant="outline"
              disabled={Number(limitDraft) === maxMembers || state === 'saving'}
            >
              Save
            </Button>
          </form>
        )}
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

      {/* Only while the group is still full: once there is room, by either route
          the notice suggests, it has nothing left to ask of the admin. */}
      {isAdmin && refusedFullAt !== null && members.length >= maxMembers && (
        <p className="border-border/60 rounded-md border px-3 py-2 text-xs">
          Somebody was turned away because the group is full, most recently on{' '}
          <ClientDate date={refusedFullAt} />. To make room, raise the member limit or remove
          someone.
        </p>
      )}

      {isAdmin && requests.length > 0 && (
        <section>
          <h3 className="mb-2 text-sm font-medium">Asking to join ({requests.length})</h3>
          <p className="text-muted-foreground mb-2 text-[11px]">
            They clicked a join link that needs an admin to let them in. They cannot see anything in
            the group until you do.
          </p>
          <ul className="flex flex-col gap-1.5">
            {requests.map((request) => (
              <li
                key={request.userId}
                className="border-border/60 flex items-center justify-between gap-3 rounded-md border px-3 py-2"
              >
                <span className="min-w-0 truncate text-sm">
                  {request.name ?? 'An account with no name'}
                  <span className="text-muted-foreground ml-2 text-[11px] capitalize">
                    {request.role}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-1">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void answerRequest(request.userId, true)}
                  >
                    <Check className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                    Let in
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void answerRequest(request.userId, false)}
                    aria-label={`Turn down ${request.name ?? 'this request'}`}
                  >
                    <X className="h-3.5 w-3.5" aria-hidden="true" />
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h3 className="mb-2 flex items-center gap-1.5 text-sm font-medium">
          This week
          <FieldHelp title="The weekly digest">
            <p>
              Every Monday morning the group gets a short digest of its week: what moved, what
              arrived, what went quiet and what nobody has picked up yet.
            </p>
            <p>
              It is about the work, never the people. It does not say who did what, and it never
              compares anyone. A week where nothing happened gets no digest and costs nothing.
            </p>
          </FieldHelp>
        </h3>
        {detail.latestDigest ? (
          <article className="border-border/60 rounded-md border px-3 py-2">
            <p className="text-sm font-medium">{detail.latestDigest.title}</p>
            <p className="text-muted-foreground mt-1 text-sm whitespace-pre-wrap">
              {detail.latestDigest.body}
            </p>
          </article>
        ) : (
          <p className="text-muted-foreground text-xs">
            No digest yet. The first arrives on the Monday after the group has had a week of
            activity.
          </p>
        )}
      </section>

      {budget && (
        // Keyed on the group-wide settings only: a refresh that brings one
        // another admin changed replaces the form. Figures, members and caps
        // are followed in place, so a refresh after a role change or a cap save
        // leaves anything half-typed alone.
        <GroupBudget
          key={JSON.stringify([
            budget.fundingMode,
            budget.admin?.lowBalanceAlertCredits ?? null,
            budget.admin?.largeRunAlertPercent ?? null,
          ])}
          groupId={groupId}
          budget={budget}
          yourRole={detail.yourRole}
          viewerUserId={viewerUserId}
        />
      )}

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

      {isAdmin && <GroupJoinLinks groupId={groupId} links={joinLinks} />}

      <SaveStatus state={state} message={message} />

      {isAdmin && (
        <GroupSuccession
          groupId={groupId}
          members={members}
          viewerUserId={viewerUserId}
          viewersCanInheritAdmin={detail.group.viewersCanInheritAdmin}
        />
      )}

      {isAdmin && (
        <DeleteGroup
          groupId={groupId}
          groupName={detail.group.name}
          otherMemberCount={
            members.filter((member) => member.userId !== viewerUserId && member.joinedAt !== null)
              .length
          }
        />
      )}
    </div>
  );
}
