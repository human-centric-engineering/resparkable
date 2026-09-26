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
    deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
  };
  const resparkableGroup = {
    create: vi.fn(),
    findMany: vi.fn().mockResolvedValue([]),
    findFirst: vi.fn().mockResolvedValue(null),
    findUnique: vi.fn().mockResolvedValue(null),
    update: vi.fn(),
    updateMany: vi.fn().mockResolvedValue({ count: 0 }),
  };
  const resparkableGroupMember = {
    create: vi.fn(),
    createMany: vi.fn().mockResolvedValue({ count: 0 }),
    findFirst: vi.fn().mockResolvedValue(null),
    findUnique: vi.fn().mockResolvedValue(null),
    findMany: vi.fn().mockResolvedValue([]),
    count: vi.fn().mockResolvedValue(0),
    update: vi.fn(),
    updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    upsert: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
  };
  const resparkableGroupInvite = {
    findMany: vi.fn().mockResolvedValue([]),
    upsert: vi.fn(),
    findUnique: vi.fn().mockResolvedValue(null),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
  };
  const resparkableGroupJoinLink = {
    create: vi.fn(),
    findMany: vi.fn().mockResolvedValue([]),
    findUnique: vi.fn().mockResolvedValue(null),
    updateMany: vi.fn().mockResolvedValue({ count: 0 }),
  };
  // `lockGroup` runs `tx.$queryRaw` FOR NO KEY UPDATE first, inside the same
  // transaction client the rest of `redeemJoinLink`/`approveJoinRequest` use.
  // `listUnnotifiedSoleAdmins` calls `prisma.$queryRaw` directly, with no
  // transaction, so one mock covers both call shapes.
  const queryRaw = vi.fn().mockResolvedValue([]);
  const tx = {
    resparkableSpace,
    resparkableGroup,
    resparkableGroupMember,
    resparkableGroupInvite,
    resparkableGroupJoinLink,
    $queryRaw: queryRaw,
  };
  const client = {
    ...tx,
    user: { findMany: vi.fn().mockResolvedValue([]) },
    $queryRaw: queryRaw,
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
  approveJoinRequest,
  countAdmins,
  createGroupWithSpace,
  createJoinLink,
  deleteGroupSpace,
  deleteGroupSpaceIfLastMember,
  returnJoinLinkUsesForErasure,
  deleteGroupSpaceIfMemberless,
  deleteJoinRequest,
  deleteMember,
  findGroupById,
  findGroupBySlug,
  claimLargeRunAlert,
  releaseLargeRunAlert,
  findAccountNames,
  findGroupBySpaceId,
  findGroupLabelsBySpaceIds,
  findInviteByTokenHash,
  findJoinLinkByTokenHash,
  findMembership,
  findMembershipBySpace,
  listGroupInvites,
  listGroupMembers,
  listGroupsWithoutAdmin,
  listJoinedGroupsForErasure,
  listJoinLinks,
  listMemberContacts,
  listMembershipsForActor,
  listUnnotifiedSoleAdmins,
  markSoleAdminNotified,
  markInviteAccepted,
  redeemJoinLink,
  revokeInvite,
  revokeJoinLink,
  updateGroup,
  updateMemberDailyCreditCap,
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
  timezone: 'Europe/London',
};

function memberRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'member_1',
    groupId: 'group_1',
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
    viewersCanInheritAdmin: true,
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

describe('claimLargeRunAlert', () => {
  const NOW = new Date('2026-09-25T10:00:00.000Z');
  const DAY = 24 * 60 * 60_000;

  it('claims only when the alert has never gone out or went out before the window', async () => {
    vi.mocked(prisma.resparkableGroup.updateMany).mockResolvedValue({ count: 1 });

    await expect(claimLargeRunAlert('group_1', NOW, DAY)).resolves.toBe(true);
    expect(prisma.resparkableGroup.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'group_1',
        OR: [
          { largeRunAlertedAt: null },
          { largeRunAlertedAt: { lt: new Date(NOW.getTime() - DAY) } },
        ],
      },
      data: { largeRunAlertedAt: NOW },
    });
  });

  it('refuses when another debit already claimed it inside the window', async () => {
    vi.mocked(prisma.resparkableGroup.updateMany).mockResolvedValue({ count: 0 });

    await expect(claimLargeRunAlert('group_1', NOW, DAY)).resolves.toBe(false);
  });
});

describe('releaseLargeRunAlert', () => {
  it('gives back only the claim it stamped, matched by the same claimedAt', async () => {
    const claimedAt = new Date('2026-09-25T10:00:00.000Z');
    vi.mocked(prisma.resparkableGroup.updateMany).mockResolvedValue({ count: 1 });

    await releaseLargeRunAlert('group_1', claimedAt);

    expect(prisma.resparkableGroup.updateMany).toHaveBeenCalledWith({
      where: { id: 'group_1', largeRunAlertedAt: claimedAt },
      data: { largeRunAlertedAt: null },
    });
  });
});

describe('findGroupBySpaceId', () => {
  it('finds the group that owns a space', async () => {
    vi.mocked(prisma.resparkableGroup.findFirst).mockResolvedValue({
      id: 'group_1',
    } as never);

    const group = await findGroupBySpaceId('grp_space_1');

    expect(group).toEqual({ id: 'group_1' });
    expect(prisma.resparkableGroup.findFirst).toHaveBeenCalledWith({
      where: { spaceId: 'grp_space_1' },
    });
  });

  it('returns null for a personal space, or any space with no group', async () => {
    vi.mocked(prisma.resparkableGroup.findFirst).mockResolvedValue(null);

    await expect(findGroupBySpaceId('user_a')).resolves.toBeNull();
  });
});

describe('findGroupLabelsBySpaceIds', () => {
  it('returns an empty map without a query when given no ids', async () => {
    const labels = await findGroupLabelsBySpaceIds([]);

    expect(labels).toEqual(new Map());
    expect(prisma.resparkableGroup.findMany).not.toHaveBeenCalled();
  });

  it('dedupes the ids it queries with and maps each row to its label', async () => {
    vi.mocked(prisma.resparkableGroup.findMany).mockResolvedValue([
      { id: 'group_1', spaceId: 'grp_space_1', name: 'Study Group', _count: { members: 3 } },
    ] as never);

    const labels = await findGroupLabelsBySpaceIds(['grp_space_1', 'grp_space_1']);

    expect(prisma.resparkableGroup.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { spaceId: { in: ['grp_space_1'] } } })
    );
    expect(labels.get('grp_space_1')).toEqual({
      groupId: 'group_1',
      spaceId: 'grp_space_1',
      name: 'Study Group',
      memberCount: 3,
    });
  });

  it('leaves a space id absent from the map when it is not a group (or is gone)', async () => {
    vi.mocked(prisma.resparkableGroup.findMany).mockResolvedValue([]);

    const labels = await findGroupLabelsBySpaceIds(['user_a']);

    expect(labels.has('user_a')).toBe(false);
  });
});

describe('findAccountNames', () => {
  it('returns an empty map without a query when given no ids', async () => {
    const names = await findAccountNames([]);

    expect(names).toEqual(new Map());
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });

  it('selects only id and name, never email or any other column', async () => {
    vi.mocked(prisma.user.findMany).mockResolvedValue([{ id: 'user_a', name: 'Ana' }] as never);

    await findAccountNames(['user_a']);

    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['user_a'] } },
      select: { id: true, name: true },
    });
  });

  it('de-duplicates the ids it queries with', async () => {
    vi.mocked(prisma.user.findMany).mockResolvedValue([{ id: 'user_a', name: 'Ana' }] as never);

    await findAccountNames(['user_a', 'user_a', 'user_a']);

    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ['user_a'] } } })
    );
  });

  it('maps each row to its id, and a null name stays null', async () => {
    vi.mocked(prisma.user.findMany).mockResolvedValue([
      { id: 'user_a', name: 'Ana' },
      { id: 'user_b', name: null },
    ] as never);

    const names = await findAccountNames(['user_a', 'user_b']);

    expect(names.get('user_a')).toBe('Ana');
    expect(names.get('user_b')).toBeNull();
  });

  it('leaves an id absent from the map when no user matched it', async () => {
    vi.mocked(prisma.user.findMany).mockResolvedValue([]);

    const names = await findAccountNames(['user_gone']);

    expect(names.has('user_gone')).toBe(false);
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

describe('updateMemberDailyCreditCap', () => {
  it('sets the cap and re-reads the row when a joined member matched', async () => {
    vi.mocked(prisma.resparkableGroupMember.updateMany).mockResolvedValue({ count: 1 });
    vi.mocked(prisma.resparkableGroupMember.findUnique).mockResolvedValue(
      memberRow({ dailyCreditCap: 50 })
    );

    const result = await updateMemberDailyCreditCap('group_1', 'user_b', 50);

    expect(prisma.resparkableGroupMember.updateMany).toHaveBeenCalledWith({
      where: { groupId: 'group_1', userId: 'user_b', joinedAt: { not: null } },
      data: { dailyCreditCap: 50 },
    });
    expect(prisma.resparkableGroupMember.findUnique).toHaveBeenCalledWith({
      where: { groupId_userId: { groupId: 'group_1', userId: 'user_b' } },
    });
    expect(result).toMatchObject({ dailyCreditCap: 50 });
  });

  it('returns null without a re-read when nobody joined matched: a pending request has nothing to cap', async () => {
    vi.mocked(prisma.resparkableGroupMember.updateMany).mockResolvedValue({ count: 0 });

    const result = await updateMemberDailyCreditCap('group_1', 'user_pending', 25);

    expect(result).toBeNull();
    expect(prisma.resparkableGroupMember.findUnique).not.toHaveBeenCalled();
  });

  it('clears the cap by passing null through untouched', async () => {
    vi.mocked(prisma.resparkableGroupMember.updateMany).mockResolvedValue({ count: 1 });
    vi.mocked(prisma.resparkableGroupMember.findUnique).mockResolvedValue(
      memberRow({ dailyCreditCap: null })
    );

    await updateMemberDailyCreditCap('group_1', 'user_b', null);

    expect(prisma.resparkableGroupMember.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { dailyCreditCap: null } })
    );
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

describe('deleteGroupSpaceIfLastMember', () => {
  it('takes the group lock, then deletes the space when nobody but the leaver has joined', async () => {
    vi.mocked(prisma.resparkableGroupMember.count).mockResolvedValueOnce(0);

    expect(await deleteGroupSpaceIfLastMember('group_1', 'grp_space_1', 'user_a')).toBe(true);

    // The count excludes the leaver and pending rows: a request to join is not
    // somebody the group would be deleted out from under.
    expect(prisma.resparkableGroupMember.count).toHaveBeenCalledWith({
      where: { groupId: 'group_1', joinedAt: { not: null }, userId: { not: 'user_a' } },
    });
    expect(prisma.resparkableSpace.delete).toHaveBeenCalledWith({
      where: { spaceId: 'grp_space_1' },
    });
    const lockOrder = vi.mocked(prisma.$queryRaw).mock.invocationCallOrder[0];
    const countOrder = vi.mocked(prisma.resparkableGroupMember.count).mock.invocationCallOrder[0];
    expect(lockOrder).toBeLessThan(countOrder);
    const [strings] = vi.mocked(prisma.$queryRaw).mock.calls[0] as unknown as [
      TemplateStringsArray,
      ...unknown[],
    ];
    expect(strings.join('?')).toContain('FOR NO KEY UPDATE');
  });

  it('deletes nothing when somebody joined after the caller counted', async () => {
    // The race it exists for: an open link admitted somebody between the
    // service's unlocked count and this delete.
    vi.mocked(prisma.resparkableGroupMember.count).mockResolvedValueOnce(1);

    expect(await deleteGroupSpaceIfLastMember('group_1', 'grp_space_1', 'user_a')).toBe(false);
    expect(prisma.resparkableSpace.delete).not.toHaveBeenCalled();
  });
});

describe('returnJoinLinkUsesForErasure', () => {
  it("gives each pending request's link back one use, never below zero", async () => {
    vi.mocked(prisma.resparkableGroupMember.findMany).mockResolvedValueOnce([
      { joinLinkId: 'link_1' },
      { joinLinkId: 'link_2' },
    ] as never);
    vi.mocked(prisma.resparkableGroupJoinLink.updateMany)
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    expect(await returnJoinLinkUsesForErasure('user_erased')).toBe(1);

    // Pending rows with a link only: a joined member got in, so their use stays
    // spent, and a row with no link took nothing.
    expect(prisma.resparkableGroupMember.findMany).toHaveBeenCalledWith({
      where: { userId: 'user_erased', joinedAt: null, joinLinkId: { not: null } },
      select: { joinLinkId: true },
    });
    expect(prisma.resparkableGroupJoinLink.updateMany).toHaveBeenNthCalledWith(1, {
      where: { id: 'link_1', useCount: { gt: 0 } },
      data: { useCount: { decrement: 1 } },
    });
    expect(prisma.resparkableGroupJoinLink.updateMany).toHaveBeenNthCalledWith(2, {
      where: { id: 'link_2', useCount: { gt: 0 } },
      data: { useCount: { decrement: 1 } },
    });
  });

  it('writes nothing when they were waiting on nothing', async () => {
    vi.mocked(prisma.resparkableGroupMember.findMany).mockResolvedValueOnce([]);

    expect(await returnJoinLinkUsesForErasure('user_erased')).toBe(0);
    expect(prisma.resparkableGroupJoinLink.updateMany).not.toHaveBeenCalled();
  });
});

describe('listJoinedGroupsForErasure', () => {
  it('reads joined memberships only, through the client it is given', async () => {
    const db = {
      resparkableGroupMember: {
        findMany: vi.fn().mockResolvedValue([
          {
            groupId: 'group_1',
            group: { spaceId: 'grp_space_1', viewersCanInheritAdmin: false },
          },
        ]),
      },
    };

    const groups = await listJoinedGroupsForErasure('user_a', db as never);

    // The group's succession setting travels with it, so erasure honours it.
    expect(groups).toEqual([
      { groupId: 'group_1', spaceId: 'grp_space_1', viewersCanInheritAdmin: false },
    ]);
    // Through the erasure transaction, never the global client, and a pending
    // row is left out: a request to join has no bearing on succession.
    expect(prisma.resparkableGroupMember.findMany).not.toHaveBeenCalled();
    expect(db.resparkableGroupMember.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'user_a', joinedAt: { not: null } } })
    );
  });
});

describe('listMemberContacts', () => {
  it('returns the addresses of joined members and drops a user with no email', async () => {
    vi.mocked(prisma.resparkableGroupMember.findMany).mockResolvedValue([
      { userId: 'user_a' },
      { userId: 'user_b' },
    ] as never);
    vi.mocked(prisma.user.findMany).mockResolvedValue([
      { id: 'user_a', email: 'a@example.com', name: null },
      { id: 'user_b', email: '', name: 'B' },
    ] as never);

    const contacts = await listMemberContacts('group_1');

    expect(contacts).toEqual([{ userId: 'user_a', email: 'a@example.com', name: null }]);
    expect(prisma.resparkableGroupMember.findMany).toHaveBeenCalledWith({
      where: { groupId: 'group_1', joinedAt: { not: null } },
      select: { userId: true },
    });
    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['user_a', 'user_b'] } },
      select: { id: true, email: true, name: true },
    });
  });

  it('skips the user read when nobody is joined', async () => {
    vi.mocked(prisma.resparkableGroupMember.findMany).mockResolvedValue([]);

    expect(await listMemberContacts('group_1')).toEqual([]);
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });

  it('adds a role filter when roles are given, for the admin-only alert path', async () => {
    vi.mocked(prisma.resparkableGroupMember.findMany).mockResolvedValue([
      { userId: 'user_a' },
    ] as never);
    vi.mocked(prisma.user.findMany).mockResolvedValue([
      { id: 'user_a', email: 'a@example.com', name: 'A' },
    ] as never);

    await listMemberContacts('group_1', { roles: ['admin'] });

    expect(prisma.resparkableGroupMember.findMany).toHaveBeenCalledWith({
      where: { groupId: 'group_1', joinedAt: { not: null }, role: { in: ['admin'] } },
      select: { userId: true },
    });
  });

  it('does not add a role filter at all when none is given', async () => {
    vi.mocked(prisma.resparkableGroupMember.findMany).mockResolvedValue([
      { userId: 'user_a' },
    ] as never);
    vi.mocked(prisma.user.findMany).mockResolvedValue([
      { id: 'user_a', email: 'a@example.com', name: 'A' },
    ] as never);

    await listMemberContacts('group_1');

    const where = vi.mocked(prisma.resparkableGroupMember.findMany).mock.calls[0]?.[0]?.where;
    expect(where).not.toHaveProperty('role');
  });
});

describe('listGroupsWithoutAdmin', () => {
  it('matches groups with no JOINED admin that the rule can act on, oldest first, bounded', async () => {
    vi.mocked(prisma.resparkableGroup.findMany).mockResolvedValue([
      { id: 'group_1', spaceId: 'grp_space_1', viewersCanInheritAdmin: true },
    ] as never);

    const groups = await listGroupsWithoutAdmin(25);

    expect(groups).toEqual([
      { groupId: 'group_1', spaceId: 'grp_space_1', viewersCanInheritAdmin: true },
    ]);
    // A pending admin row is a request to join, not an admin: it must not
    // hide a stranded group from the sweep. The OR leaves out a group that is
    // admin-less by its own choice (viewers may not inherit, only viewers
    // joined), which would otherwise match forever and starve the batch, while
    // still matching one with nobody joined at all, which must be deleted.
    expect(prisma.resparkableGroup.findMany).toHaveBeenCalledWith({
      where: {
        members: { none: { role: 'admin', joinedAt: { not: null } } },
        OR: [
          { viewersCanInheritAdmin: true },
          { members: { some: { joinedAt: { not: null }, role: { not: 'viewer' } } } },
          { members: { none: { joinedAt: { not: null } } } },
        ],
      },
      select: { id: true, spaceId: true, viewersCanInheritAdmin: true },
      orderBy: { createdAt: 'asc' },
      take: 25,
    });
  });
});

describe('listUnnotifiedSoleAdmins', () => {
  it('asks the database with the limit as a bound parameter', async () => {
    const row = {
      memberId: 'member_1',
      groupId: 'group_1',
      groupName: 'Study Group',
      viewersCanInheritAdmin: true,
      email: 'a@example.com',
      name: null,
    };
    vi.mocked(prisma.$queryRaw).mockResolvedValue([row] as never);

    expect(await listUnnotifiedSoleAdmins(10)).toEqual([row]);

    const [strings, ...values] = vi.mocked(prisma.$queryRaw).mock.calls[0] as unknown as [
      TemplateStringsArray,
      ...unknown[],
    ];
    const sql = strings.join('?');
    // The shape of "sole admin, not yet told, somebody else joined". The real
    // query is exercised against Postgres by the group-erasure smoke.
    expect(sql).toContain('"soleAdminNotifiedAt" IS NULL');
    expect(sql).toMatch(/NOT EXISTS[\s\S]*"role" = 'admin'/);
    expect(sql).toContain('m."joinedAt" IS NOT NULL');
    expect(values).toEqual([10]);
  });

  it('does not query for a non-positive limit', async () => {
    expect(await listUnnotifiedSoleAdmins(0)).toEqual([]);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });
});

describe('markSoleAdminNotified', () => {
  it('stamps the one membership row', async () => {
    await markSoleAdminNotified('member_1', NOW);

    expect(prisma.resparkableGroupMember.update).toHaveBeenCalledWith({
      where: { id: 'member_1' },
      data: { soleAdminNotifiedAt: NOW },
    });
  });
});

describe('deleteGroupSpaceIfMemberless', () => {
  it('re-checks for joined members inside the delete, and only on a group space', async () => {
    vi.mocked(prisma.resparkableSpace.deleteMany).mockResolvedValue({ count: 1 });

    expect(await deleteGroupSpaceIfMemberless('group_1', 'grp_space_1')).toBe(true);

    // The condition lives in the statement, so a member who joined after the
    // sweep read the group keeps it. `kind: 'group'` means no argument can
    // reach a personal brain through this path.
    expect(prisma.resparkableSpace.deleteMany).toHaveBeenCalledWith({
      where: {
        spaceId: 'grp_space_1',
        kind: 'group',
        groups: {
          some: { id: 'group_1', members: { none: { joinedAt: { not: null } } } },
        },
      },
    });
    expect(prisma.resparkableSpace.delete).not.toHaveBeenCalled();
  });

  it('reports false when the condition no longer holds', async () => {
    vi.mocked(prisma.resparkableSpace.deleteMany).mockResolvedValue({ count: 0 });

    expect(await deleteGroupSpaceIfMemberless('group_1', 'grp_space_1')).toBe(false);
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

  it('takes the group row lock, FOR NO KEY UPDATE, before spending the invite', async () => {
    // The same lock a join-link redemption takes, so an invitation accepted at
    // the moment the same person redeems a link cannot race it to the row.
    vi.mocked(prisma.resparkableGroupInvite.updateMany).mockResolvedValue({ count: 1 });
    vi.mocked(prisma.resparkableGroupMember.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.resparkableGroupMember.create).mockResolvedValue(memberRow());

    await acceptInviteAndJoin(INVITE, 'user_b', NOW);

    const lockOrder = vi.mocked(prisma.$queryRaw).mock.invocationCallOrder[0];
    const spendOrder = vi.mocked(prisma.resparkableGroupInvite.updateMany).mock
      .invocationCallOrder[0];
    expect(lockOrder).toBeLessThan(spendOrder);

    const [strings] = vi.mocked(prisma.$queryRaw).mock.calls[0] as unknown as [
      TemplateStringsArray,
      ...unknown[],
    ];
    expect(strings.join('?')).toContain('FOR NO KEY UPDATE');
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
    // `joinedAt`, `role`, AND `invitedByUserId`: the invitation's role replaces
    // the request's (decided 2026-09-25). An admin naming this person is a later
    // and more deliberate act than the link they happened to click, so it wins.
    // Safe because an invitation's role is never `admin`. The inviter is stamped
    // too, so "who invited this member" (the Art. 15 export's `invitedAt`) has
    // an answer for somebody who came in through a link and was then invited.
    expect(args.data).toEqual({ joinedAt: NOW, role: 'member', invitedByUserId: 'user_a' });
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

// ─── Join links (§23.11, phase 57) ──────────────────────────────────────────

describe('createJoinLink', () => {
  it('passes the mint data straight through', async () => {
    await createJoinLink({
      groupId: 'group_1',
      tokenHash: 'digest_1',
      tokenPrefix: 'abcdef',
      role: 'member',
      approval: 'request',
      maxUses: 10,
      expiresAt: NOW,
    });

    expect(vi.mocked(prisma.resparkableGroupJoinLink.create).mock.calls[0][0]).toEqual({
      data: {
        groupId: 'group_1',
        tokenHash: 'digest_1',
        tokenPrefix: 'abcdef',
        role: 'member',
        approval: 'request',
        maxUses: 10,
        expiresAt: NOW,
      },
    });
  });
});

describe('listJoinLinks', () => {
  it('scopes to the group, newest first, revoked and expired included', async () => {
    await listJoinLinks('group_1');

    expect(vi.mocked(prisma.resparkableGroupJoinLink.findMany).mock.calls[0][0]).toEqual({
      where: { groupId: 'group_1' },
      orderBy: { createdAt: 'desc' },
    });
  });
});

describe('revokeJoinLink', () => {
  it('excludes an already-revoked link, so a second press moves nothing', async () => {
    await revokeJoinLink('group_1', 'link_1', NOW);

    expect(vi.mocked(prisma.resparkableGroupJoinLink.updateMany).mock.calls[0][0]).toEqual({
      where: { id: 'link_1', groupId: 'group_1', revokedAt: null },
      data: { revokedAt: NOW },
    });
  });
});

describe('findJoinLinkByTokenHash', () => {
  it('resolves by the token digest, never the raw token, with the group included', async () => {
    await findJoinLinkByTokenHash('digest_1');

    expect(vi.mocked(prisma.resparkableGroupJoinLink.findUnique).mock.calls[0][0]).toEqual({
      where: { tokenHash: 'digest_1' },
      include: { group: true },
    });
  });
});

describe('redeemJoinLink', () => {
  const OPEN_LINK = {
    id: 'link_1',
    groupId: 'group_1',
    role: 'member',
    approval: 'open',
    maxUses: null as number | null,
    useCount: 0,
  };
  const REQUEST_LINK = { ...OPEN_LINK, approval: 'request' };

  /** No existing row, room in the group, and both writes succeed. */
  function primeNotYetAMember(maxMembers = 50, joinedCount = 0) {
    vi.mocked(prisma.resparkableGroupMember.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.resparkableGroup.findUnique).mockResolvedValue({ maxMembers } as never);
    vi.mocked(prisma.resparkableGroupMember.count).mockResolvedValue(joinedCount);
    vi.mocked(prisma.resparkableGroupMember.createMany).mockResolvedValue({ count: 1 });
    vi.mocked(prisma.resparkableGroupJoinLink.updateMany).mockResolvedValue({ count: 1 });
  }

  it('takes the group row lock, FOR NO KEY UPDATE, before reading or writing anything else', async () => {
    primeNotYetAMember();

    await redeemJoinLink(OPEN_LINK, 'user_b', NOW);

    const lockOrder = vi.mocked(prisma.$queryRaw).mock.invocationCallOrder;
    // The mock's `$queryRaw` is shared between the transaction client and the
    // global one; `lockGroup` is the only caller inside this transaction, so its
    // one call is the first `$queryRaw` invocation the transaction makes.
    const memberReadOrder = vi.mocked(prisma.resparkableGroupMember.findUnique).mock
      .invocationCallOrder[0];
    expect(lockOrder[0]).toBeLessThan(memberReadOrder);

    // `FOR NO KEY UPDATE`, not `FOR UPDATE`: two lockers still exclude each
    // other, which is all the cap needs, but a row with a foreign key to the
    // group (an invitation, a join link) takes only `FOR KEY SHARE` and must
    // not queue behind every redemption.
    const [strings] = vi.mocked(prisma.$queryRaw).mock.calls[0] as unknown as [
      TemplateStringsArray,
      ...unknown[],
    ];
    expect(strings.join('?')).toContain('FOR NO KEY UPDATE');
  });

  it('reads the existing row by id and joinedAt only', async () => {
    primeNotYetAMember();

    await redeemJoinLink(OPEN_LINK, 'user_b', NOW);

    expect(vi.mocked(prisma.resparkableGroupMember.findUnique).mock.calls[0][0]).toEqual({
      where: { groupId_userId: { groupId: 'group_1', userId: 'user_b' } },
      select: { id: true, joinedAt: true },
    });
  });

  it('answers already_member for an existing joined row, whatever the link’s approval, before even checking whether the link is used up', async () => {
    vi.mocked(prisma.resparkableGroupMember.findUnique).mockResolvedValue({
      id: 'member_existing',
      joinedAt: NOW,
    } as never);

    // A used-up link too: the existing-row answer comes first regardless.
    const outcome = await redeemJoinLink({ ...OPEN_LINK, maxUses: 1, useCount: 1 }, 'user_b', NOW);

    expect(outcome).toEqual({ kind: 'already_member' });
    expect(prisma.resparkableGroup.findUnique).not.toHaveBeenCalled();
    expect(prisma.resparkableGroupJoinLink.updateMany).not.toHaveBeenCalled();
    expect(prisma.resparkableGroupMember.create).not.toHaveBeenCalled();
    expect(prisma.resparkableGroupMember.createMany).not.toHaveBeenCalled();
    expect(prisma.resparkableGroupMember.update).not.toHaveBeenCalled();
    expect(prisma.resparkableGroupMember.updateMany).not.toHaveBeenCalled();
  });

  it('answers already_requested for a pending row holding another request link, spending no use and writing no row', async () => {
    vi.mocked(prisma.resparkableGroupMember.findUnique).mockResolvedValue({
      id: 'member_existing',
      joinedAt: null,
    } as never);

    const outcome = await redeemJoinLink(REQUEST_LINK, 'user_b', NOW);

    expect(outcome).toEqual({ kind: 'already_requested' });
    expect(prisma.resparkableGroup.findUnique).not.toHaveBeenCalled();
    expect(prisma.resparkableGroupJoinLink.updateMany).not.toHaveBeenCalled();
    expect(prisma.resparkableGroupMember.create).not.toHaveBeenCalled();
    expect(prisma.resparkableGroupMember.createMany).not.toHaveBeenCalled();
    expect(prisma.resparkableGroupMember.update).not.toHaveBeenCalled();
  });

  it('answers spent for a used-up link before reading the group at all, with no existing row', async () => {
    vi.mocked(prisma.resparkableGroupMember.findUnique).mockResolvedValue(null);

    const outcome = await redeemJoinLink({ ...OPEN_LINK, maxUses: 5, useCount: 5 }, 'user_b', NOW);

    expect(outcome).toEqual({ kind: 'spent' });
    // The used-up check comes before the cap check, so a link with nothing
    // left never costs a read of the group it names.
    expect(prisma.resparkableGroup.findUnique).not.toHaveBeenCalled();
    expect(prisma.resparkableGroupMember.createMany).not.toHaveBeenCalled();
    expect(prisma.resparkableGroupJoinLink.updateMany).not.toHaveBeenCalled();
  });

  it('does not treat an unlimited link (maxUses null) as used up, however high useCount is', async () => {
    primeNotYetAMember();

    const outcome = await redeemJoinLink(
      { ...OPEN_LINK, maxUses: null, useCount: 500 },
      'user_b',
      NOW
    );

    expect(outcome).toEqual({ kind: 'joined' });
  });

  it('lets a pending requester in through an open link: updates their row by id with the link’s role, spends a use, creates nothing', async () => {
    // Decided 2026-09-25: a `request` link only changes nothing for somebody
    // already waiting; an `open` one is a decision, and lets them in through
    // the same cap check and use CAS as a brand-new joiner.
    vi.mocked(prisma.resparkableGroupMember.findUnique).mockResolvedValue({
      id: 'member_existing',
      joinedAt: null,
    } as never);
    vi.mocked(prisma.resparkableGroup.findUnique).mockResolvedValue({ maxMembers: 50 } as never);
    vi.mocked(prisma.resparkableGroupMember.count).mockResolvedValue(0);
    // The admit-by-id compare-and-set: this is what makes the function skip
    // `createMany` entirely for an existing row.
    vi.mocked(prisma.resparkableGroupMember.updateMany).mockResolvedValue({ count: 1 });
    vi.mocked(prisma.resparkableGroupJoinLink.updateMany).mockResolvedValue({ count: 1 });

    const outcome = await redeemJoinLink(OPEN_LINK, 'user_b', NOW);

    expect(outcome).toEqual({ kind: 'joined' });
    expect(prisma.resparkableGroupMember.updateMany).toHaveBeenCalledWith({
      where: { id: 'member_existing', joinedAt: null },
      data: { joinedAt: NOW, role: 'member' },
    });
    // The use was spent: this is a genuine admission, going through the cap
    // like a new joiner, not a no-op like the request-link case above.
    expect(prisma.resparkableGroupJoinLink.updateMany).toHaveBeenCalled();
    expect(prisma.resparkableGroupMember.create).not.toHaveBeenCalled();
    expect(prisma.resparkableGroupMember.createMany).not.toHaveBeenCalled();
  });

  it('refuses a full group, stamps joinRefusedFullAt, and spends no use', async () => {
    primeNotYetAMember(2, 2);

    const outcome = await redeemJoinLink(OPEN_LINK, 'user_b', NOW);

    expect(outcome).toEqual({ kind: 'group_full' });
    expect(prisma.resparkableGroup.update).toHaveBeenCalledWith({
      where: { id: 'group_1' },
      data: { joinRefusedFullAt: NOW },
    });
    expect(prisma.resparkableGroupJoinLink.updateMany).not.toHaveBeenCalled();
    expect(prisma.resparkableGroupMember.createMany).not.toHaveBeenCalled();
  });

  it('writes the row (createMany) before spending the use: the admit-then-fail-to-spend test below relies on this order', async () => {
    primeNotYetAMember();

    await redeemJoinLink(OPEN_LINK, 'user_b', NOW);

    const rowOrder = vi.mocked(prisma.resparkableGroupMember.createMany).mock
      .invocationCallOrder[0];
    const spendOrder = vi.mocked(prisma.resparkableGroupJoinLink.updateMany).mock
      .invocationCallOrder[0];
    expect(rowOrder).toBeLessThan(spendOrder);
  });

  it('when the row write reports 0 rows (an invitation won the race), re-reads and answers already_member without spending a use', async () => {
    vi.mocked(prisma.resparkableGroupMember.findUnique)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ joinedAt: NOW } as never);
    vi.mocked(prisma.resparkableGroup.findUnique).mockResolvedValue({ maxMembers: 50 } as never);
    vi.mocked(prisma.resparkableGroupMember.count).mockResolvedValue(0);
    vi.mocked(prisma.resparkableGroupMember.createMany).mockResolvedValue({ count: 0 });

    const outcome = await redeemJoinLink(OPEN_LINK, 'user_b', NOW);

    expect(outcome).toEqual({ kind: 'already_member' });
    expect(prisma.resparkableGroupJoinLink.updateMany).not.toHaveBeenCalled();
    // The re-read asks the same narrow question the first read did.
    expect(vi.mocked(prisma.resparkableGroupMember.findUnique).mock.calls[1][0]).toEqual({
      where: { groupId_userId: { groupId: 'group_1', userId: 'user_b' } },
      select: { joinedAt: true },
    });
  });

  it('when the row write reports 0 rows and the winner is pending, answers already_requested without spending a use', async () => {
    vi.mocked(prisma.resparkableGroupMember.findUnique)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ joinedAt: null } as never);
    vi.mocked(prisma.resparkableGroup.findUnique).mockResolvedValue({ maxMembers: 50 } as never);
    vi.mocked(prisma.resparkableGroupMember.count).mockResolvedValue(0);
    vi.mocked(prisma.resparkableGroupMember.createMany).mockResolvedValue({ count: 0 });

    const outcome = await redeemJoinLink(REQUEST_LINK, 'user_b', NOW);

    expect(outcome).toEqual({ kind: 'already_requested' });
    expect(prisma.resparkableGroupJoinLink.updateMany).not.toHaveBeenCalled();
  });

  it('includes revokedAt: null and useCount: { lt: maxUses } in the spend where when maxUses is set', async () => {
    primeNotYetAMember();

    await redeemJoinLink({ ...OPEN_LINK, maxUses: 5 }, 'user_b', NOW);

    expect(vi.mocked(prisma.resparkableGroupJoinLink.updateMany).mock.calls[0][0]).toEqual({
      where: { id: 'link_1', revokedAt: null, useCount: { lt: 5 } },
      data: { useCount: { increment: 1 } },
    });
  });

  it('omits the useCount clause entirely when maxUses is null: unlimited', async () => {
    primeNotYetAMember();

    await redeemJoinLink(OPEN_LINK, 'user_b', NOW);

    const where = vi.mocked(prisma.resparkableGroupJoinLink.updateMany).mock.calls[0][0].where;
    expect(where).toEqual({ id: 'link_1', revokedAt: null });
    expect(where).not.toHaveProperty('useCount');
  });

  it('answers spent when the use compare-and-set loses, after the row was already written', async () => {
    // The row write (createMany) succeeds, and only the LATER use-spend CAS
    // loses. The production code throws an internal error to roll the
    // transaction back and catches it outside, turning it into `{kind:
    // 'spent'}` — this exercises that whole path, not just the return value.
    primeNotYetAMember();
    vi.mocked(prisma.resparkableGroupJoinLink.updateMany).mockResolvedValue({ count: 0 });

    const outcome = await redeemJoinLink(OPEN_LINK, 'user_b', NOW);

    expect(outcome).toEqual({ kind: 'spent' });
    expect(prisma.resparkableGroupMember.createMany).toHaveBeenCalled();
  });

  it('lets an error that is not the internal spent-signal propagate out of the function', async () => {
    primeNotYetAMember();
    const boom = new Error('connection reset');
    vi.mocked(prisma.resparkableGroupMember.createMany).mockRejectedValue(boom);

    await expect(redeemJoinLink(OPEN_LINK, 'user_b', NOW)).rejects.toBe(boom);
  });

  it('creates a joined row with createMany (skipDuplicates), no requestedAt, no inviter, and no joinLinkId for an open link', async () => {
    primeNotYetAMember();

    const outcome = await redeemJoinLink(OPEN_LINK, 'user_b', NOW);

    expect(outcome).toEqual({ kind: 'joined' });
    // `create` is no longer called by this function at all — only `createMany`.
    expect(prisma.resparkableGroupMember.create).not.toHaveBeenCalled();
    expect(vi.mocked(prisma.resparkableGroupMember.createMany).mock.calls[0][0]).toEqual({
      data: [
        {
          groupId: 'group_1',
          userId: 'user_b',
          role: 'member',
          invitedByUserId: null,
          joinedAt: NOW,
          requestedAt: null,
          // Only a request remembers its link — it is what gets the use back
          // if the request is turned down or withdrawn. An `open` join needed
          // no approval, so there is nothing to refund and nothing to remember.
          joinLinkId: null,
        },
      ],
      skipDuplicates: true,
    });
  });

  it('creates a pending row with requestedAt, a null joinedAt, and the link’s id for a request link', async () => {
    primeNotYetAMember();

    const outcome = await redeemJoinLink(REQUEST_LINK, 'user_b', NOW);

    expect(outcome).toEqual({ kind: 'requested' });
    expect(vi.mocked(prisma.resparkableGroupMember.createMany).mock.calls[0][0]).toEqual({
      data: [
        {
          groupId: 'group_1',
          userId: 'user_b',
          role: 'member',
          invitedByUserId: null,
          joinedAt: null,
          requestedAt: NOW,
          // The link that spent a use to file this request, so
          // `deleteJoinRequest` knows which link to refund if it is withdrawn
          // or rejected.
          joinLinkId: 'link_1',
        },
      ],
      skipDuplicates: true,
    });
  });
});

describe('approveJoinRequest', () => {
  it('takes the group row lock before reading the pending row', async () => {
    vi.mocked(prisma.resparkableGroup.findUnique).mockResolvedValue({ maxMembers: 50 } as never);
    vi.mocked(prisma.resparkableGroupMember.findFirst).mockResolvedValue({ id: 'mem_1' } as never);
    vi.mocked(prisma.resparkableGroupMember.count).mockResolvedValue(1);

    await approveJoinRequest('group_1', 'user_b', NOW);

    const lockOrder = vi.mocked(prisma.$queryRaw).mock.invocationCallOrder[0];
    const pendingReadOrder = vi.mocked(prisma.resparkableGroupMember.findFirst).mock
      .invocationCallOrder[0];
    expect(lockOrder).toBeLessThan(pendingReadOrder);
  });

  it('answers no_such_request when there is no pending row for that user', async () => {
    vi.mocked(prisma.resparkableGroup.findUnique).mockResolvedValue({ maxMembers: 50 } as never);
    vi.mocked(prisma.resparkableGroupMember.findFirst).mockResolvedValue(null);

    expect(await approveJoinRequest('group_1', 'user_b', NOW)).toBe('no_such_request');
    expect(prisma.resparkableGroupMember.updateMany).not.toHaveBeenCalled();
  });

  it('answers group_full at the cap and updates nothing', async () => {
    vi.mocked(prisma.resparkableGroup.findUnique).mockResolvedValue({ maxMembers: 2 } as never);
    vi.mocked(prisma.resparkableGroupMember.findFirst).mockResolvedValue({ id: 'mem_1' } as never);
    vi.mocked(prisma.resparkableGroupMember.count).mockResolvedValue(2);

    expect(await approveJoinRequest('group_1', 'user_b', NOW)).toBe('group_full');
    expect(prisma.resparkableGroupMember.updateMany).not.toHaveBeenCalled();
  });

  it('stamps joinedAt on the pending row via a compare-and-set, and answers approved, under the cap', async () => {
    vi.mocked(prisma.resparkableGroup.findUnique).mockResolvedValue({ maxMembers: 50 } as never);
    vi.mocked(prisma.resparkableGroupMember.findFirst).mockResolvedValue({ id: 'mem_1' } as never);
    vi.mocked(prisma.resparkableGroupMember.count).mockResolvedValue(1);
    vi.mocked(prisma.resparkableGroupMember.updateMany).mockResolvedValue({ count: 1 });

    expect(await approveJoinRequest('group_1', 'user_b', NOW)).toBe('approved');
    // `joinedAt: null` in the where is the load-bearing clause: withdrawing and
    // rejecting do not take the group lock, so the row can move between the
    // read above and this write, and an update by id would throw there instead
    // of answering it.
    expect(prisma.resparkableGroupMember.updateMany).toHaveBeenCalledWith({
      where: { id: 'mem_1', joinedAt: null },
      data: { joinedAt: NOW },
    });
  });

  it('answers no_such_request, not approved, when the compare-and-set loses the race', async () => {
    // The row was withdrawn or rejected between the read of `pending` and this
    // write. An update by id would throw here; the compare-and-set instead
    // reports the same refusal a caller who never found a pending row gets.
    vi.mocked(prisma.resparkableGroup.findUnique).mockResolvedValue({ maxMembers: 50 } as never);
    vi.mocked(prisma.resparkableGroupMember.findFirst).mockResolvedValue({ id: 'mem_1' } as never);
    vi.mocked(prisma.resparkableGroupMember.count).mockResolvedValue(1);
    vi.mocked(prisma.resparkableGroupMember.updateMany).mockResolvedValue({ count: 0 });

    expect(await approveJoinRequest('group_1', 'user_b', NOW)).toBe('no_such_request');
  });
});

describe('deleteJoinRequest', () => {
  it('reports false without deleting or refunding anything when there is no pending row', async () => {
    vi.mocked(prisma.resparkableGroupMember.findFirst).mockResolvedValue(null);

    expect(await deleteJoinRequest('group_1', 'user_b')).toBe(false);
    expect(prisma.resparkableGroupMember.deleteMany).not.toHaveBeenCalled();
    expect(prisma.resparkableGroupJoinLink.updateMany).not.toHaveBeenCalled();
  });

  it('takes the group row lock, FOR NO KEY UPDATE, before reading the pending row', async () => {
    // Behind the group lock like every other path that adds or removes a
    // member, so an approval or a redemption is never mid-flight on this row.
    vi.mocked(prisma.resparkableGroupMember.findFirst).mockResolvedValue({
      id: 'member_1',
      joinLinkId: null,
    } as never);
    vi.mocked(prisma.resparkableGroupMember.deleteMany).mockResolvedValue({ count: 1 });

    await deleteJoinRequest('group_1', 'user_b');

    const lockOrder = vi.mocked(prisma.$queryRaw).mock.invocationCallOrder[0];
    const readOrder = vi.mocked(prisma.resparkableGroupMember.findFirst).mock
      .invocationCallOrder[0];
    expect(lockOrder).toBeLessThan(readOrder);

    const [strings] = vi.mocked(prisma.$queryRaw).mock.calls[0] as unknown as [
      TemplateStringsArray,
      ...unknown[],
    ];
    expect(strings.join('?')).toContain('FOR NO KEY UPDATE');
  });

  it('reads the pending row by id and joinLinkId only', async () => {
    vi.mocked(prisma.resparkableGroupMember.findFirst).mockResolvedValue({
      id: 'member_1',
      joinLinkId: null,
    } as never);
    vi.mocked(prisma.resparkableGroupMember.deleteMany).mockResolvedValue({ count: 1 });

    await deleteJoinRequest('group_1', 'user_b');

    expect(vi.mocked(prisma.resparkableGroupMember.findFirst).mock.calls[0][0]).toEqual({
      where: { groupId: 'group_1', userId: 'user_b', joinedAt: null },
      select: { id: true, joinLinkId: true },
    });
  });

  it('deletes only a PENDING row, by id: joinedAt: null is in the where, so a joined member is never reachable', async () => {
    vi.mocked(prisma.resparkableGroupMember.findFirst).mockResolvedValue({
      id: 'member_1',
      joinLinkId: null,
    } as never);
    vi.mocked(prisma.resparkableGroupMember.deleteMany).mockResolvedValue({ count: 1 });

    const deleted = await deleteJoinRequest('group_1', 'user_b');

    expect(deleted).toBe(true);
    expect(prisma.resparkableGroupMember.deleteMany).toHaveBeenCalledWith({
      where: { id: 'member_1', joinedAt: null },
    });
  });

  it('reports false and refunds nothing when the delete compare-and-set loses (already gone)', async () => {
    vi.mocked(prisma.resparkableGroupMember.findFirst).mockResolvedValue({
      id: 'member_1',
      joinLinkId: 'link_1',
    } as never);
    vi.mocked(prisma.resparkableGroupMember.deleteMany).mockResolvedValue({ count: 0 });

    expect(await deleteJoinRequest('group_1', 'user_b')).toBe(false);
    // A use is never returned for a request that was not actually deleted here.
    expect(prisma.resparkableGroupJoinLink.updateMany).not.toHaveBeenCalled();
  });

  it('gives the link its use back when the deleted request named one', async () => {
    vi.mocked(prisma.resparkableGroupMember.findFirst).mockResolvedValue({
      id: 'member_1',
      joinLinkId: 'link_1',
    } as never);
    vi.mocked(prisma.resparkableGroupMember.deleteMany).mockResolvedValue({ count: 1 });

    expect(await deleteJoinRequest('group_1', 'user_b')).toBe(true);
    expect(prisma.resparkableGroupJoinLink.updateMany).toHaveBeenCalledWith({
      where: { id: 'link_1', useCount: { gt: 0 } },
      data: { useCount: { decrement: 1 } },
    });
  });

  it('refunds nothing when the deleted request names no link: an invitation or an open link left nothing to give back', async () => {
    vi.mocked(prisma.resparkableGroupMember.findFirst).mockResolvedValue({
      id: 'member_1',
      joinLinkId: null,
    } as never);
    vi.mocked(prisma.resparkableGroupMember.deleteMany).mockResolvedValue({ count: 1 });

    expect(await deleteJoinRequest('group_1', 'user_b')).toBe(true);
    expect(prisma.resparkableGroupJoinLink.updateMany).not.toHaveBeenCalled();
  });
});
