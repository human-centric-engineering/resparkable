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

vi.mock('@/lib/framework/resparkable/repo/groups', () => ({
  countAdmins: vi.fn(),
  createGroupWithSpace: vi.fn(),
  deleteGroupSpace: vi.fn(),
  deleteMember: vi.fn(),
  findGroupById: vi.fn(),
  findGroupBySlug: vi.fn(),
  findMembership: vi.fn(),
  findMembershipBySpace: vi.fn(),
  listGroupMembers: vi.fn(),
  listMembershipsForActor: vi.fn(),
  updateGroup: vi.fn(),
  updateMemberRole: vi.fn(),
}));

import * as repo from '@/lib/framework/resparkable/repo/groups';
import {
  changeMemberRole,
  createGroup,
  deleteGroup,
  permissionsFor,
  removeMember,
  resolveActiveSpaceScope,
  resolveGroupSpaceScope,
  transferAdminAfterErasure,
} from '@/lib/framework/resparkable/services/membership';

const NOW = new Date('2026-09-01T10:00:00.000Z');
const SPACE = 'spc_group_1';

/** A live membership row, with the group it hangs off. */
function membership(overrides: Record<string, unknown> = {}) {
  return {
    id: 'mem_1',
    groupId: 'grp_1',
    userId: 'user_a',
    role: 'member',
    invitedByUserId: null,
    joinedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    group: {
      id: 'grp_1',
      name: 'Study Group B',
      slug: 'study-group-b',
      description: null,
      spaceId: SPACE,
      maxMembers: 50,
      createdAt: NOW,
      updatedAt: NOW,
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
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
    vi.mocked(repo.findMembership)
      .mockResolvedValueOnce(membership({ role: 'admin' }))
      .mockResolvedValueOnce(membership({ role: 'admin' }));
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
  });

  it('lets a non-admin leave without administering anything', async () => {
    vi.mocked(repo.findMembership)
      .mockResolvedValueOnce(membership())
      .mockResolvedValueOnce(membership());
    vi.mocked(repo.listGroupMembers).mockResolvedValue([
      membership(),
      membership({ userId: 'user_b' }),
    ] as never);

    expect(await removeMember('user_a', 'grp_1', 'user_a')).toEqual({
      ok: true,
      value: { groupDeleted: false },
    });
    expect(repo.deleteMember).toHaveBeenCalledWith('grp_1', 'user_a');
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

    const result = await removeMember('user_a', 'grp_1', 'user_a');

    // `countAdmins` excludes pending rows and this count used to include them,
    // so the sole admin failed the "last member out" short-circuit, fell through
    // to the last-admin rule, and could never leave their own group. Somebody
    // asking to come in must not be the reason somebody else is trapped.
    expect(result).toEqual({ ok: true, value: { groupDeleted: true } });
    expect(repo.deleteGroupSpace).toHaveBeenCalledWith(SPACE);
  });

  it('still refuses when the second member has actually joined', async () => {
    vi.mocked(repo.findMembership)
      .mockResolvedValueOnce(membership({ role: 'admin' }))
      .mockResolvedValueOnce(membership({ role: 'admin' }));
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
    expect(repo.deleteGroupSpace).not.toHaveBeenCalled();
  });
});

describe('the last member out', () => {
  it('deletes the space rather than leaving an unreachable group', async () => {
    vi.mocked(repo.findMembership)
      .mockResolvedValueOnce(membership({ role: 'admin' }))
      .mockResolvedValueOnce(membership({ role: 'admin' }));
    vi.mocked(repo.listGroupMembers).mockResolvedValue([membership({ role: 'admin' })] as never);

    const result = await removeMember('user_a', 'grp_1', 'user_a');

    // The last-admin rule does NOT fire here, and that is the point: refusing
    // would trap the last person in a group for ever. What happens instead is
    // that the space goes, because a group space sits outside the personal
    // erasure cascade (§23.2) and a memberless one is a brain no route can open
    // and no cascade can remove.
    expect(result).toEqual({ ok: true, value: { groupDeleted: true } });
    expect(repo.deleteGroupSpace).toHaveBeenCalledWith(SPACE);
    // The space, never the group row: deleting the group would strand the space
    // and all 23 satellites behind it.
    expect(repo.deleteMember).not.toHaveBeenCalled();
  });
});

describe('deleteGroup', () => {
  it('is admin only', async () => {
    vi.mocked(repo.findMembership).mockResolvedValue(membership());

    expect(await deleteGroup('user_a', 'grp_1')).toEqual({ ok: false, reason: 'not_an_admin' });
    expect(repo.deleteGroupSpace).not.toHaveBeenCalled();
  });

  it('deletes the space, which is what cascades everything else', async () => {
    vi.mocked(repo.findMembership).mockResolvedValue(membership({ role: 'admin' }));

    expect(await deleteGroup('user_a', 'grp_1')).toEqual({ ok: true, value: null });
    expect(repo.deleteGroupSpace).toHaveBeenCalledWith(SPACE);
  });

  it('refuses a stranger without telling them the group exists', async () => {
    vi.mocked(repo.findMembership).mockResolvedValue(null);

    expect(await deleteGroup('user_stranger', 'grp_1')).toEqual({
      ok: false,
      reason: 'not_a_member',
    });
  });
});

describe('transferAdminAfterErasure', () => {
  it('promotes the longest-standing remaining member', async () => {
    vi.mocked(repo.listGroupMembers).mockResolvedValue([
      membership({ userId: 'user_erased', role: 'admin' }),
      membership({ userId: 'user_b', joinedAt: new Date('2026-03-01T00:00:00.000Z') }),
      membership({ userId: 'user_c', joinedAt: new Date('2026-06-01T00:00:00.000Z') }),
    ] as never);

    // `listGroupMembers` orders by `joinedAt`, so the succession order IS the
    // read order and this function does not sort again. §18's circle rule is the
    // precedent: a circle whose owner is erased transfers to its longest-standing
    // member rather than vanishing.
    expect(await transferAdminAfterErasure('grp_1', 'user_erased')).toBe('user_b');
    expect(repo.updateMemberRole).toHaveBeenCalledWith('grp_1', 'user_b', 'admin');
  });

  it('does nothing when another admin is still there', async () => {
    vi.mocked(repo.listGroupMembers).mockResolvedValue([
      membership({ userId: 'user_erased', role: 'admin' }),
      membership({ userId: 'user_b', role: 'admin' }),
    ] as never);

    expect(await transferAdminAfterErasure('grp_1', 'user_erased')).toBeNull();
    expect(repo.updateMemberRole).not.toHaveBeenCalled();
  });

  it('promotes nobody when nobody is left, and says so', async () => {
    vi.mocked(repo.listGroupMembers).mockResolvedValue([
      membership({ userId: 'user_erased', role: 'admin' }),
    ] as never);

    // Null rather than a throw: the caller deletes the group, for the same
    // reason the last member leaving does.
    expect(await transferAdminAfterErasure('grp_1', 'user_erased')).toBeNull();
  });

  it('does not promote somebody whose membership is still pending', async () => {
    vi.mocked(repo.listGroupMembers).mockResolvedValue([
      membership({ userId: 'user_erased', role: 'admin' }),
      membership({ userId: 'user_pending', joinedAt: null }),
    ] as never);

    // Succession must not hand administration of a group to somebody an admin
    // has not yet let in. That would make erasure a way past the approval queue.
    expect(await transferAdminAfterErasure('grp_1', 'user_erased')).toBeNull();
    expect(repo.updateMemberRole).not.toHaveBeenCalled();
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
