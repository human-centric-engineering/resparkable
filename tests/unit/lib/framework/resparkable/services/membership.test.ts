/**
 * Unit Tests: the group trust boundary (Release 9, phase 46).
 *
 * This is the file that decides whether a second person may read somebody
 * else's brain, so the assertions are about refusals rather than about happy
 * paths. What has to hold:
 *
 *   1. **A non-member resolves to no scope**, which is the release's most
 *      important property (test 13b). Not an empty scope, not a viewer scope:
 *      nothing, so the caller cannot accidentally query with it.
 *   2. **A pending membership resolves to no scope either.** `joinedAt: null`
 *      is phase 57's request-to-join, and it must already be refused here or
 *      that phase inherits a hole.
 *   3. **An unrecognised role resolves to no scope.** Falling back to `viewer`
 *      sounds safe and grants read access to a whole brain.
 *   4. **A group space is created with `ownerUserId: null`.** The B12 CHECK
 *      catches this at the database, but a red test is a better failure than a
 *      500 on somebody's first group, and it is the half a CHECK cannot see:
 *      that the service never tries.
 *   5. **The last admin cannot leave, be demoted or be removed** (§23.3), and
 *      an erased last admin's role transfers to the longest-standing remaining
 *      member instead, because erasure cannot be refused.
 *   6. **A group whose last member leaves is deleted**, by deleting the space,
 *      because a memberless group space is unreachable by any route and by the
 *      personal erasure cascade alike.
 *
 * The repo layer is mocked: this is about the decisions, not the SQL. The SQL
 * half is `repo/isolation.test.ts` plus the real-database smokes.
 *
 * @see lib/framework/resparkable/services/membership.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/framework/resparkable/repo/space', () => ({ findSpaceByUserId: vi.fn() }));
vi.mock('@/lib/framework/resparkable/queue/enqueue', () => ({ ensureResparkableJobs: vi.fn() }));
vi.mock('@/lib/framework/resparkable/repo/groups', () => ({
  countAdmins: vi.fn(),
  createGroupWithSpace: vi.fn(),
  deleteGroupSpace: vi.fn(),
  deleteGroupSpaceIfLastMember: vi.fn(),
  deleteGroupSpaceIfMemberless: vi.fn(),
  deleteJoinRequest: vi.fn(),
  deleteMember: vi.fn(),
  findGroupById: vi.fn(),
  findGroupBySlug: vi.fn(),
  findMembership: vi.fn(),
  findMembershipBySpace: vi.fn(),
  listGroupMembers: vi.fn(),
  listGroupsWithoutAdmin: vi.fn(),
  listJoinedGroupsForErasure: vi.fn(),
  listMembershipsForActor: vi.fn(),
  returnJoinLinkUsesForErasure: vi.fn(),
  updateGroup: vi.fn(),
  updateMemberRole: vi.fn(),
}));

import * as repo from '@/lib/framework/resparkable/repo/groups';
import { findSpaceByUserId } from '@/lib/framework/resparkable/repo/space';
import { ensureResparkableJobs } from '@/lib/framework/resparkable/queue/enqueue';
import {
  changeMemberRole,
  createGroup,
  permissionsFor,
  planErasureSuccession,
  removeMember,
  resolveActiveSpaceScope,
  resolveGroupMembership,
  resolveGroupSpaceScope,
  settleGroupsAfterErasure,
  settleStrandedGroups,
  updateGroupSettings,
  visibleMemberRows,
} from '@/lib/framework/resparkable/services/membership';

const NOW = new Date('2026-09-01T10:00:00.000Z');
/** The default every group has: the longest-standing joined member inherits, whatever their role. */
const ANY_ROLE = { viewersCanInheritAdmin: true };
const SPACE = 'spc_group_1';

/** A live membership row, with the group it hangs off. */
function membership(overrides: Record<string, unknown> = {}) {
  return {
    id: 'mem_1',
    groupId: 'grp_1',
    userId: 'user_a',
    role: 'member',
    invitedByUserId: null,
    soleAdminNotifiedAt: null,
    dailyCreditCap: null,
    joinedAt: NOW,
    requestedAt: null,
    joinLinkId: null,
    createdAt: NOW,
    updatedAt: NOW,
    group: {
      id: 'grp_1',
      name: 'Study Group B',
      slug: 'study-group-b',
      description: null,
      spaceId: SPACE,
      maxMembers: 50,
      joinRefusedFullAt: null,
      viewersCanInheritAdmin: true,
      fundingMode: 'self_funded',
      lowBalanceAlertCredits: null,
      largeRunAlertPercent: null,
      largeRunAlertedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // `clearAllMocks` clears call history but not a resolved value set with
  // `mockResolvedValue`, so this default has to be restored every test or a
  // `true` set by one "withdraw" test would leak into every later call to
  // `removeMember` with `targetUserId === actorUserId`.
  vi.mocked(repo.deleteJoinRequest).mockResolvedValue(false);
  // Same reason: the race tests set `false`, and the default is the locked
  // re-count agreeing with the unlocked one.
  vi.mocked(repo.deleteGroupSpaceIfLastMember).mockResolvedValue(true);
});

describe('resolveGroupSpaceScope', () => {
  it('mints a scope carrying the space, the actor and the role', async () => {
    vi.mocked(repo.findMembershipBySpace).mockResolvedValue(membership());

    const scope = await resolveGroupSpaceScope('user_a', SPACE);

    // The partition key is the SPACE, never the actor. That separation is the
    // whole of phase 45 and the reason a group space is possible at all.
    expect(scope).toMatchObject({ spaceId: SPACE, actorUserId: 'user_a', role: 'member' });
  });

  it('resolves a non-member to nothing at all', async () => {
    vi.mocked(repo.findMembershipBySpace).mockResolvedValue(null);

    // Test 13b, in its smallest form. Not an empty scope and not a viewer: a
    // null the caller cannot query with, which it turns into a 404 rather than a
    // 403 so the answer does not confirm the space exists.
    expect(await resolveGroupSpaceScope('user_stranger', SPACE)).toBeNull();
  });

  it('resolves a pending membership to nothing', async () => {
    vi.mocked(repo.findMembershipBySpace).mockResolvedValue(membership({ joinedAt: null }));

    // `joinedAt: null` is phase 57's request-to-join waiting on an admin. If it
    // resolved to a scope here, that phase would ship approval as decoration.
    expect(await resolveGroupSpaceScope('user_a', SPACE)).toBeNull();
  });

  it('resolves an unrecognised role to nothing rather than to a guess', async () => {
    vi.mocked(repo.findMembershipBySpace).mockResolvedValue(membership({ role: 'superuser' }));

    // A value from a future migration or a hand-edited row. Falling back to
    // `viewer` reads as the cautious choice and grants read access to a whole
    // brain, which is the opposite of cautious.
    expect(await resolveGroupSpaceScope('user_a', SPACE)).toBeNull();
  });

  it('never resolves the owner role on a group space', async () => {
    vi.mocked(repo.findMembershipBySpace).mockResolvedValue(membership({ role: 'owner' }));

    // §23.2: `owner` means "the sole human who owns this space", and a group has
    // no such person. B12 makes it a database rule for the space row; this keeps
    // it out of the scope as well, so nothing downstream can branch on it.
    expect(await resolveGroupSpaceScope('user_a', SPACE)).toBeNull();
  });

  it('refuses an empty actor or an empty space without querying', async () => {
    expect(await resolveGroupSpaceScope('', SPACE)).toBeNull();
    expect(await resolveGroupSpaceScope('user_a', '')).toBeNull();
    expect(repo.findMembershipBySpace).not.toHaveBeenCalled();
  });
});

describe('resolveGroupMembership', () => {
  it('resolves a pending membership to nothing at all', async () => {
    // The twin of `resolveGroupSpaceScope`'s equivalent test, for the
    // management routes that address a group by id rather than by space.
    // `joinedAt: null` is §23.11's request-to-join, and it must resolve to no
    // scope here too, or the management routes inherit a hole this phase
    // would otherwise have shipped.
    vi.mocked(repo.findMembership).mockResolvedValue(membership({ joinedAt: null }));

    expect(await resolveGroupMembership('user_a', 'grp_1')).toBeNull();
  });

  it('resolves a live membership to its scope and role', async () => {
    vi.mocked(repo.findMembership).mockResolvedValue(membership({ role: 'admin' }));

    const resolved = await resolveGroupMembership('user_a', 'grp_1');

    expect(resolved).not.toBeNull();
    expect(resolved?.scope).toMatchObject({ spaceId: SPACE, actorUserId: 'user_a', role: 'admin' });
  });

  it('resolves a non-member to nothing', async () => {
    vi.mocked(repo.findMembership).mockResolvedValue(null);

    expect(await resolveGroupMembership('user_stranger', 'grp_1')).toBeNull();
  });
});

describe('permissionsFor', () => {
  it('gives a viewer no write access and no administration', () => {
    // §23.3: a viewer reads, and (from phase 50) spends nothing.
    expect(permissionsFor('viewer')).toEqual({ administer: false, write: false });
  });

  it('gives a member writes but not administration', () => {
    expect(permissionsFor('member')).toEqual({ administer: false, write: true });
  });

  it('gives an admin both', () => {
    expect(permissionsFor('admin')).toEqual({ administer: true, write: true });
  });
});

describe('visibleMemberRows', () => {
  const JOINED = { id: 'joined', joinedAt: NOW };
  const PENDING = { id: 'pending', joinedAt: null };
  const rows = [JOINED, PENDING];

  it('shows an admin both the joined member and the pending request', () => {
    expect(visibleMemberRows(rows, 'admin')).toEqual([JOINED, PENDING]);
  });

  it('shows an owner both, the same as an admin', () => {
    expect(visibleMemberRows(rows, 'owner')).toEqual([JOINED, PENDING]);
  });

  it('hides the pending request from a member: a request is somebody not in the group yet', () => {
    expect(visibleMemberRows(rows, 'member')).toEqual([JOINED]);
  });

  it('hides the pending request from a viewer', () => {
    expect(visibleMemberRows(rows, 'viewer')).toEqual([JOINED]);
  });

  it('returns an empty list for an empty input, whichever role is asking', () => {
    expect(visibleMemberRows([], 'admin')).toEqual([]);
    expect(visibleMemberRows([], 'member')).toEqual([]);
  });
});

describe('createGroup', () => {
  it('creates the space with no owner, which is what keeps it shared', async () => {
    vi.mocked(repo.findGroupBySlug).mockResolvedValue(null);
    vi.mocked(repo.createGroupWithSpace).mockResolvedValue(membership({ role: 'admin' }));

    await createGroup('user_a', { name: 'Study Group B' });

    // The repo writes `ownerUserId: null` and the B12 CHECK enforces it. What
    // this asserts is the half a CHECK cannot see: that the service hands the
    // repo a founder rather than an owner, so there is no path by which a user
    // id reaches that column. A group space with an owner vanishes when one
    // member closes their account.
    const data = vi.mocked(repo.createGroupWithSpace).mock.calls[0][0];
    expect(data).not.toHaveProperty('ownerUserId');
    expect(data.founderUserId).toBe('user_a');
    // A minted key, never the founder's user id: the two stop being the same
    // value the moment a space is not a person's.
    expect(data.spaceId).not.toBe('user_a');
    expect(data.spaceId).toMatch(/^spc_[0-9a-f]{32}$/);
  });

  it('starts the group on its founder’s clock and gives it only group jobs', async () => {
    // Phase 50. The digest lands at 09:00 on the group's clock, and UTC would
    // put a Sydney group's on a Monday evening. The jobs are the group set,
    // never the personal four that would queue runs naming the space as a user.
    vi.mocked(findSpaceByUserId).mockResolvedValue({ timezone: 'Australia/Sydney' } as never);
    vi.mocked(repo.findGroupBySlug).mockResolvedValue(null);
    vi.mocked(repo.createGroupWithSpace).mockResolvedValue(membership({ role: 'admin' }));

    await createGroup('user_a', { name: 'Study Group B' });

    expect(vi.mocked(repo.createGroupWithSpace).mock.calls[0]?.[0]).toMatchObject({
      timezone: 'Australia/Sydney',
    });
    expect(ensureResparkableJobs).toHaveBeenCalledWith(
      SPACE,
      'Australia/Sydney',
      expect.any(Date),
      'group'
    );
  });

  it('walks the slug forward rather than colliding', async () => {
    vi.mocked(repo.findGroupBySlug)
      .mockResolvedValueOnce({ id: 'grp_taken' } as never)
      .mockResolvedValueOnce(null);
    vi.mocked(repo.createGroupWithSpace).mockResolvedValue(membership({ role: 'admin' }));

    await createGroup('user_a', { name: 'Study Group B' });

    // Globally unique, so a collision is between strangers. The suffix is what
    // stops one person's group name blocking another's.
    expect(vi.mocked(repo.createGroupWithSpace).mock.calls[0][0].slug).toBe('study-group-b-2');
  });

  it('names a group whose title slugifies to nothing', async () => {
    vi.mocked(repo.findGroupBySlug).mockResolvedValue(null);
    vi.mocked(repo.createGroupWithSpace).mockResolvedValue(membership({ role: 'admin' }));

    await createGroup('user_a', { name: '!!!' });

    // An empty slug would violate the unique index in a way that reads as a
    // database error rather than as "we could not name this".
    expect(vi.mocked(repo.createGroupWithSpace).mock.calls[0][0].slug).toBe('group');
  });
});

describe('the last-admin rules', () => {
  it('refuses to demote the last admin', async () => {
    vi.mocked(repo.findMembership)
      .mockResolvedValueOnce(membership({ role: 'admin' }))
      .mockResolvedValueOnce(membership({ userId: 'user_a', role: 'admin' }));
    vi.mocked(repo.countAdmins).mockResolvedValue(1);

    const result = await changeMemberRole('user_a', 'grp_1', 'user_a', 'member');

    // A group with no admin is a workspace nobody can administer, holding
    // content nobody can export.
    expect(result).toEqual({ ok: false, reason: 'last_admin' });
    expect(repo.updateMemberRole).not.toHaveBeenCalled();
  });

  it('allows demoting an admin while another remains', async () => {
    vi.mocked(repo.findMembership)
      .mockResolvedValueOnce(membership({ role: 'admin' }))
      .mockResolvedValueOnce(membership({ userId: 'user_b', role: 'admin' }));
    vi.mocked(repo.countAdmins).mockResolvedValue(2);

    expect(await changeMemberRole('user_a', 'grp_1', 'user_b', 'member')).toEqual({
      ok: true,
      value: null,
    });
    expect(repo.updateMemberRole).toHaveBeenCalledWith('grp_1', 'user_b', 'member');
  });

  it('refuses a role the code does not know', async () => {
    // Checked before anything is read, so an unknown role cannot even cost a
    // query, and cannot reach the column that `resolveGroupSpaceScope` then has
    // to refuse for ever.
    expect(await changeMemberRole('user_a', 'grp_1', 'user_b', 'owner')).toEqual({
      ok: false,
      reason: 'unknown_role',
    });
    expect(repo.findMembership).not.toHaveBeenCalled();
  });

  it('refuses to change the role of a pending target: the link fixed it, and approving is the only way to a different one', async () => {
    vi.mocked(repo.findMembership)
      .mockResolvedValueOnce(membership({ role: 'admin' }))
      .mockResolvedValueOnce(membership({ userId: 'user_pending', joinedAt: null }));

    const result = await changeMemberRole('user_a', 'grp_1', 'user_pending', 'admin');

    expect(result).toEqual({ ok: false, reason: 'no_such_member' });
    expect(repo.updateMemberRole).not.toHaveBeenCalled();
  });

  it('refuses to remove the last admin', async () => {
    vi.mocked(repo.findMembership)
      .mockResolvedValueOnce(membership({ role: 'admin' }))
      .mockResolvedValueOnce(membership({ userId: 'user_b', role: 'admin' }));
    vi.mocked(repo.listGroupMembers).mockResolvedValue([
      membership({ role: 'admin' }),
      membership({ userId: 'user_b', role: 'admin' }),
    ] as never);
    vi.mocked(repo.countAdmins).mockResolvedValue(1);

    expect(await removeMember('user_a', 'grp_1', 'user_b')).toEqual({
      ok: false,
      reason: 'last_admin',
    });
    expect(repo.deleteMember).not.toHaveBeenCalled();
  });

  it('refuses the same thing when the last admin is the one leaving', async () => {
    // Three `findMembership` reads now, not two: the self-removal "am I
    // withdrawing a request" check reads it first, joined admin rows fail that
    // check and fall through to `resolveGroupMembership`'s own read, then the
    // target read. All three see the same joined admin row.
    vi.mocked(repo.findMembership).mockResolvedValue(membership({ role: 'admin' }));
    vi.mocked(repo.listGroupMembers).mockResolvedValue([
      membership({ role: 'admin' }),
      membership({ userId: 'user_b' }),
    ] as never);
    vi.mocked(repo.countAdmins).mockResolvedValue(1);

    // Leaving and being removed are the same write with different authority, so
    // they are one function. This is the path where forgetting the rule is
    // likeliest, which is exactly why they are not two.
    expect(await removeMember('user_a', 'grp_1', 'user_a')).toEqual({
      ok: false,
      reason: 'last_admin',
    });
    // A joined row is not a pending one: the withdraw path must never fire.
    expect(repo.deleteJoinRequest).not.toHaveBeenCalled();
  });

  it('lets a non-admin leave without administering anything', async () => {
    // Same reason: the self-removal withdraw-check read comes first now, and a
    // joined row fails it, so `resolveGroupMembership` and the target read see
    // the same row behind it.
    vi.mocked(repo.findMembership).mockResolvedValue(membership());
    vi.mocked(repo.listGroupMembers).mockResolvedValue([
      membership(),
      membership({ userId: 'user_b' }),
    ] as never);

    expect(await removeMember('user_a', 'grp_1', 'user_a')).toEqual({
      ok: true,
      value: { groupDeleted: false },
    });
    expect(repo.deleteMember).toHaveBeenCalledWith('grp_1', 'user_a');
    // An ordinary joined leave must never take the withdraw-a-request path.
    expect(repo.deleteJoinRequest).not.toHaveBeenCalled();
  });

  it('refuses a member trying to remove somebody else', async () => {
    vi.mocked(repo.findMembership).mockResolvedValue(membership());

    expect(await removeMember('user_a', 'grp_1', 'user_b')).toEqual({
      ok: false,
      reason: 'not_an_admin',
    });
  });
});

describe('pending rows do not trap anybody', () => {
  it('lets a sole joined admin leave even with a request-to-join beside them', async () => {
    vi.mocked(repo.findMembership)
      .mockResolvedValueOnce(membership({ role: 'admin' }))
      .mockResolvedValueOnce(membership({ role: 'admin' }));
    vi.mocked(repo.listGroupMembers).mockResolvedValue([
      membership({ role: 'admin' }),
      membership({ userId: 'user_pending', joinedAt: null }),
    ] as never);
    vi.mocked(repo.deleteGroupSpaceIfLastMember).mockResolvedValue(true);

    const result = await removeMember('user_a', 'grp_1', 'user_a');

    // `countAdmins` excludes pending rows and this count used to include them,
    // so the sole admin failed the "last member out" short-circuit, fell through
    // to the last-admin rule, and could never leave their own group. Somebody
    // asking to come in must not be the reason somebody else is trapped.
    expect(result).toEqual({ ok: true, value: { groupDeleted: true } });
    expect(repo.deleteGroupSpaceIfLastMember).toHaveBeenCalledWith('grp_1', SPACE, 'user_a');
  });

  it('still refuses when the second member has actually joined', async () => {
    // The self-removal withdraw check reads first now, and a joined admin row
    // fails it (joinedAt isn't null), so all three `findMembership` reads see
    // the same row.
    vi.mocked(repo.findMembership).mockResolvedValue(membership({ role: 'admin' }));
    vi.mocked(repo.listGroupMembers).mockResolvedValue([
      membership({ role: 'admin' }),
      membership({ userId: 'user_b' }),
    ] as never);
    vi.mocked(repo.countAdmins).mockResolvedValue(1);

    // The guard on the fix: the filter must not turn the last-admin rule off for
    // a group that genuinely has somebody else in it.
    expect(await removeMember('user_a', 'grp_1', 'user_a')).toEqual({
      ok: false,
      reason: 'last_admin',
    });
    expect(repo.deleteGroupSpaceIfLastMember).not.toHaveBeenCalled();
  });

  it('an admin rejecting the only pending request, alone in the group, deletes only the request', async () => {
    // The regression phase 57 would otherwise have made reachable
    // (phase-57-plan.md decision 5). Before the fix, `removeMember` counted
    // only JOINED members for "last member out", so a sole admin rejecting the
    // one pending request beside them took that branch and deleted the group
    // out from under themselves. A pending target now short-circuits to a
    // plain delete before any of that logic runs at all.
    vi.mocked(repo.findMembership)
      .mockResolvedValueOnce(membership({ role: 'admin' }))
      .mockResolvedValueOnce(membership({ userId: 'user_pending', joinedAt: null }));
    vi.mocked(repo.deleteJoinRequest).mockResolvedValue(true);

    const result = await removeMember('user_a', 'grp_1', 'user_pending');

    expect(result).toEqual({ ok: true, value: { groupDeleted: false } });
    expect(repo.deleteJoinRequest).toHaveBeenCalledWith('grp_1', 'user_pending');
    expect(repo.deleteGroupSpace).not.toHaveBeenCalled();
    expect(repo.listGroupMembers).not.toHaveBeenCalled();
  });

  it('lets a pending person withdraw their own request', async () => {
    // `resolveGroupMembership` (via `findMembership`) returns null-scope for a
    // pending row, so the withdraw check has to run BEFORE that resolve, or the
    // person asking to join would be told the group does not exist. It now
    // reads the row itself first (`own = await findMembership(...)`) to decide
    // whether this is a withdrawal at all, rather than assuming any self-removal
    // is one.
    vi.mocked(repo.findMembership).mockResolvedValue(
      membership({ userId: 'user_pending', joinedAt: null })
    );
    vi.mocked(repo.deleteJoinRequest).mockResolvedValue(true);

    const result = await removeMember('user_pending', 'grp_1', 'user_pending');

    expect(result).toEqual({ ok: true, value: { groupDeleted: false } });
    expect(repo.findMembership).toHaveBeenCalledWith('user_pending', 'grp_1');
    expect(repo.deleteJoinRequest).toHaveBeenCalledWith('grp_1', 'user_pending');
    // Proves the short-circuit: only the one "am I pending" read happens, never
    // the full `resolveGroupMembership` + target read that an ordinary leave
    // pays for.
    expect(repo.findMembership).toHaveBeenCalledTimes(1);
  });

  it('does not call deleteJoinRequest for an ordinary joined self-leave', async () => {
    // The own-row read now decides whether this is a withdrawal; only a
    // PENDING row (`joinedAt: null`) takes that branch. A joined row must fall
    // straight through to the ordinary leave logic below.
    vi.mocked(repo.findMembership).mockResolvedValue(membership());
    vi.mocked(repo.listGroupMembers).mockResolvedValue([
      membership(),
      membership({ userId: 'user_b' }),
    ] as never);

    const result = await removeMember('user_a', 'grp_1', 'user_a');

    expect(result).toEqual({ ok: true, value: { groupDeleted: false } });
    expect(repo.deleteJoinRequest).not.toHaveBeenCalled();
    expect(repo.deleteMember).toHaveBeenCalledWith('grp_1', 'user_a');
  });

  it('does not withdraw when the own row is pending but deleteJoinRequest itself finds nothing to delete', async () => {
    // A race: the request was already approved or rejected between the read
    // and the delete. `deleteJoinRequest` resolving false must not stop here —
    // it falls through to the ordinary resolve, which 404s a still-pending
    // person (a genuinely gone row resolves to nothing either way).
    vi.mocked(repo.findMembership)
      .mockResolvedValueOnce(membership({ userId: 'user_pending', joinedAt: null }))
      .mockResolvedValueOnce(null);
    vi.mocked(repo.deleteJoinRequest).mockResolvedValue(false);

    const result = await removeMember('user_pending', 'grp_1', 'user_pending');

    expect(result).toEqual({ ok: false, reason: 'not_a_member' });
  });
});

describe('the last member out', () => {
  it('deletes the space rather than leaving an unreachable group', async () => {
    vi.mocked(repo.findMembership)
      .mockResolvedValueOnce(membership({ role: 'admin' }))
      .mockResolvedValueOnce(membership({ role: 'admin' }));
    vi.mocked(repo.listGroupMembers).mockResolvedValue([membership({ role: 'admin' })] as never);
    vi.mocked(repo.deleteGroupSpaceIfLastMember).mockResolvedValue(true);

    const result = await removeMember('user_a', 'grp_1', 'user_a');

    // The last-admin rule does NOT fire here, and that is the point: refusing
    // would trap the last person in a group for ever. What happens instead is
    // that the space goes, because a group space sits outside the personal
    // erasure cascade (§23.2) and a memberless one is a brain no route can open
    // and no cascade can remove.
    expect(result).toEqual({ ok: true, value: { groupDeleted: true } });
    // The space, never the group row: deleting the group would strand the space
    // and all 23 satellites behind it. The repo re-counts under the group lock.
    expect(repo.deleteGroupSpaceIfLastMember).toHaveBeenCalledWith('grp_1', SPACE, 'user_a');
    expect(repo.deleteMember).not.toHaveBeenCalled();
  });

  it('keeps the group when somebody joined through a link after the count', async () => {
    // The unlocked count said "last one out", but the locked re-count in the
    // repo found a newcomer. Deleting now would take their fresh membership
    // with it, so this becomes an ordinary leave, and a sole admin is held by
    // the last-admin rule like any other.
    vi.mocked(repo.findMembership).mockResolvedValue(membership({ role: 'admin' }));
    vi.mocked(repo.listGroupMembers).mockResolvedValue([membership({ role: 'admin' })] as never);
    vi.mocked(repo.deleteGroupSpaceIfLastMember).mockResolvedValue(false);
    vi.mocked(repo.countAdmins).mockResolvedValue(1);

    expect(await removeMember('user_a', 'grp_1', 'user_a')).toEqual({
      ok: false,
      reason: 'last_admin',
    });
    expect(repo.deleteMember).not.toHaveBeenCalled();
  });

  it('removes a non-admin as an ordinary leave when the locked re-count finds a newcomer', async () => {
    vi.mocked(repo.findMembership).mockResolvedValue(membership({ role: 'member' }));
    vi.mocked(repo.listGroupMembers).mockResolvedValue([membership({ role: 'member' })] as never);
    vi.mocked(repo.deleteGroupSpaceIfLastMember).mockResolvedValue(false);

    expect(await removeMember('user_a', 'grp_1', 'user_a')).toEqual({
      ok: true,
      value: { groupDeleted: false },
    });
    expect(repo.deleteMember).toHaveBeenCalledWith('grp_1', 'user_a');
  });
});

describe('planErasureSuccession', () => {
  const at = (iso: string) => new Date(iso);

  it('promotes the longest-standing remaining member when the last admin is erased', () => {
    // `listGroupMembers` orders by `joinedAt`, so the succession order IS the
    // input order and the plan does not sort again. §18's circle rule is the
    // precedent: a circle whose owner is erased goes to its longest-standing
    // member rather than vanishing.
    const plan = planErasureSuccession(
      [
        { userId: 'user_erased', role: 'admin', joinedAt: at('2026-01-01T00:00:00Z') },
        { userId: 'user_b', role: 'member', joinedAt: at('2026-03-01T00:00:00Z') },
        { userId: 'user_c', role: 'viewer', joinedAt: at('2026-06-01T00:00:00Z') },
      ],
      'user_erased',
      ANY_ROLE
    );

    expect(plan).toEqual({ kind: 'promote', userId: 'user_b' });
  });

  it('changes nothing when another admin is still there', () => {
    const plan = planErasureSuccession(
      [
        { userId: 'user_erased', role: 'admin', joinedAt: NOW },
        { userId: 'user_b', role: 'admin', joinedAt: NOW },
      ],
      'user_erased',
      ANY_ROLE
    );

    expect(plan).toEqual({ kind: 'unchanged' });
  });

  it('changes nothing when the erased person was not an admin', () => {
    const plan = planErasureSuccession(
      [
        { userId: 'user_a', role: 'admin', joinedAt: NOW },
        { userId: 'user_erased', role: 'member', joinedAt: NOW },
      ],
      'user_erased',
      ANY_ROLE
    );

    expect(plan).toEqual({ kind: 'unchanged' });
  });

  it('deletes the group when nobody joined is left', () => {
    // Distinguishable from "unchanged" in the return value itself. The first
    // version returned null for both and left the caller to re-read the members.
    const plan = planErasureSuccession(
      [{ userId: 'user_erased', role: 'admin', joinedAt: NOW }],
      'user_erased',
      ANY_ROLE
    );

    expect(plan).toEqual({ kind: 'delete' });
  });

  it('never promotes a pending member, and does not let one keep the group alive', () => {
    // Promoting them would make erasure a way past the approval queue. And a
    // request to join cannot be the thing that keeps a memberless workspace
    // around, for the reason `removeMember` gives.
    const plan = planErasureSuccession(
      [
        { userId: 'user_erased', role: 'admin', joinedAt: NOW },
        { userId: 'user_pending', role: 'member', joinedAt: null },
      ],
      'user_erased',
      ANY_ROLE
    );

    expect(plan).toEqual({ kind: 'delete' });
  });
});

describe('planErasureSuccession with viewers excluded', () => {
  const NO_VIEWERS = { viewersCanInheritAdmin: false };

  it('skips a longer-standing viewer for the first member who is not one', () => {
    const members = [
      { userId: 'user_erased', role: 'admin', joinedAt: NOW },
      { userId: 'user_viewer', role: 'viewer', joinedAt: NOW },
      { userId: 'user_member', role: 'member', joinedAt: NOW },
    ];

    expect(planErasureSuccession(members, 'user_erased', NO_VIEWERS)).toEqual({
      kind: 'promote',
      userId: 'user_member',
    });
    // The default, for contrast: the viewer has been there longest and inherits.
    expect(planErasureSuccession(members, 'user_erased', ANY_ROLE)).toEqual({
      kind: 'promote',
      userId: 'user_viewer',
    });
  });

  it('leaves the group without an admin when only viewers remain', () => {
    // The admin chose this. Not `delete`: the viewers are still in it and can
    // still read it. Not `unchanged`: callers count it separately.
    const plan = planErasureSuccession(
      [
        { userId: 'user_erased', role: 'admin', joinedAt: NOW },
        { userId: 'user_viewer', role: 'viewer', joinedAt: NOW },
        { userId: 'user_pending', role: 'member', joinedAt: null },
      ],
      'user_erased',
      NO_VIEWERS
    );

    expect(plan).toEqual({ kind: 'no_admin' });
  });

  it('still deletes a group nobody is left in', () => {
    expect(
      planErasureSuccession(
        [{ userId: 'user_erased', role: 'admin', joinedAt: NOW }],
        'user_erased',
        NO_VIEWERS
      )
    ).toEqual({ kind: 'delete' });
  });

  it('accepts wire-shaped members, whose joinedAt is a string', () => {
    // The group page runs the same rule over the JSON it was sent.
    expect(
      planErasureSuccession(
        [
          { userId: 'user_a', role: 'admin', joinedAt: '2026-01-01T00:00:00.000Z' },
          { userId: 'user_b', role: 'member', joinedAt: '2026-02-01T00:00:00.000Z' },
        ],
        'user_a',
        NO_VIEWERS
      )
    ).toEqual({ kind: 'promote', userId: 'user_b' });
  });
});

describe('settleGroupsAfterErasure', () => {
  const tx = { marker: 'the erasure transaction' } as never;

  it('promotes and deletes through the transaction it is given', async () => {
    vi.mocked(repo.listJoinedGroupsForErasure).mockResolvedValue([
      { groupId: 'grp_promote', spaceId: 'spc_promote', viewersCanInheritAdmin: true },
      { groupId: 'grp_delete', spaceId: 'spc_delete', viewersCanInheritAdmin: true },
      { groupId: 'grp_fine', spaceId: 'spc_fine', viewersCanInheritAdmin: true },
    ]);
    vi.mocked(repo.listGroupMembers).mockImplementation(async (groupId) => {
      if (groupId === 'grp_promote') {
        return [
          membership({ groupId, userId: 'user_erased', role: 'admin' }),
          membership({ groupId, userId: 'user_b' }),
        ] as never;
      }
      if (groupId === 'grp_delete') {
        return [membership({ groupId, userId: 'user_erased', role: 'admin' })] as never;
      }
      return [
        membership({ groupId, userId: 'user_erased' }),
        membership({ groupId, userId: 'user_a', role: 'admin' }),
      ] as never;
    });

    const settlement = await settleGroupsAfterErasure('user_erased', tx);

    expect(settlement).toEqual({ promoted: 1, deleted: 1, leftWithoutAdmin: 0 });
    // Every write goes through `tx`. Through the global client, a promotion
    // would outlive an erasure that rolled back.
    expect(repo.listJoinedGroupsForErasure).toHaveBeenCalledWith('user_erased', tx);
    expect(repo.updateMemberRole).toHaveBeenCalledTimes(1);
    expect(repo.updateMemberRole).toHaveBeenCalledWith('grp_promote', 'user_b', 'admin', tx);
    // Deleting the SPACE, not the group row: the group cascades from the space,
    // and deleting the group alone would orphan all 23 satellites.
    expect(repo.deleteGroupSpace).toHaveBeenCalledTimes(1);
    expect(repo.deleteGroupSpace).toHaveBeenCalledWith('spc_delete', tx);
  });

  it('gives back the link use of every request they were still waiting on, through the transaction', async () => {
    // The cascade removes a pending row without going through
    // `deleteJoinRequest`, so the use it took would otherwise stay spent.
    vi.mocked(repo.listJoinedGroupsForErasure).mockResolvedValue([]);
    vi.mocked(repo.returnJoinLinkUsesForErasure).mockResolvedValue(2);

    const settlement = await settleGroupsAfterErasure('user_erased', tx);

    expect(repo.returnJoinLinkUsesForErasure).toHaveBeenCalledWith('user_erased', tx);
    // Not a settlement field: the stranded-group sweep shares that shape.
    expect(settlement).toEqual({ promoted: 0, deleted: 0, leftWithoutAdmin: 0 });
  });

  it('honours a group that keeps viewers from inheriting, and changes nothing in it', async () => {
    vi.mocked(repo.listJoinedGroupsForErasure).mockResolvedValue([
      { groupId: 'grp_viewers', spaceId: 'spc_viewers', viewersCanInheritAdmin: false },
    ]);
    vi.mocked(repo.listGroupMembers).mockResolvedValue([
      membership({ groupId: 'grp_viewers', userId: 'user_erased', role: 'admin' }),
      membership({ groupId: 'grp_viewers', userId: 'user_v', role: 'viewer' }),
    ] as never);

    const settlement = await settleGroupsAfterErasure('user_erased', tx);

    expect(settlement).toEqual({ promoted: 0, deleted: 0, leftWithoutAdmin: 1 });
    expect(repo.updateMemberRole).not.toHaveBeenCalled();
    // The viewers are still in it. Deleting it would take their workspace.
    expect(repo.deleteGroupSpace).not.toHaveBeenCalled();
  });

  it('does not remove the erased person’s own membership rows', async () => {
    vi.mocked(repo.listJoinedGroupsForErasure).mockResolvedValue([
      { groupId: 'grp_1', spaceId: SPACE, viewersCanInheritAdmin: true },
    ]);
    vi.mocked(repo.listGroupMembers).mockResolvedValue([
      membership({ userId: 'user_erased' }),
      membership({ userId: 'user_a', role: 'admin' }),
    ] as never);

    await settleGroupsAfterErasure('user_erased', tx);

    // B13's cascade takes them a moment later. Deleting them here as well would
    // be a second definition of what erasure means.
    expect(repo.deleteMember).not.toHaveBeenCalled();
  });

  it('does nothing for somebody in no groups', async () => {
    vi.mocked(repo.listJoinedGroupsForErasure).mockResolvedValue([]);

    expect(await settleGroupsAfterErasure('user_erased', tx)).toEqual({
      promoted: 0,
      deleted: 0,
      leftWithoutAdmin: 0,
    });
    expect(repo.listGroupMembers).not.toHaveBeenCalled();
  });
});

describe('settleStrandedGroups', () => {
  it('applies the erasure rule late: deletes an empty group and promotes in an admin-less one', async () => {
    vi.mocked(repo.listGroupsWithoutAdmin).mockResolvedValue([
      { groupId: 'grp_empty', spaceId: 'spc_empty', viewersCanInheritAdmin: true },
      { groupId: 'grp_headless', spaceId: 'spc_headless', viewersCanInheritAdmin: true },
    ]);
    vi.mocked(repo.listGroupMembers).mockImplementation(async (groupId) =>
      groupId === 'grp_empty'
        ? []
        : ([
            membership({ groupId, userId: 'user_pending', joinedAt: null }),
            membership({ groupId, userId: 'user_b' }),
            membership({ groupId, userId: 'user_c', role: 'viewer' }),
          ] as never)
    );
    vi.mocked(repo.deleteGroupSpaceIfMemberless).mockResolvedValue(true);

    const settlement = await settleStrandedGroups();

    expect(settlement).toEqual({ promoted: 1, deleted: 1, leftWithoutAdmin: 0 });
    // The conditional delete, never the unconditional one: a member who joined
    // since the read must keep the group.
    expect(repo.deleteGroupSpaceIfMemberless).toHaveBeenCalledWith('grp_empty', 'spc_empty');
    expect(repo.deleteGroupSpace).not.toHaveBeenCalled();
    // Longest-standing JOINED member. The pending row is first in the list and
    // is still skipped, or the sweep would be a way past the approval queue.
    expect(repo.updateMemberRole).toHaveBeenCalledTimes(1);
    expect(repo.updateMemberRole).toHaveBeenCalledWith('grp_headless', 'user_b', 'admin');
  });

  it('does not count a delete the database declined', async () => {
    vi.mocked(repo.listGroupsWithoutAdmin).mockResolvedValue([
      { groupId: 'grp_empty', spaceId: 'spc_empty', viewersCanInheritAdmin: true },
    ]);
    vi.mocked(repo.listGroupMembers).mockResolvedValue([]);
    // Somebody joined between the two reads.
    vi.mocked(repo.deleteGroupSpaceIfMemberless).mockResolvedValue(false);

    expect(await settleStrandedGroups()).toEqual({ promoted: 0, deleted: 0, leftWithoutAdmin: 0 });
  });

  it('leaves a group alone when an admin appeared between the reads', async () => {
    vi.mocked(repo.listGroupsWithoutAdmin).mockResolvedValue([
      { groupId: 'grp_1', spaceId: SPACE, viewersCanInheritAdmin: true },
    ]);
    vi.mocked(repo.listGroupMembers).mockResolvedValue([
      membership({ userId: 'user_a', role: 'admin' }),
    ] as never);

    expect(await settleStrandedGroups()).toEqual({ promoted: 0, deleted: 0, leftWithoutAdmin: 0 });
    expect(repo.updateMemberRole).not.toHaveBeenCalled();
    expect(repo.deleteGroupSpaceIfMemberless).not.toHaveBeenCalled();
  });

  it('does not let one failing group stop the rest', async () => {
    vi.mocked(repo.listGroupsWithoutAdmin).mockResolvedValue([
      { groupId: 'grp_broken', spaceId: 'spc_broken', viewersCanInheritAdmin: true },
      { groupId: 'grp_empty', spaceId: 'spc_empty', viewersCanInheritAdmin: true },
    ]);
    vi.mocked(repo.listGroupMembers).mockImplementation(async (groupId) => {
      if (groupId === 'grp_broken') throw new Error('connection reset');
      return [];
    });
    vi.mocked(repo.deleteGroupSpaceIfMemberless).mockResolvedValue(true);

    expect(await settleStrandedGroups()).toEqual({ promoted: 0, deleted: 1, leftWithoutAdmin: 0 });
    expect(repo.deleteGroupSpaceIfMemberless).toHaveBeenCalledWith('grp_empty', 'spc_empty');
  });

  it('promotes past a viewer when the group keeps viewers from inheriting', async () => {
    vi.mocked(repo.listGroupsWithoutAdmin).mockResolvedValue([
      { groupId: 'grp_1', spaceId: SPACE, viewersCanInheritAdmin: false },
    ]);
    vi.mocked(repo.listGroupMembers).mockResolvedValue([
      membership({ userId: 'user_v', role: 'viewer' }),
      membership({ userId: 'user_m', role: 'member' }),
    ] as never);

    expect(await settleStrandedGroups()).toEqual({
      promoted: 1,
      deleted: 0,
      leftWithoutAdmin: 0,
    });
    expect(repo.updateMemberRole).toHaveBeenCalledWith('grp_1', 'user_m', 'admin');
  });

  it('neither writes nor counts a group left without an admin by its own choice', async () => {
    // `listGroupsWithoutAdmin` filters these out, so this is the race where the
    // last member left between the two reads. Nothing is settled.
    vi.mocked(repo.listGroupsWithoutAdmin).mockResolvedValue([
      { groupId: 'grp_1', spaceId: SPACE, viewersCanInheritAdmin: false },
    ]);
    vi.mocked(repo.listGroupMembers).mockResolvedValue([
      membership({ userId: 'user_v', role: 'viewer' }),
    ] as never);

    expect(await settleStrandedGroups()).toEqual({
      promoted: 0,
      deleted: 0,
      leftWithoutAdmin: 0,
    });
    expect(repo.updateMemberRole).not.toHaveBeenCalled();
    expect(repo.deleteGroupSpaceIfMemberless).not.toHaveBeenCalled();
  });

  it('passes its bound to the query', async () => {
    vi.mocked(repo.listGroupsWithoutAdmin).mockResolvedValue([]);

    await settleStrandedGroups(7);

    expect(repo.listGroupsWithoutAdmin).toHaveBeenCalledWith(7);
    expect(repo.listGroupMembers).not.toHaveBeenCalled();
  });
});

describe('resolveActiveSpaceScope', () => {
  it('resolves an absent target to the personal space, without a query', async () => {
    const scope = await resolveActiveSpaceScope('user_a', null);

    // The whole surface passes through this function from phase 47 on, and the
    // overwhelming majority of requests carry no target. If that case cost a
    // membership read, every page in the app would pay for a feature its user
    // may not use.
    expect(scope).toMatchObject({ spaceId: 'user_a', actorUserId: 'user_a', role: 'owner' });
    expect(repo.findMembershipBySpace).not.toHaveBeenCalled();
  });

  it("resolves the actor's own id to the personal space, without a query", async () => {
    // Not a special case being smuggled in: a personal space's key IS its
    // owner's user id (phase 45), so a switcher link back to "Personal" spells
    // it this way. Sending it through group resolution would 404 the user out
    // of their own brain.
    const scope = await resolveActiveSpaceScope('user_a', 'user_a');

    expect(scope).toMatchObject({ spaceId: 'user_a', role: 'owner' });
    expect(repo.findMembershipBySpace).not.toHaveBeenCalled();
  });

  it('resolves a group target through membership', async () => {
    vi.mocked(repo.findMembershipBySpace).mockResolvedValue(membership());

    const scope = await resolveActiveSpaceScope('user_a', SPACE);

    expect(scope).toMatchObject({ spaceId: SPACE, actorUserId: 'user_a', role: 'member' });
  });

  it('resolves a stranger asking for a group space to nothing', async () => {
    vi.mocked(repo.findMembershipBySpace).mockResolvedValue(null);

    // The URL is a target and not an authority. Somebody who is handed a link
    // carrying a space id they are not in gets the same nothing a made-up id
    // gets, which the route turns into a 404.
    expect(await resolveActiveSpaceScope('user_stranger', SPACE)).toBeNull();
  });

  it('refuses an empty actor even when the target is absent', async () => {
    // An unauthenticated caller must not fall through to a personal scope on
    // the empty string. `spaceScope('')` throws by design, and this returns
    // before reaching it so the refusal is a 404 rather than a 500.
    expect(await resolveActiveSpaceScope('', null)).toBeNull();
  });
});

describe('updateGroupSettings', () => {
  it('clears joinRefusedFullAt when maxMembers moves: an admin who has looked at the cap has seen the notice', async () => {
    vi.mocked(repo.findMembership).mockResolvedValue(membership({ role: 'admin' }));
    vi.mocked(repo.updateGroup).mockResolvedValue({} as never);

    await updateGroupSettings('user_a', 'grp_1', { maxMembers: 100 });

    expect(repo.updateGroup).toHaveBeenCalledWith('grp_1', {
      maxMembers: 100,
      joinRefusedFullAt: null,
    });
  });

  it('leaves joinRefusedFullAt untouched when maxMembers is not part of the change', async () => {
    vi.mocked(repo.findMembership).mockResolvedValue(membership({ role: 'admin' }));
    vi.mocked(repo.updateGroup).mockResolvedValue({} as never);

    await updateGroupSettings('user_a', 'grp_1', { name: 'New Name' });

    const data = vi.mocked(repo.updateGroup).mock.calls[0][1];
    expect(data).toEqual({ name: 'New Name' });
    expect(data).not.toHaveProperty('joinRefusedFullAt');
  });

  it('refuses a non-admin', async () => {
    vi.mocked(repo.findMembership).mockResolvedValue(membership());

    const result = await updateGroupSettings('user_a', 'grp_1', { name: 'New Name' });

    expect(result).toEqual({ ok: false, reason: 'not_an_admin' });
    expect(repo.updateGroup).not.toHaveBeenCalled();
  });

  it('refuses a non-member', async () => {
    vi.mocked(repo.findMembership).mockResolvedValue(null);

    const result = await updateGroupSettings('user_stranger', 'grp_1', { name: 'New Name' });

    expect(result).toEqual({ ok: false, reason: 'not_a_member' });
    expect(repo.updateGroup).not.toHaveBeenCalled();
  });
});
