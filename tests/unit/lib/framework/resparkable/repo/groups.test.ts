/**
 * Unit tests: the group repo, the second and last exception to the D5 signature rule.
 *
 * Every other file in `repo/**` takes a `SpaceScope` first and spreads
 * `spaceWhere(scope)` into its `where`, so those tests assert a `spaceId`
 * filter on every query. This file cannot do that, and neither can this test:
 * `createGroupWithSpace` is where a group scope is MINTED, and a function that
 * answers "may this person open this space" cannot take the answer as an
 * argument. Its reads take a verified `actorUserId` instead, and that id shows
 * up in a `where` here deliberately (`isolation.test.ts`'s `SCOPED_CALLS`
 * table carries a note explaining the omission, so "not swept" and "forgotten"
 * read differently). Nothing below asserts a `spaceId` filter for that reason;
 * asserting one would fail against correct code.
 *
 * What matters instead:
 *
 *   1. **`createGroupWithSpace` writes `ownerUserId: null` and `kind: 'group'`.**
 *      A group space that acquires an owner is a shared workspace destroyed the
 *      moment one member closes their account. A `CHECK` constraint (drift
 *      probe B12) catches this at the database; this test catches it first.
 *   2. **The founding member is `role: 'admin'` with a non-null `joinedAt`.** A
 *      group with no admin cannot be administered.
 *   3. **`markInviteAccepted` and `acceptInviteAndJoin` are compare-and-set.**
 *      Both `where` clauses carry `acceptedAt: null, revokedAt: null`, so two
 *      racing requests produce one acceptance and one miss.
 *   4. **Neither `upsertMember` nor `acceptInviteAndJoin` moves `role`.**
 *      Accepting a stale invitation must not silently demote an admin. The
 *      latter has three cases rather than an upsert's two, because a PENDING
 *      row (§23.11's request-to-join) has to be admitted rather than left as it
 *      is, and an upsert's `update` branch cannot tell it from a joined one.
 *   5. **`upsertInvite` clears both timestamps on re-issue.** The row is the one
 *      record of "this address, this group", so leaving `acceptedAt` set meant
 *      somebody who had joined, left and been invited back could never accept.
 *      The replay it was guarding against is prevented by the token instead: the
 *      update overwrites `inviteTokenHash`, so the spent token resolves to
 *      nothing.
 *   6. **`deleteGroupSpace` deletes the space row, not the group row.** Deleting
 *      the group would strand the space and its satellites as an orphan brain
 *      no cascade can reach.
 *   7. **`listGroupMembers` orders by `joinedAt` then `createdAt`**: that order
 *      IS the last-admin succession order the service reads, not a display
 *      preference.
 *
 * @see lib/framework/resparkable/repo/groups.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db/client', () => {
  const resparkableSpace = {
    create: vi.fn(),
    delete: vi.fn(),
  };
  const resparkableGroup = {
    create: vi.fn(),
    findUnique: vi.fn().mockResolvedValue(null),
    update: vi.fn(),
  };
  const resparkableGroupMember = {
    create: vi.fn(),
    findFirst: vi.fn().mockResolvedValue(null),
    findUnique: vi.fn().mockResolvedValue(null),
    findMany: vi.fn().mockResolvedValue([]),
    count: vi.fn().mockResolvedValue(0),
    update: vi.fn(),
    upsert: vi.fn(),
    delete: vi.fn(),
  };
  const resparkableGroupInvite = {
    findMany: vi.fn().mockResolvedValue([]),
    upsert: vi.fn(),
    findUnique: vi.fn().mockResolvedValue(null),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
  };
  const tx = { resparkableSpace, resparkableGroup, resparkableGroupMember, resparkableGroupInvite };
  const client = {
    ...tx,
    $transaction: vi.fn(async (arg: unknown) => {
      if (typeof arg === 'function') {
        return (arg as (tx: unknown) => Promise<unknown>)(tx);
      }
      return undefined;
    }),
  };
  return { prisma: client };
});

import { prisma } from '@/lib/db/client';
import type { GroupCreateData } from '@/lib/framework/resparkable/repo/groups';
import {
  acceptInviteAndJoin,
  countAdmins,
  createGroupWithSpace,
  deleteGroupSpace,
  deleteMember,
  findGroupById,
  findGroupBySlug,
  findInviteByTokenHash,
  findMembership,
  findMembershipBySpace,
  listGroupInvites,
  listGroupMembers,
  listMembershipsForActor,
  markInviteAccepted,
  revokeInvite,
  updateGroup,
  updateMemberRole,
  upsertInvite,
  upsertMember,
} from '@/lib/framework/resparkable/repo/groups';

const NOW = new Date('2026-08-28T10:00:00.000Z');

const CREATE_DATA: GroupCreateData = {
  name: 'Study Group',
  slug: 'study-group',
  description: null,
  spaceId: 'grp_space_1',
  founderUserId: 'user_a',
  inboxToken: 'inbox_tok_1',
};

function memberRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'member_1',
    groupId: 'group_1',
    userId: 'user_a',
    role: 'member',
    invitedByUserId: null,
    joinedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.resparkableGroup.create).mockResolvedValue({
    id: 'group_1',
    name: CREATE_DATA.name,
    slug: CREATE_DATA.slug,
    description: CREATE_DATA.description,
    spaceId: CREATE_DATA.spaceId,
    maxMembers: 50,
    createdAt: NOW,
  } as never);
  vi.mocked(prisma.resparkableGroupMember.create).mockResolvedValue({
    ...memberRow({ groupId: 'group_1', role: 'admin' }),
    group: { id: 'group_1' },
  } as never);
});

describe('createGroupWithSpace', () => {
  it('writes ownerUserId: null and kind: "group": never an owner on a group space', async () => {
    await createGroupWithSpace(CREATE_DATA, NOW);

    const args = vi.mocked(prisma.resparkableSpace.create).mock.calls[0][0];
    expect(args.data).toMatchObject({
      spaceId: 'grp_space_1',
      kind: 'group',
      ownerUserId: null,
    });
  });

  it('marks the group space as never a default capture target', async () => {
    await createGroupWithSpace(CREATE_DATA, NOW);

    const args = vi.mocked(prisma.resparkableSpace.create).mock.calls[0][0];
    expect(args.data).toMatchObject({ isDefault: false });
  });

  it('makes the founder an admin with a non-null joinedAt: a group with no admin cannot be run', async () => {
    await createGroupWithSpace(CREATE_DATA, NOW);

    const args = vi.mocked(prisma.resparkableGroupMember.create).mock.calls[0][0];
    expect(args.data).toMatchObject({
      groupId: 'group_1',
      userId: 'user_a',
      role: 'admin',
      joinedAt: NOW,
    });
  });

  it('performs the space, group and founding membership writes inside one transaction', async () => {
    await createGroupWithSpace(CREATE_DATA, NOW);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.resparkableSpace.create).toHaveBeenCalledTimes(1);
    expect(prisma.resparkableGroup.create).toHaveBeenCalledTimes(1);
    expect(prisma.resparkableGroupMember.create).toHaveBeenCalledTimes(1);

    // The space has to exist before the group can point at it, and the group
    // has to exist before the founder's membership can name its id.
    const spaceOrder = vi.mocked(prisma.resparkableSpace.create).mock.invocationCallOrder[0];
    const groupOrder = vi.mocked(prisma.resparkableGroup.create).mock.invocationCallOrder[0];
    const memberOrder = vi.mocked(prisma.resparkableGroupMember.create).mock.invocationCallOrder[0];
    expect(spaceOrder).toBeLessThan(groupOrder);
    expect(groupOrder).toBeLessThan(memberOrder);
  });
});

describe('findMembershipBySpace', () => {
  it('looks the member up through the group’s spaceId, keyed on actor and space', async () => {
    await findMembershipBySpace('user_a', 'grp_space_1');

    expect(vi.mocked(prisma.resparkableGroupMember.findFirst).mock.calls[0][0]).toMatchObject({
      where: { userId: 'user_a', group: { spaceId: 'grp_space_1' } },
    });
  });
});

describe('findMembership', () => {
  it('looks the member up by the groupId_userId unique key', async () => {
    await findMembership('user_a', 'group_1');

    expect(vi.mocked(prisma.resparkableGroupMember.findUnique).mock.calls[0][0]).toEqual({
      where: { groupId_userId: { groupId: 'group_1', userId: 'user_a' } },
      include: { group: true },
    });
  });
});

describe('listMembershipsForActor', () => {
  it('scopes to the actor, not to any group', async () => {
    await listMembershipsForActor('user_a');

    const args = vi.mocked(prisma.resparkableGroupMember.findMany).mock.calls[0][0];
    expect(args?.where).toEqual({ userId: 'user_a' });
  });
});

describe('listGroupMembers', () => {
  it('orders by joinedAt then createdAt: this order IS the last-admin succession order', async () => {
    await listGroupMembers('group_1');

    const args = vi.mocked(prisma.resparkableGroupMember.findMany).mock.calls[0][0];
    expect(args?.where).toEqual({ groupId: 'group_1' });
    expect(args?.orderBy).toEqual([{ joinedAt: 'asc' }, { createdAt: 'asc' }]);
  });
});

describe('countAdmins', () => {
  it('counts only admins with a non-null joinedAt: a pending admin invite does not count', async () => {
    await countAdmins('group_1');

    expect(vi.mocked(prisma.resparkableGroupMember.count).mock.calls[0][0]).toEqual({
      where: { groupId: 'group_1', role: 'admin', joinedAt: { not: null } },
    });
  });
});

describe('findGroupById / findGroupBySlug', () => {
  it('looks a group up by id', async () => {
    await findGroupById('group_1');
    expect(vi.mocked(prisma.resparkableGroup.findUnique).mock.calls[0][0]).toEqual({
      where: { id: 'group_1' },
    });
  });

  it('looks a group up by slug', async () => {
    await findGroupBySlug('study-group');
    expect(vi.mocked(prisma.resparkableGroup.findUnique).mock.calls[0][0]).toEqual({
      where: { slug: 'study-group' },
    });
  });
});

describe('updateGroup', () => {
  it('updates by id with only the given fields: slug and spaceId are not patchable', async () => {
    await updateGroup('group_1', { name: 'New Name' });

    expect(vi.mocked(prisma.resparkableGroup.update).mock.calls[0][0]).toEqual({
      where: { id: 'group_1' },
      data: { name: 'New Name' },
    });
  });
});

describe('updateMemberRole', () => {
  it('updates the role by the groupId_userId unique key', async () => {
    await updateMemberRole('group_1', 'user_b', 'admin');

    expect(vi.mocked(prisma.resparkableGroupMember.update).mock.calls[0][0]).toEqual({
      where: { groupId_userId: { groupId: 'group_1', userId: 'user_b' } },
      data: { role: 'admin' },
    });
  });
});

describe('upsertMember', () => {
  it('never moves role on update: accepting a stale invitation must not demote an admin', async () => {
    await upsertMember({
      groupId: 'group_1',
      userId: 'user_b',
      role: 'member',
      invitedByUserId: 'user_a',
      joinedAt: NOW,
    });

    const args = vi.mocked(prisma.resparkableGroupMember.upsert).mock.calls[0][0];
    expect(args.where).toEqual({ groupId_userId: { groupId: 'group_1', userId: 'user_b' } });
    expect(args.update).toEqual({ joinedAt: NOW });
    expect(args.update).not.toHaveProperty('role');
  });
});

describe('deleteMember', () => {
  it('deletes by the groupId_userId unique key', async () => {
    await deleteMember('group_1', 'user_b');

    expect(vi.mocked(prisma.resparkableGroupMember.delete).mock.calls[0][0]).toEqual({
      where: { groupId_userId: { groupId: 'group_1', userId: 'user_b' } },
    });
  });
});

describe('deleteGroupSpace', () => {
  it('deletes the SPACE row, not the group row: deleting the group would orphan the brain', async () => {
    await deleteGroupSpace('grp_space_1');

    expect(prisma.resparkableSpace.delete).toHaveBeenCalledWith({
      where: { spaceId: 'grp_space_1' },
    });
    expect(prisma.resparkableGroup.update).not.toHaveBeenCalled();
    // Nothing in this file calls resparkableGroup.delete at all: the space
    // cascade is the entire deletion path.
  });
});

describe('listGroupInvites', () => {
  it('scopes to the group, newest first', async () => {
    await listGroupInvites('group_1');

    expect(vi.mocked(prisma.resparkableGroupInvite.findMany).mock.calls[0][0]).toEqual({
      where: { groupId: 'group_1' },
      orderBy: { createdAt: 'desc' },
    });
  });
});

describe('upsertInvite', () => {
  it('targets the groupId_email unique key, so re-inviting is one row not two', async () => {
    await upsertInvite({
      groupId: 'group_1',
      email: 'b@example.com',
      role: 'member',
      invitedByUserId: 'user_a',
      inviteTokenHash: 'digest_1',
      expiresAt: null,
    });

    const args = vi.mocked(prisma.resparkableGroupInvite.upsert).mock.calls[0][0];
    expect(args.where).toEqual({ groupId_email: { groupId: 'group_1', email: 'b@example.com' } });
  });

  it('clears both timestamps on re-issue, and rotates the token that makes that safe', async () => {
    await upsertInvite({
      groupId: 'group_1',
      email: 'b@example.com',
      role: 'member',
      invitedByUserId: 'user_a',
      inviteTokenHash: 'digest_2',
      expiresAt: null,
    });

    const args = vi.mocked(prisma.resparkableGroupInvite.upsert).mock.calls[0][0];

    // This row is the deployment's single record of "this address, this group",
    // so an earlier version that left `acceptedAt` set meant somebody who had
    // joined, left and been invited back could never accept: the fresh token was
    // rejected as unknown, and it surfaced as an unexplained "not available".
    expect(args.update).toMatchObject({ revokedAt: null, acceptedAt: null });

    // The replay that reset was guarding against is prevented by the token
    // rotation instead, and prevented better: the digest is overwritten in the
    // same statement, so the previously spent token now resolves to no row at
    // all. Asserting the two together is the point. Either alone is wrong.
    expect(args.update).toMatchObject({ inviteTokenHash: 'digest_2' });
  });
});

describe('findInviteByTokenHash', () => {
  it('resolves by the token digest, never the raw token', async () => {
    await findInviteByTokenHash('digest_1');

    expect(vi.mocked(prisma.resparkableGroupInvite.findUnique).mock.calls[0][0]).toEqual({
      where: { inviteTokenHash: 'digest_1' },
      include: { group: true },
    });
  });
});

describe('markInviteAccepted', () => {
  it('is a compare-and-set: the where excludes already-accepted and revoked rows', async () => {
    await markInviteAccepted('invite_1', NOW);

    const args = vi.mocked(prisma.resparkableGroupInvite.updateMany).mock.calls[0][0];
    expect(args.where).toEqual({ id: 'invite_1', acceptedAt: null, revokedAt: null });
    expect(args.data).toEqual({ acceptedAt: NOW });
  });
});

describe('revokeInvite', () => {
  it('excludes already-revoked rows, so a second press moves nothing', async () => {
    await revokeInvite('group_1', 'invite_1', NOW);

    const args = vi.mocked(prisma.resparkableGroupInvite.updateMany).mock.calls[0][0];
    expect(args.where).toEqual({ id: 'invite_1', groupId: 'group_1', revokedAt: null });
    expect(args.data).toEqual({ revokedAt: NOW });
  });
});

describe('acceptInviteAndJoin', () => {
  const INVITE = { id: 'invite_1', groupId: 'group_1', role: 'member', invitedByUserId: 'user_a' };

  it('runs the spend-the-invite and create-the-membership writes inside one transaction', async () => {
    vi.mocked(prisma.resparkableGroupInvite.updateMany).mockResolvedValue({ count: 1 });
    vi.mocked(prisma.resparkableGroupMember.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.resparkableGroupMember.create).mockResolvedValue(memberRow());

    await acceptInviteAndJoin(INVITE, 'user_b', NOW);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('is a compare-and-set on the invite: the where excludes accepted and revoked rows', async () => {
    vi.mocked(prisma.resparkableGroupInvite.updateMany).mockResolvedValue({ count: 1 });
    vi.mocked(prisma.resparkableGroupMember.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.resparkableGroupMember.create).mockResolvedValue(memberRow());

    await acceptInviteAndJoin(INVITE, 'user_b', NOW);

    const spendArgs = vi.mocked(prisma.resparkableGroupInvite.updateMany).mock.calls[0][0];
    expect(spendArgs.where).toEqual({ id: 'invite_1', acceptedAt: null, revokedAt: null });
    expect(spendArgs.data).toEqual({ acceptedAt: NOW });
  });

  it('returns null and creates no membership when the compare-and-set loses', async () => {
    vi.mocked(prisma.resparkableGroupInvite.updateMany).mockResolvedValue({ count: 0 });

    await expect(acceptInviteAndJoin(INVITE, 'user_b', NOW)).resolves.toBeNull();
    expect(prisma.resparkableGroupMember.create).not.toHaveBeenCalled();
    expect(prisma.resparkableGroupMember.update).not.toHaveBeenCalled();
  });

  it('creates the membership, joined now, when there is no row', async () => {
    vi.mocked(prisma.resparkableGroupInvite.updateMany).mockResolvedValue({ count: 1 });
    vi.mocked(prisma.resparkableGroupMember.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.resparkableGroupMember.create).mockResolvedValue(memberRow());

    const outcome = await acceptInviteAndJoin(INVITE, 'user_b', NOW);

    expect(outcome?.joinedNow).toBe(true);
    const args = vi.mocked(prisma.resparkableGroupMember.create).mock.calls[0][0];
    expect(args.data).toMatchObject({
      groupId: 'group_1',
      userId: 'user_b',
      role: 'member',
      invitedByUserId: 'user_a',
      joinedAt: NOW,
    });
  });

  it('admits a PENDING row rather than leaving it pending', async () => {
    // The case an upsert's two branches could not express, and the reason this
    // is a read plus a branch. `joinedAt: null` is §23.11's request-to-join:
    // under the old `update: {}` the invitation was marked spent, the caller was
    // told they had joined, and the person still resolved to no scope at all,
    // with no second invitation issuable because the row already existed.
    vi.mocked(prisma.resparkableGroupInvite.updateMany).mockResolvedValue({ count: 1 });
    vi.mocked(prisma.resparkableGroupMember.findUnique).mockResolvedValue(
      memberRow({ joinedAt: null })
    );
    vi.mocked(prisma.resparkableGroupMember.update).mockResolvedValue(memberRow());

    const outcome = await acceptInviteAndJoin(INVITE, 'user_b', NOW);

    expect(outcome?.joinedNow).toBe(true);
    const args = vi.mocked(prisma.resparkableGroupMember.update).mock.calls[0][0];
    expect(args.where).toEqual({ groupId_userId: { groupId: 'group_1', userId: 'user_b' } });
    // `joinedAt` only. The pending row carries whatever role the request to join
    // was filed under, and an invitation is not the place to change it.
    expect(args.data).toEqual({ joinedAt: NOW });
  });

  it('moves nothing for somebody already joined, and says they did not join now', async () => {
    // A second invitation to an existing member. Accepting a stale link must not
    // change a role: an admin would be quietly demoted to whatever it said.
    vi.mocked(prisma.resparkableGroupInvite.updateMany).mockResolvedValue({ count: 1 });
    vi.mocked(prisma.resparkableGroupMember.findUnique).mockResolvedValue(
      memberRow({ role: 'admin' })
    );

    const outcome = await acceptInviteAndJoin(INVITE, 'user_b', NOW);

    expect(outcome?.joinedNow).toBe(false);
    expect(outcome?.member.role).toBe('admin');
    expect(prisma.resparkableGroupMember.update).not.toHaveBeenCalled();
    expect(prisma.resparkableGroupMember.create).not.toHaveBeenCalled();
  });
});
