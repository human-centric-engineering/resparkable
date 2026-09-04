/**
 * Which workspaces a person can open, in the order the switcher shows them.
 *
 * ## Why this is one list and not two
 *
 * §24.2 is explicit that personal and group workspaces "sit in the same
 * switcher, grouped and labelled by kind", and the reason is worth keeping
 * next to the code: a member should not have to know whose a workspace is in
 * order to open it. What differs after opening is the role, the capture default
 * and, later, the billing account. None of those is a different way in, so
 * none of them earns a second control.
 *
 * ## Personal is always first, and always present
 *
 * Even for somebody whose account has never touched Resparkable and therefore
 * has no space row yet. A switcher whose first entry appears only after you
 * have used the product is a switcher that is missing on the one day it would
 * be most confusing to be missing. So the personal entry is synthesised from
 * the user id when there is no row: the id IS the space key (phase 45), and
 * `ensureResparkableSpace` will write the row on first use anyway.
 *
 * Creating the row here instead was the alternative and is worse: reading a
 * list would then be a write, and rendering the shell would create a space for
 * every visitor who bounced.
 *
 * ## What this is not
 *
 * Not an authority. Nothing downstream trusts this list: a caller who asks for
 * a workspace still goes through `resolveActiveSpaceScope`, which reads
 * membership. This is what the switcher renders, and a stale entry in it
 * resolves to a 404 rather than to a read.
 *
 * @see .context/framework/resparkable/plan.md: §24.2
 */

import type { SpaceRole } from '@/lib/framework/resparkable/repo/space-scope';
import { listGroupsForActor } from '@/lib/framework/resparkable/services/membership';
import { getResparkableSpace } from '@/lib/framework/resparkable/services/space';

/** One row of the switcher. */
export interface OpenableSpace {
  /** The `?space=` value. For a personal space this is the owner's user id. */
  spaceId: string;
  /** What the switcher shows. Never null: an unnamed personal space is "Personal". */
  name: string;
  kind: 'personal' | 'group';
  /** What the actor may do in it. `owner` on a personal space, never on a group. */
  role: SpaceRole;
  /**
   * The group behind a group workspace, so the switcher can link to its member
   * list without a second lookup. Null for personal.
   */
  groupId: string | null;
}

/**
 * Every workspace this person can open: their own, then their groups by name.
 *
 * Two queries, both indexed, and neither of them a join across brain content.
 * The switcher renders on every surface, so this is on the path of every page
 * in the product and is meant to stay that cheap.
 */
export async function listOpenableSpaces(actorUserId: string): Promise<OpenableSpace[]> {
  if (!actorUserId) return [];

  const [space, memberships] = await Promise.all([
    getResparkableSpace(actorUserId),
    listGroupsForActor(actorUserId),
  ]);

  const personal: OpenableSpace = {
    spaceId: actorUserId,
    name: space?.name ?? 'Personal',
    kind: 'personal',
    role: 'owner',
    groupId: null,
  };

  const groups: OpenableSpace[] = memberships
    // A pending row is a request to join, not a workspace you can open. Showing
    // it and 404ing on the click would be a worse answer than not showing it.
    .filter((membership) => membership.joinedAt !== null)
    .map((membership) => ({
      spaceId: membership.group.spaceId,
      name: membership.group.name,
      kind: 'group' as const,
      role: asSpaceRole(membership.role),
      groupId: membership.groupId,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return [personal, ...groups];
}

/**
 * A stored role the code does not recognise reads as `viewer` HERE and only
 * here, because this list decides what a label says and nothing else. The
 * refusal that matters happens in `resolveGroupSpaceScope`, which returns no
 * scope at all for the same value; a switcher entry that renders and then 404s
 * on the click is the honest outcome of a row nobody understands.
 */
function asSpaceRole(role: string): SpaceRole {
  return role === 'admin' || role === 'member' || role === 'viewer' ? role : 'viewer';
}
