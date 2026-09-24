/**
 * Unit Tests: the named-grant service (Release 2, phase 12).
 *
 * Four properties, each of which fails quietly if it breaks:
 *
 *   1. **Issuing a grant discloses nothing about whether the address has an
 *      account.** §13 requires an identical response either way, or "share with
 *      someone" becomes an existence oracle anybody can query one address at a
 *      time. The lookup still happens — it is what makes the grant work on the
 *      grantee's next request — but its answer must not reach the caller.
 *   2. **Re-sharing amends, it does not duplicate.** Two live grants to one
 *      address on one item would make "what can Bob do?" a question with two
 *      answers, which is the shape of every access bug that ends with somebody
 *      seeing more than was meant.
 *   3. **Ownership is checked before anything is written**, so a grant cannot be
 *      issued against a row the caller does not own.
 *   4. **A double revoke does not move the timestamp.** The audit answer to
 *      "when did access stop?" should not change because a button was pressed
 *      twice.
 *
 * Only the repo is mocked. The service's own decisions — expiry arithmetic, the
 * summary's shape, what reaches the log — all run for real.
 *
 * @see lib/framework/resparkable/services/grants.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const upsertGrant = vi.fn();
const listOwnGrantRows = vi.fn();
const findOwnGrant = vi.fn();
const updateGrantRow = vi.fn();
const revokeGrantRow = vi.fn();
const findAccountIdForEmail = vi.fn();

vi.mock('@/lib/framework/resparkable/repo/grants', () => ({
  upsertGrant: (...args: unknown[]) => upsertGrant(...args),
  listOwnGrants: (...args: unknown[]) => listOwnGrantRows(...args),
  findOwnGrant: (...args: unknown[]) => findOwnGrant(...args),
  updateGrant: (...args: unknown[]) => updateGrantRow(...args),
  revokeGrant: (...args: unknown[]) => revokeGrantRow(...args),
  findAccountIdForEmail: (...args: unknown[]) => findAccountIdForEmail(...args),
}));

const findGroupLabelsBySpaceIds = vi.fn();

vi.mock('@/lib/framework/resparkable/repo/groups', () => ({
  findGroupLabelsBySpaceIds: (...args: unknown[]) => findGroupLabelsBySpaceIds(...args),
}));

const resolveGroupSpaceScope = vi.fn();
const listGroupsForActor = vi.fn();

vi.mock('@/lib/framework/resparkable/services/membership', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/framework/resparkable/services/membership')
  >('@/lib/framework/resparkable/services/membership');
  return {
    ...actual,
    resolveGroupSpaceScope: (...args: unknown[]) => resolveGroupSpaceScope(...args),
    listGroupsForActor: (...args: unknown[]) => listGroupsForActor(...args),
  };
});

const ownsEntity = vi.fn();

vi.mock('@/lib/framework/resparkable/repo/share-links', () => ({
  ownsEntity: (...args: unknown[]) => ownsEntity(...args),
}));

import {
  issueGrant,
  listGrantTargetGroups,
  listOwnGrants,
  revokeGrant,
  toGrantSummaries,
  updateGrant,
} from '@/lib/framework/resparkable/services/grants';
import { spaceScope, spaceScopeFor } from '@/lib/framework/resparkable/repo/space-scope';

const OWNER = spaceScope('user_a');
const NOW = new Date('2026-08-28T10:00:00.000Z');

function grantRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'grant_1',
    spaceId: 'user_a',
    createdByUserId: null,
    entityType: 'project',
    entityId: 'p_1',
    granteeUserId: null,
    granteeEmail: 'b@example.com',
    granteeSpaceId: null,
    role: 'viewer',
    includeTaskDetail: false,
    inviteTokenHash: null,
    inviteSentAt: null,
    acceptedAt: null,
    expiresAt: null,
    revokedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

const INPUT = {
  entityType: 'project' as const,
  entityId: 'p_1',
  granteeEmail: 'b@example.com',
  grantee: { kind: 'person' as const, email: 'b@example.com' },
  role: 'viewer' as const,
  includeTaskDetail: false,
  expiry: { kind: 'days' as const, days: 90 },
};

const GROUP_B = 'spc_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const GROUP_INPUT = {
  entityType: 'project' as const,
  entityId: 'p_1',
  granteeSpaceId: GROUP_B,
  grantee: { kind: 'group' as const, spaceId: GROUP_B },
  role: 'viewer' as const,
  includeTaskDetail: false,
  expiry: { kind: 'days' as const, days: 90 },
};

beforeEach(() => {
  vi.clearAllMocks();
  ownsEntity.mockResolvedValue(true);
  upsertGrant.mockResolvedValue(grantRow());
  findAccountIdForEmail.mockResolvedValue(null);
  findGroupLabelsBySpaceIds.mockResolvedValue(new Map());
  resolveGroupSpaceScope.mockResolvedValue(null);
  listGroupsForActor.mockResolvedValue([]);
});

describe('issueGrant', () => {
  it('refuses an item the caller does not own, before writing anything', async () => {
    ownsEntity.mockResolvedValue(false);

    expect(await issueGrant(OWNER, INPUT, NOW)).toBeNull();
    expect(upsertGrant).not.toHaveBeenCalled();
    // Not even the account lookup: a refused share should not be usable to
    // probe whether an address has an account either.
    expect(findAccountIdForEmail).not.toHaveBeenCalled();
  });

  it('returns the same shape whether or not the address has an account', async () => {
    const withoutAccount = await issueGrant(OWNER, INPUT, NOW);

    findAccountIdForEmail.mockResolvedValue('user_b');
    upsertGrant.mockResolvedValue(grantRow({ granteeUserId: 'user_b' }));
    const withAccount = await issueGrant(OWNER, INPUT, NOW);

    // Byte-for-byte identical. This is the assertion §13 asks for, and it has
    // to compare whole objects rather than check for the absence of one field:
    // any observable difference at all is the oracle.
    expect(withAccount).toEqual(withoutAccount);
  });

  it('never exposes granteeUserId or the invite digest in the summary', async () => {
    findAccountIdForEmail.mockResolvedValue('user_b');
    upsertGrant.mockResolvedValue(
      grantRow({ granteeUserId: 'user_b', inviteTokenHash: 'a'.repeat(64) })
    );

    const summary = await issueGrant(OWNER, INPUT, NOW);

    expect(summary).not.toHaveProperty('granteeUserId');
    expect(summary).not.toHaveProperty('inviteTokenHash');
    expect(JSON.stringify(summary)).not.toContain('user_b');
    expect(JSON.stringify(summary)).not.toContain('a'.repeat(64));
  });

  it('binds the account when the address already has one', async () => {
    findAccountIdForEmail.mockResolvedValue('user_b');

    await issueGrant(OWNER, INPUT, NOW);

    expect(upsertGrant).toHaveBeenCalledWith(
      OWNER,
      expect.objectContaining({
        grantee: { kind: 'person', email: 'b@example.com', userId: 'user_b' },
      })
    );
  });

  it('upserts rather than creating, so re-sharing amends one relationship', async () => {
    await issueGrant(OWNER, INPUT, NOW);
    await issueGrant(OWNER, { ...INPUT, role: 'commenter' }, NOW);

    expect(upsertGrant).toHaveBeenCalledTimes(2);
    // Both calls address the same triple. The repo's `upsert` targets the
    // unique index, so the second is an update rather than a second row.
    for (const call of upsertGrant.mock.calls) {
      expect(call[1]).toMatchObject({
        entityType: 'project',
        entityId: 'p_1',
        grantee: { kind: 'person', email: 'b@example.com' },
      });
    }
  });

  it('turns a days expiry into a date, and "never" into null', async () => {
    await issueGrant(OWNER, { ...INPUT, expiry: { kind: 'days', days: 30 } }, NOW);
    expect(upsertGrant.mock.calls[0][1].expiresAt).toEqual(new Date('2026-09-27T10:00:00.000Z'));

    await issueGrant(OWNER, { ...INPUT, expiry: { kind: 'never' } }, NOW);
    expect(upsertGrant.mock.calls[1][1].expiresAt).toBeNull();
  });
});

describe('issueGrant to a group (phase 49)', () => {
  it('writes a group grantee when the caller is a joined member of that group, with a role that can write', async () => {
    resolveGroupSpaceScope.mockResolvedValue(
      spaceScopeFor({ spaceId: GROUP_B, actorUserId: 'user_a', role: 'member' })
    );
    upsertGrant.mockResolvedValue(grantRow({ granteeEmail: null, granteeSpaceId: GROUP_B }));

    const summary = await issueGrant(OWNER, GROUP_INPUT, NOW);

    expect(summary).not.toBeNull();
    expect(resolveGroupSpaceScope).toHaveBeenCalledWith('user_a', GROUP_B);
    expect(upsertGrant).toHaveBeenCalledWith(
      OWNER,
      expect.objectContaining({ grantee: { kind: 'group', spaceId: GROUP_B } })
    );
    // A group is not a mailbox. No account lookup, and so no oracle either.
    expect(findAccountIdForEmail).not.toHaveBeenCalled();
  });

  it('refuses a group the caller is not in, with the same null as an item they do not own', async () => {
    // There is no directory of groups (§23.11). Accepting any group's id would
    // be one, answering "does this group exist?" by whether the share worked.
    resolveGroupSpaceScope.mockResolvedValue(null);

    expect(await issueGrant(OWNER, GROUP_INPUT, NOW)).toBeNull();
    expect(upsertGrant).not.toHaveBeenCalled();
  });

  it('refuses a caller who is only a viewer in the target group', async () => {
    // Sharing into a group puts an item in front of everyone in it: a write in
    // that workspace, which a group viewer does not make (§23.3).
    resolveGroupSpaceScope.mockResolvedValue(
      spaceScopeFor({ spaceId: GROUP_B, actorUserId: 'user_a', role: 'viewer' })
    );

    expect(await issueGrant(OWNER, GROUP_INPUT, NOW)).toBeNull();
    expect(upsertGrant).not.toHaveBeenCalled();
  });

  it('refuses a group as the grantee of its own item', async () => {
    const inGroup = spaceScopeFor({ spaceId: GROUP_B, actorUserId: 'user_a', role: 'member' });
    resolveGroupSpaceScope.mockResolvedValue(inGroup);

    expect(await issueGrant(inGroup, GROUP_INPUT, NOW)).toBeNull();
    expect(upsertGrant).not.toHaveBeenCalled();
  });

  it('refuses a group viewer sharing out of the group, before resolving any grantee', async () => {
    const viewer = spaceScopeFor({ spaceId: GROUP_B, actorUserId: 'user_a', role: 'viewer' });

    expect(await issueGrant(viewer, INPUT, NOW)).toBeNull();
    expect(ownsEntity).not.toHaveBeenCalled();
    expect(upsertGrant).not.toHaveBeenCalled();
  });
});

describe('listGrantTargetGroups', () => {
  function membership(spaceId: string, joinedAt: Date | null, role = 'member') {
    return { joinedAt, role, group: { spaceId } };
  }

  it('offers nothing to a caller who cannot write in the workspace they are sharing from', async () => {
    const viewerInB = spaceScopeFor({ spaceId: GROUP_B, actorUserId: 'user_a', role: 'viewer' });

    expect(await listGrantTargetGroups(viewerInB)).toEqual([]);
    expect(listGroupsForActor).not.toHaveBeenCalled();
  });

  it('does not offer a group the caller is only a viewer in', async () => {
    listGroupsForActor.mockResolvedValue([
      membership(GROUP_B, NOW, 'viewer'),
      membership('spc_cccccccccccccccccccccccccccccccc', NOW, 'admin'),
    ]);
    findGroupLabelsBySpaceIds.mockResolvedValue(new Map());

    await listGrantTargetGroups(OWNER);

    expect(findGroupLabelsBySpaceIds).toHaveBeenCalledWith([
      'spc_cccccccccccccccccccccccccccccccc',
    ]);
  });

  it('offers the caller’s joined groups, less the one they are sharing from', async () => {
    const GROUP_C = 'spc_cccccccccccccccccccccccccccccccc';
    const PENDING = 'spc_dddddddddddddddddddddddddddddddd';
    listGroupsForActor.mockResolvedValue([
      membership(GROUP_B, NOW),
      membership(GROUP_C, NOW),
      membership(PENDING, null),
    ]);
    findGroupLabelsBySpaceIds.mockImplementation(async (ids: string[]) => {
      return new Map(
        ids.map((id) => [
          id,
          { groupId: id, spaceId: id, name: id === GROUP_B ? 'Beta' : 'Alpha', memberCount: 3 },
        ])
      );
    });

    const fromB = spaceScopeFor({ spaceId: GROUP_B, actorUserId: 'user_a', role: 'member' });
    const targets = await listGrantTargetGroups(fromB);

    // Not the group being shared from, and not a group still waiting on an
    // admin: a pending request is not a membership.
    expect(findGroupLabelsBySpaceIds).toHaveBeenCalledWith([GROUP_C]);
    expect(targets.map((target) => target.spaceId)).toEqual([GROUP_C]);
  });

  it('sorts by name so the picker reads the same way every time', async () => {
    const GROUP_C = 'spc_cccccccccccccccccccccccccccccccc';
    listGroupsForActor.mockResolvedValue([membership(GROUP_B, NOW), membership(GROUP_C, NOW)]);
    findGroupLabelsBySpaceIds.mockResolvedValue(
      new Map([
        [GROUP_B, { groupId: 'b', spaceId: GROUP_B, name: 'Zeta', memberCount: 2 }],
        [GROUP_C, { groupId: 'c', spaceId: GROUP_C, name: 'Alpha', memberCount: 5 }],
      ])
    );

    const targets = await listGrantTargetGroups(OWNER);

    expect(targets.map((target) => target.name)).toEqual(['Alpha', 'Zeta']);
  });
});

describe('toGrantSummaries', () => {
  it('reports accepted from acceptedAt, not from whether an account is bound', async () => {
    // The distinction that keeps the owner from learning whether the address
    // has an account: a bound grant with no acceptance still reads "invited".
    const [bound, accepted] = await toGrantSummaries(
      OWNER,
      [grantRow({ granteeUserId: 'user_b' }), grantRow({ acceptedAt: NOW })],
      NOW
    );
    expect(bound.accepted).toBe(false);
    expect(accepted.accepted).toBe(true);
  });

  it('names a group grantee with its member count, in one lookup for the whole list', async () => {
    findGroupLabelsBySpaceIds.mockResolvedValue(
      new Map([
        [GROUP_B, { groupId: 'g_b', spaceId: GROUP_B, name: 'Study Group B', memberCount: 14 }],
      ])
    );
    listGroupsForActor.mockResolvedValue([
      { joinedAt: NOW, role: 'viewer', group: { spaceId: GROUP_B } },
    ]);
    const row = grantRow({ granteeEmail: null, granteeSpaceId: GROUP_B });

    const summaries = await toGrantSummaries(OWNER, [row, row, grantRow()], NOW);

    expect(findGroupLabelsBySpaceIds).toHaveBeenCalledTimes(1);
    expect(listGroupsForActor).toHaveBeenCalledTimes(1);
    expect(summaries[0]).toMatchObject({
      granteeEmail: null,
      granteeGroup: { spaceId: GROUP_B, name: 'Study Group B', memberCount: 14 },
    });
    expect(summaries[2]).toMatchObject({ granteeEmail: 'b@example.com', granteeGroup: null });
  });

  it('names the group but withholds its member count from a reader who is not in it', async () => {
    // G shares with H: everyone in G sees where the item went, but H's roll is
    // H's business. A pending request to join is not membership either.
    findGroupLabelsBySpaceIds.mockResolvedValue(
      new Map([
        [GROUP_B, { groupId: 'g_b', spaceId: GROUP_B, name: 'Study Group B', memberCount: 14 }],
      ])
    );
    listGroupsForActor.mockResolvedValue([
      { joinedAt: null, role: 'member', group: { spaceId: GROUP_B } },
    ]);

    const [summary] = await toGrantSummaries(
      OWNER,
      [grantRow({ granteeEmail: null, granteeSpaceId: GROUP_B })],
      NOW
    );

    expect(summary.granteeGroup).toEqual({
      spaceId: GROUP_B,
      name: 'Study Group B',
      memberCount: null,
    });
  });

  it('does not look up memberships when no grant on the list is to a group', async () => {
    await toGrantSummaries(OWNER, [grantRow()], NOW);

    expect(listGroupsForActor).not.toHaveBeenCalled();
  });

  it('marks an expired grant inactive without it having been revoked', async () => {
    const [expired] = await toGrantSummaries(
      OWNER,
      [grantRow({ expiresAt: new Date('2026-08-01T00:00:00.000Z') })],
      NOW
    );

    expect(expired.active).toBe(false);
    expect(expired.revokedAt).toBeNull();
  });
});

describe('updateGrant', () => {
  it('sends only the fields that were asked for', async () => {
    updateGrantRow.mockResolvedValue(true);
    findOwnGrant.mockResolvedValue(grantRow({ role: 'commenter' }));

    await updateGrant(OWNER, 'grant_1', { role: 'commenter' }, NOW);

    // No `expiresAt` key at all. Sending `undefined` would be read by Prisma as
    // "leave it", but sending `null` — which an eagerly-built payload would do
    // — silently turns a grant that expires into one that never does.
    expect(updateGrantRow).toHaveBeenCalledWith(OWNER, 'grant_1', { role: 'commenter' });
  });

  it('sends includeTaskDetail and a resolved expiry when both are given', async () => {
    updateGrantRow.mockResolvedValue(true);
    findOwnGrant.mockResolvedValue(grantRow());

    await updateGrant(
      OWNER,
      'grant_1',
      { includeTaskDetail: true, expiry: { kind: 'days', days: 30 } },
      NOW
    );

    expect(updateGrantRow).toHaveBeenCalledWith(OWNER, 'grant_1', {
      includeTaskDetail: true,
      expiresAt: new Date('2026-09-27T10:00:00.000Z'),
    });
  });

  it('turns an explicit "never" expiry into null rather than omitting it', async () => {
    updateGrantRow.mockResolvedValue(true);
    findOwnGrant.mockResolvedValue(grantRow());

    await updateGrant(OWNER, 'grant_1', { expiry: { kind: 'never' } }, NOW);

    // The distinction the tagged union exists for: an ABSENT `expiry` leaves the
    // column alone, while an explicit "never" clears it. Collapsing the two
    // would make "never expires" reachable by omitting a field.
    expect(updateGrantRow).toHaveBeenCalledWith(OWNER, 'grant_1', { expiresAt: null });
  });

  it('returns null when the row vanishes between the update and the read-back', async () => {
    updateGrantRow.mockResolvedValue(true);
    findOwnGrant.mockResolvedValueOnce(grantRow()).mockResolvedValueOnce(null);

    // A concurrent revoke-and-delete, or an erasure landing mid-request. The
    // route's answer is a 404 either way, which is the same answer it gives for
    // a grant that was never this owner's.
    expect(await updateGrant(OWNER, 'grant_1', { role: 'viewer' }, NOW)).toBeNull();
  });

  it('returns null for a grant that is not this owner’s, before writing anything', async () => {
    findOwnGrant.mockResolvedValue(null);

    expect(await updateGrant(OWNER, 'grant_x', { role: 'viewer' }, NOW)).toBeNull();
    expect(updateGrantRow).not.toHaveBeenCalled();
  });

  it('refuses to change a group grant for somebody who has left that group', async () => {
    // Issuing needed a joined, writing membership of the group. Without the
    // same check here, a PATCH would step around it: a leaver could raise the
    // grant to commenter or open task notes to a group they are no longer in.
    findOwnGrant.mockResolvedValue(grantRow({ granteeEmail: null, granteeSpaceId: GROUP_B }));
    resolveGroupSpaceScope.mockResolvedValue(null);

    expect(await updateGrant(OWNER, 'grant_1', { role: 'commenter' }, NOW)).toBeNull();
    expect(resolveGroupSpaceScope).toHaveBeenCalledWith('user_a', GROUP_B);
    expect(updateGrantRow).not.toHaveBeenCalled();
  });

  it('refuses to change a group grant for somebody who is only a viewer in that group', async () => {
    findOwnGrant.mockResolvedValue(grantRow({ granteeEmail: null, granteeSpaceId: GROUP_B }));
    resolveGroupSpaceScope.mockResolvedValue(
      spaceScopeFor({ spaceId: GROUP_B, actorUserId: 'user_a', role: 'viewer' })
    );

    expect(await updateGrant(OWNER, 'grant_1', { includeTaskDetail: true }, NOW)).toBeNull();
    expect(updateGrantRow).not.toHaveBeenCalled();
  });

  it('changes a group grant for a member who could have issued it', async () => {
    const row = grantRow({ granteeEmail: null, granteeSpaceId: GROUP_B });
    findOwnGrant.mockResolvedValue(row);
    updateGrantRow.mockResolvedValue(true);
    resolveGroupSpaceScope.mockResolvedValue(
      spaceScopeFor({ spaceId: GROUP_B, actorUserId: 'user_a', role: 'member' })
    );

    expect(await updateGrant(OWNER, 'grant_1', { role: 'commenter' }, NOW)).not.toBeNull();
    expect(updateGrantRow).toHaveBeenCalledWith(OWNER, 'grant_1', { role: 'commenter' });
  });
});

describe('revokeGrant', () => {
  it('returns the revoked grant on the first call and null on the second', async () => {
    revokeGrantRow.mockResolvedValueOnce(true);
    findOwnGrant.mockResolvedValue(grantRow({ revokedAt: NOW }));

    expect(await revokeGrant(OWNER, 'grant_1', NOW)).not.toBeNull();

    // The repo excludes already-revoked rows, so the second press moves
    // nothing — and the service turns that into a 404 rather than restamping
    // the timestamp that answers "when did access stop?".
    revokeGrantRow.mockResolvedValueOnce(false);
    expect(await revokeGrant(OWNER, 'grant_1', NOW)).toBeNull();
  });
  it('revokes a group grant for somebody who has left that group', async () => {
    // Changing a group grant needs membership; taking it back never does.
    revokeGrantRow.mockResolvedValue(true);
    findOwnGrant.mockResolvedValue(
      grantRow({ granteeEmail: null, granteeSpaceId: GROUP_B, revokedAt: NOW })
    );
    resolveGroupSpaceScope.mockResolvedValue(null);

    expect(await revokeGrant(OWNER, 'grant_1', NOW)).not.toBeNull();
    expect(resolveGroupSpaceScope).not.toHaveBeenCalled();
  });
});

describe('revokeGrant', () => {
  it('returns null when the row vanishes between the revoke and the read-back', async () => {
    revokeGrantRow.mockResolvedValue(true);
    findOwnGrant.mockResolvedValue(null);

    expect(await revokeGrant(OWNER, 'grant_1', NOW)).toBeNull();
  });
});

describe('listOwnGrants', () => {
  it('maps every row through the summary, so no raw row can reach a response', async () => {
    listOwnGrantRows.mockResolvedValue([
      grantRow({ id: 'g1', granteeUserId: 'user_b' }),
      grantRow({ id: 'g2', inviteTokenHash: 'b'.repeat(64) }),
    ]);

    const summaries = await listOwnGrants(OWNER, {}, NOW);

    expect(summaries).toHaveLength(2);
    const serialised = JSON.stringify(summaries);
    expect(serialised).not.toContain('user_b');
    expect(serialised).not.toContain('b'.repeat(64));
  });
});
