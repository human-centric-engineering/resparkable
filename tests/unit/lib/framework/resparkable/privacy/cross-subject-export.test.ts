/**
 * Unit Tests: Art. 15's other direction (Release 2, phase 14).
 *
 * The owner-scoped manifest answers "what is in this person's brain?". Four
 * things about a subject live on **somebody else's rows** or on no space at all.
 * Two were deferred, in as many words, when the grant table was added:
 *
 *   • what has been shared *with* them, and
 *   • comments *they* wrote on other people's items.
 *
 * Phase 46 added two more, and they are the same shape for a different reason:
 * they carry no space key, so the owner-scoped manifest cannot reach them by
 * construction:
 *
 *   • the groups they belong to, and
 *   • group invitations addressed to them or sent by them.
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
 *   6. **A group's content never appears**, only the subject's relationship to
 *      it: the group's name, their role, and the dates. §23.4 gives a group
 *      space no private tier, which makes "export the group's brain into one
 *      member's bundle" a tempting and wrong answer.
 *   7. **A pending membership is still exported.** `joinedAt: null` means a
 *      request waiting on an admin (§23.11), which is a fact about this person,
 *      and filtering it would make the export disagree with the product.
 *
 * @see lib/framework/resparkable/access/subject-export.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    resparkableGrant: { findMany: vi.fn().mockResolvedValue([]) },
    resparkableComment: { findMany: vi.fn().mockResolvedValue([]) },
    resparkableGroupMember: { findMany: vi.fn().mockResolvedValue([]) },
    resparkableGroupInvite: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));

import { prisma } from '@/lib/db/client';
import { collectResparkableCrossSubjectData } from '@/lib/framework/resparkable/access/subject-export';

const NOW = new Date('2026-08-28T10:00:00.000Z');

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.resparkableGrant.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.resparkableComment.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.resparkableGroupMember.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.resparkableGroupInvite.findMany).mockResolvedValue([] as never);
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

    expect(data).toEqual({
      sharedWithMe: [],
      commentsIWrote: [],
      groupMemberships: [],
      groupInvites: [],
    });
    // An unfiltered `OR: []` would match every grant in the installation. This
    // is the one failure mode here worth spending a branch on.
    expect(prisma.resparkableGrant.findMany).not.toHaveBeenCalled();
    // Same reasoning, one table over: a group-invite read with no address and no
    // actor would return every outstanding invitation in the deployment.
    expect(prisma.resparkableGroupInvite.findMany).not.toHaveBeenCalled();
    expect(prisma.resparkableGroupMember.findMany).not.toHaveBeenCalled();
  });
});

describe('the group half (phase 46)', () => {
  it('reads memberships by account id alone, never by address', async () => {
    await collectResparkableCrossSubjectData({ userId: 'user_b', email: 'b@example.com' });

    // Deliberately unlike the grant read above. A grant can be addressed to an
    // email nobody has claimed yet; a membership cannot exist without an
    // account, because an invitation grants nothing until it is accepted and
    // acceptance is what creates the row.
    expect(vi.mocked(prisma.resparkableGroupMember.findMany).mock.calls[0][0]?.where).toEqual({
      userId: 'user_b',
    });
  });

  it('exports a pending membership rather than hiding it', async () => {
    vi.mocked(prisma.resparkableGroupMember.findMany).mockResolvedValue([
      {
        groupId: 'grp_1',
        role: 'member',
        joinedAt: null,
        createdAt: NOW,
        group: { name: 'Study Group B' },
      },
    ] as never);

    const data = await collectResparkableCrossSubjectData({
      userId: 'user_b',
      email: 'b@example.com',
    });

    // `joinedAt: null` is a request waiting on an admin (§23.11). It is a fact
    // about this person and it stays in the answer.
    expect(data.groupMemberships).toEqual([
      {
        groupId: 'grp_1',
        groupName: 'Study Group B',
        role: 'member',
        joinedAt: null,
        invitedAt: NOW,
      },
    ]);
  });

  it('carries the group’s name and none of its content', async () => {
    vi.mocked(prisma.resparkableGroupMember.findMany).mockResolvedValue([
      {
        groupId: 'grp_1',
        role: 'admin',
        joinedAt: NOW,
        createdAt: NOW,
        group: { name: 'Study Group B' },
      },
    ] as never);

    const data = await collectResparkableCrossSubjectData({
      userId: 'user_b',
      email: 'b@example.com',
    });

    // The name, so "you are an admin of Study Group B" is checkable. Not the
    // space key, which is the partition key of other people's content, and
    // nothing the group holds: §23.4 gives a group space no private tier, which
    // makes "put the group's brain in this member's bundle" a tempting and
    // wrong reading of Art. 15.
    expect(data.groupMemberships[0]).toMatchObject({ groupName: 'Study Group B' });
    expect(data.groupMemberships[0]).not.toHaveProperty('spaceId');

    const select = vi.mocked(prisma.resparkableGroupMember.findMany).mock.calls[0][0]?.select;
    expect(select).toBeDefined();
    expect(select).not.toHaveProperty('id');
    expect(select?.group).toEqual({ select: { name: true } });
  });

  it('reads invitations in both directions, and labels which is which', async () => {
    vi.mocked(prisma.resparkableGroupInvite.findMany).mockResolvedValue([
      {
        groupId: 'grp_1',
        email: 'b@example.com',
        role: 'member',
        invitedByUserId: 'user_a',
        createdAt: NOW,
        acceptedAt: null,
        expiresAt: null,
        revokedAt: null,
        group: { name: 'Study Group B' },
      },
      {
        groupId: 'grp_2',
        email: 'c@example.com',
        role: 'viewer',
        invitedByUserId: 'user_b',
        createdAt: NOW,
        acceptedAt: null,
        expiresAt: null,
        revokedAt: null,
        group: { name: 'Reading Group' },
      },
    ] as never);

    const data = await collectResparkableCrossSubjectData({
      userId: 'user_b',
      email: 'b@example.com',
    });

    expect(vi.mocked(prisma.resparkableGroupInvite.findMany).mock.calls[0][0]?.where).toEqual({
      OR: [{ email: 'b@example.com' }, { invitedByUserId: 'user_b' }],
    });
    // Two different facts about the same person, so they are labelled rather
    // than merged: "somebody invited me" and "I invited somebody" answer
    // different questions.
    expect(data.groupInvites.map((invite) => invite.direction)).toEqual(['received', 'sent']);
  });

  it('never returns the invite token digest', async () => {
    await collectResparkableCrossSubjectData({ userId: 'user_b', email: 'b@example.com' });

    const select = vi.mocked(prisma.resparkableGroupInvite.findMany).mock.calls[0][0]?.select;
    // Until acceptance this digest is the only thing between a stranger and a
    // group's whole brain. It tells the subject nothing `acceptedAt` beside it
    // does not, and an export bundle is a file that gets emailed around.
    expect(select).toBeDefined();
    expect(select).not.toHaveProperty('inviteTokenHash');
  });

  it('keeps revoked and expired invitations', async () => {
    await collectResparkableCrossSubjectData({ userId: 'user_b', email: 'b@example.com' });

    const where = vi.mocked(prisma.resparkableGroupInvite.findMany).mock.calls[0][0]?.where;
    // Same reasoning as the grant read: this is a record of what was done with
    // the subject's personal data, and a withdrawn invitation is part of it.
    expect(JSON.stringify(where)).not.toContain('revokedAt');
    expect(JSON.stringify(where)).not.toContain('acceptedAt');
  });
});
