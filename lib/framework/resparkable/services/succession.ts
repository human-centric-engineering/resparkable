/**
 * Who inherits a group's admin role when the last admin's account is erased.
 *
 * Pure, with no imports, so the same rule runs in three places without a second
 * definition drifting from it: the erasure hook (`settleGroupsAfterErasure`),
 * the hourly stranded-group sweep (`settleStrandedGroups`), and the group page,
 * which tells a sole admin what would happen if they closed their account.
 *
 * @see lib/framework/resparkable/services/membership.ts: the two server callers
 */

/** What erasing one member means for one group. */
export type ErasureSuccession =
  | { kind: 'unchanged' }
  | { kind: 'promote'; userId: string }
  | { kind: 'delete' }
  | { kind: 'no_admin' };

/** The group setting the rule reads. */
export interface SuccessionPolicy {
  /** `ResparkableGroup.viewersCanInheritAdmin`. */
  viewersCanInheritAdmin: boolean;
}

/**
 * Decide what erasing a member does to a group.
 *
 * Four answers, and the first version of this conflated two of them: it
 * returned `null` both for "another admin is still here" and for "nobody is left",
 * and left the caller to tell them apart by reading the members a second time.
 *
 *   • **Nobody joined is left: delete.** `removeMember`'s reason: a memberless
 *     group space is a brain no route can open, no cascade can remove and no
 *     subject-access request can reach. Pending rows do not count, because a
 *     request to join cannot keep a workspace alive.
 *   • **The erased member was the last admin: promote** the longest-standing
 *     remaining member (§23.3). Erasure cannot be refused, which is what makes
 *     this different from leaving, where the same situation is a `last_admin`
 *     refusal. The precedent is §18's circle rule.
 *   • **The same, but only viewers are left and the group does not let a viewer
 *     inherit: no admin.** The admin chose this in the group's settings, and
 *     was told what it means when they did. The group carries on, readable by
 *     the viewers, and nobody can administer it. A member who joins later is
 *     promoted by the sweep.
 *   • **Otherwise nothing.** Their membership row cascades with the user, and
 *     the group carries on without them.
 *
 * Longest-standing is `members`' own order, which `listGroupMembers` sorts by
 * `joinedAt`: a member invited in March who accepted in June has been in the
 * group since June. With viewers excluded, it is the longest-standing member who
 * is not a viewer. A pending member is never promoted, because that would make
 * erasure a way past the approval queue.
 *
 * The policy is required rather than defaulted. A caller that forgot it would
 * quietly ignore the admin's choice, which is the one thing this setting
 * promises not to do.
 */
export function planErasureSuccession(
  members: ReadonlyArray<{ userId: string; role: string; joinedAt: Date | string | null }>,
  /** `null` when the erased person's row is already gone, as it is for the sweep. */
  erasedUserId: string | null,
  policy: SuccessionPolicy
): ErasureSuccession {
  const remaining = members.filter(
    (member) => member.userId !== erasedUserId && member.joinedAt !== null
  );
  if (remaining.length === 0) return { kind: 'delete' };
  if (remaining.some((member) => member.role === 'admin')) return { kind: 'unchanged' };

  const successor = policy.viewersCanInheritAdmin
    ? remaining[0]
    : remaining.find((member) => member.role !== 'viewer');
  return successor ? { kind: 'promote', userId: successor.userId } : { kind: 'no_admin' };
}
