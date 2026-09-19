'use client';

/**
 * What happens to the admin role if an admin closes their account, and the
 * one setting that changes it. Admins only.
 *
 * ## Why the page says it, and not only the email
 *
 * The email goes once, when somebody first becomes the only admin
 * (`services/sole-admin-notice.ts`), and names nobody, because by the time it
 * is read the answer may have changed. This section answers the same question
 * live: it runs `planErasureSuccession`, the rule the erasure hook and the sweep
 * run, over the members on screen, so it names who would inherit today and
 * changes as roles change.
 *
 * ## The setting
 *
 * `viewersCanInheritAdmin`. On by default, which is the behaviour every group
 * had before the setting existed. Off means an admin has chosen, knowingly, that
 * a group left with only viewers keeps no admin at all. The help text says what
 * that costs, because nothing on the page afterwards will.
 */

import * as React from 'react';

import { SaveStatus, useSaveStatus } from '@/components/resparkable/ui/save-status';
import { FieldHelp } from '@/components/ui/field-help';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { apiClient } from '@/lib/api/client';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import { planErasureSuccession } from '@/lib/framework/resparkable/services/succession';
import type { GroupDetailWire } from '@/lib/framework/resparkable/ui/payloads';

export interface GroupSuccessionProps {
  groupId: string;
  /** The page's live member list, so the notice follows role changes. */
  members: GroupDetailWire['members'];
  viewerUserId: string;
  viewersCanInheritAdmin: boolean;
}

export function GroupSuccession({
  groupId,
  members,
  viewerUserId,
  viewersCanInheritAdmin: initial,
}: GroupSuccessionProps): React.ReactElement {
  const [viewersCanInheritAdmin, setViewersCanInheritAdmin] = React.useState(initial);
  const { state, message, run } = useSaveStatus();

  const joinedAdmins = members.filter(
    (member) => member.role === 'admin' && member.joinedAt !== null
  );
  const soleAdmin = joinedAdmins.length === 1 && joinedAdmins[0].userId === viewerUserId;

  async function toggle(next: boolean): Promise<void> {
    setViewersCanInheritAdmin(next);
    const ok = await run(() =>
      apiClient.patch(RESPARKABLE_API.group(groupId), { body: { viewersCanInheritAdmin: next } })
    );
    if (!ok) setViewersCanInheritAdmin(!next);
  }

  return (
    <section>
      <h3 className="mb-2 text-sm font-medium">If you close your account</h3>

      {soleAdmin && (
        <p className="border-border/60 bg-muted/40 mb-3 rounded-md border px-3 py-2 text-sm">
          <SoleAdminNotice
            members={members}
            viewerUserId={viewerUserId}
            viewersCanInheritAdmin={viewersCanInheritAdmin}
          />
        </p>
      )}

      <div className="flex items-center gap-2">
        <Switch
          id="viewers-can-inherit-admin"
          checked={viewersCanInheritAdmin}
          onCheckedChange={(next) => void toggle(next)}
          disabled={state === 'saving'}
        />
        <Label htmlFor="viewers-can-inherit-admin" className="font-normal">
          A viewer can become admin
        </Label>
        <FieldHelp title="Who becomes admin">
          <p>
            When the last admin closes their account, the person who has been in the group longest
            becomes admin.
          </p>
          <p>
            On, that can be a viewer. Off, viewers are skipped. If only viewers are left, nobody
            becomes admin: the group can still be read, but nobody can invite people, change roles
            or delete it.
          </p>
          <p>If someone who is not a viewer joins later, they become admin within the hour.</p>
        </FieldHelp>
      </div>

      <SaveStatus state={state} message={message} />
    </section>
  );
}

/** The sentence a sole admin reads, from the same rule erasure runs. */
function SoleAdminNotice({
  members,
  viewerUserId,
  viewersCanInheritAdmin,
}: {
  members: GroupDetailWire['members'];
  viewerUserId: string;
  viewersCanInheritAdmin: boolean;
}): React.ReactElement | null {
  const plan = planErasureSuccession(members, viewerUserId, { viewersCanInheritAdmin });

  switch (plan.kind) {
    case 'delete':
      return (
        <>
          You are the only member. If you close your account, this group and everything in it will
          be deleted.
        </>
      );
    case 'promote': {
      const successor = members.find((member) => member.userId === plan.userId);
      return (
        <>
          You are the only admin. If you close your account, {plan.userId} will become admin,
          because they have been in the group longest
          {successor?.role === 'viewer' ? ', even though they are a viewer' : ''}. To choose someone
          yourself, make them an admin now.
        </>
      );
    }
    case 'no_admin':
      return (
        <>
          You are the only admin. If you close your account, nobody will become admin, because only
          viewers are left and viewers are skipped here. Nobody would be able to invite people,
          change roles or delete the group. To avoid that, make someone else an admin now.
        </>
      );
    default:
      // `unchanged` needs another admin, and this only renders for a sole one.
      return null;
  }
}
