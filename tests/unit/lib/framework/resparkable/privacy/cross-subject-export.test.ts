/**
 * Unit Tests: Art. 15's other direction (Release 2, phase 14).
 *
 * The owner-scoped manifest answers "what is in this person's brain?". Two
 * things about a subject live on **somebody else's rows** and were deferred, in
 * as many words, when the grant table was added:
 *
 *   • what has been shared *with* them, and
 *   • comments *they* wrote on other people's items.
 *
 * What has to hold:
 *
 *   1. **Both the account id and the address are matched**, the same pair
 *      `granteeClauses` matches — an unaccepted invite has only an address, and
 *      dropping those omits the grants most likely to have been forgotten.
 *   2. **Revoked and expired grants are included**, unlike `/shared-with-me`.
 *      That surface is a place to work from; this is a record of what was done
 *      with the subject's data, and a withdrawn share is part of it.
 *   3. **The projection is an allowlist**, so a column added to
 *      `ResparkableGrant` next month cannot reach a third party's export bundle
 *      because nobody remembered to exclude it.
 *   4. **No content of what was shared.** A grant says *that* somebody shared a
 *      project; the project is theirs.
 *   5. **A subject with no identity matches nothing** — an unfiltered `OR: []`
 *      would match every grant in the installation.
 *
 * @see lib/framework/resparkable/access/subject-export.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    resparkableGrant: { findMany: vi.fn().mockResolvedValue([]) },
    resparkableComment: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));

import { prisma } from '@/lib/db/client';
import { collectResparkableCrossSubjectData } from '@/lib/framework/resparkable/access/subject-export';

const NOW = new Date('2026-08-28T10:00:00.000Z');

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.resparkableGrant.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.resparkableComment.findMany).mockResolvedValue([] as never);
});

describe('collectResparkableCrossSubjectData', () => {
  it('matches both the account id and the lower-cased address', async () => {
    await collectResparkableCrossSubjectData({ userId: 'user_b', email: 'B@Example.com' });

    // An accepted grant is found by id; an unaccepted invite has only an
    // address. Dropping either half silently shortens the answer.
    expect(vi.mocked(prisma.resparkableGrant.findMany).mock.calls[0][0]?.where).toEqual({
      OR: [{ granteeUserId: 'user_b' }, { granteeEmail: 'b@example.com' }],
    });
  });

  it('includes revoked and expired grants', async () => {
    await collectResparkableCrossSubjectData({ userId: 'user_b', email: 'b@example.com' });

    const where = vi.mocked(prisma.resparkableGrant.findMany).mock.calls[0][0]?.where;
    // No `revokedAt: null`, no expiry filter. "Somebody shared a project with
    // you last March and withdrew it in April" is exactly what a subject-access
    // request is for.
    expect(JSON.stringify(where)).not.toContain('revokedAt');
    expect(JSON.stringify(where)).not.toContain('expiresAt');
  });

  it('selects an allowlist, never the whole row', async () => {
    await collectResparkableCrossSubjectData({ userId: 'user_b', email: 'b@example.com' });

    const select = vi.mocked(prisma.resparkableGrant.findMany).mock.calls[0][0]?.select;

    // The inversion `repo/shared-view.ts` makes, for the same reason: these
    // rows belong to somebody else. A value never fetched cannot be leaked by
    // a serialiser downstream.
    expect(select).toBeDefined();
    for (const forbidden of ['inviteTokenHash', 'userId', 'id']) {
      expect(select).not.toHaveProperty(forbidden);
    }
  });

  it('carries no content of what was shared', async () => {
    vi.mocked(prisma.resparkableGrant.findMany).mockResolvedValue([
      {
        entityType: 'project',
        entityId: 'p_1',
        role: 'viewer',
        includeTaskDetail: false,
        createdAt: NOW,
        acceptedAt: null,
        inviteSentAt: null,
        expiresAt: null,
        revokedAt: null,
      },
    ] as never);

    const data = await collectResparkableCrossSubjectData({
      userId: 'user_b',
      email: 'b@example.com',
    });

    // The id, so the record is checkable against the product; not the title,
    // which is the owner's content and is behind a grant that can be revoked.
    expect(data.sharedWithMe[0]).toMatchObject({ entityType: 'project', entityId: 'p_1' });
    expect(data.sharedWithMe[0]).not.toHaveProperty('title');
    expect(data.sharedWithMe[0]).not.toHaveProperty('body');
  });

  it('returns the subject’s own comments, wherever they wrote them', async () => {
    vi.mocked(prisma.resparkableComment.findMany).mockResolvedValue([
      {
        entityType: 'project',
        entityId: 'p_1',
        body: 'Looks right to me',
        editedAt: null,
        createdAt: NOW,
      },
    ] as never);

    const data = await collectResparkableCrossSubjectData({
      userId: 'user_b',
      email: 'b@example.com',
    });

    // Keyed on the author, not on the item's owner — which is the whole reason
    // this cannot be an owner query.
    expect(vi.mocked(prisma.resparkableComment.findMany).mock.calls[0][0]?.where).toEqual({
      authorUserId: 'user_b',
    });
    expect(data.commentsIWrote).toHaveLength(1);
  });

  it('matches nothing at all for a subject with no account', async () => {
    const data = await collectResparkableCrossSubjectData({ userId: null, email: null });

    expect(data).toEqual({ sharedWithMe: [], commentsIWrote: [] });
    // An unfiltered `OR: []` would match every grant in the installation. This
    // is the one failure mode here worth spending a branch on.
    expect(prisma.resparkableGrant.findMany).not.toHaveBeenCalled();
  });
});
