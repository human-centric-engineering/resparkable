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

const ownsEntity = vi.fn();

vi.mock('@/lib/framework/resparkable/repo/share-links', () => ({
  ownsEntity: (...args: unknown[]) => ownsEntity(...args),
}));

import {
  issueGrant,
  listOwnGrants,
  revokeGrant,
  toGrantSummary,
  updateGrant,
} from '@/lib/framework/resparkable/services/grants';
import { ownerScope } from '@/lib/framework/resparkable/repo/owner-scope';

const OWNER = ownerScope('user_a');
const NOW = new Date('2026-08-28T10:00:00.000Z');

function grantRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'grant_1',
    userId: 'user_a',
    entityType: 'project',
    entityId: 'p_1',
    granteeUserId: null,
    granteeEmail: 'b@example.com',
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
  role: 'viewer' as const,
  includeTaskDetail: false,
  expiry: { kind: 'days' as const, days: 90 },
};

beforeEach(() => {
  vi.clearAllMocks();
  ownsEntity.mockResolvedValue(true);
  upsertGrant.mockResolvedValue(grantRow());
  findAccountIdForEmail.mockResolvedValue(null);
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
      expect.objectContaining({ granteeUserId: 'user_b' })
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
        granteeEmail: 'b@example.com',
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

describe('toGrantSummary', () => {
  it('reports accepted from acceptedAt, not from whether an account is bound', () => {
    // The distinction that keeps the owner from learning whether the address
    // has an account: a bound grant with no acceptance still reads "invited".
    const bound = toGrantSummary(grantRow({ granteeUserId: 'user_b' }), NOW);
    expect(bound.accepted).toBe(false);

    const accepted = toGrantSummary(grantRow({ acceptedAt: NOW }), NOW);
    expect(accepted.accepted).toBe(true);
  });

  it('marks an expired grant inactive without it having been revoked', () => {
    const expired = toGrantSummary(
      grantRow({ expiresAt: new Date('2026-08-01T00:00:00.000Z') }),
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
    findOwnGrant.mockResolvedValue(null);

    // A concurrent revoke-and-delete, or an erasure landing mid-request. The
    // route's answer is a 404 either way, which is the same answer it gives for
    // a grant that was never this owner's.
    expect(await updateGrant(OWNER, 'grant_1', { role: 'viewer' }, NOW)).toBeNull();
  });

  it('returns null for a grant that is not this owner’s', async () => {
    updateGrantRow.mockResolvedValue(false);

    expect(await updateGrant(OWNER, 'grant_x', { role: 'viewer' }, NOW)).toBeNull();
    expect(findOwnGrant).not.toHaveBeenCalled();
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
