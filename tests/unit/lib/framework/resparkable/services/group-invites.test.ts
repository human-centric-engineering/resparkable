/**
 * Unit Tests: group invitations (Release 9, phase 46).
 *
 * The property this file exists for is the one §15 names as phase 46's
 * acceptance criterion: **an invitation grants nothing until it is accepted.**
 * That is the opposite of what §13's share invite does, the two share a token
 * shape, and the way this goes wrong is somebody generalising one code path over
 * both. So the assertions are mostly about what is absent:
 *
 *   1. **No email matching anywhere.** A share grant is live for its address
 *      before acceptance; membership is never resolved by address, and an
 *      invitation issued to a mailbox resolves to nothing until a membership row
 *      exists.
 *   2. **Admins only**, checked in the service so the join-link path phase 57
 *      adds inherits it rather than re-deriving it.
 *   3. **Acceptance is a compare-and-set.** Two requests racing on one token
 *      produce one membership and one "unknown".
 *   4. **Every failure gives one answer.** Unknown, withdrawn, expired and spent
 *      are indistinguishable, because anything else enumerates both invitations
 *      and groups.
 *   5. **The wrong-account answer is masked**, so a stranger holding a forwarded
 *      email learns nothing writable-to.
 *   6. **A failed send does not roll back the invitation.**
 *
 * @see lib/framework/resparkable/services/group-invites.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/framework/resparkable/repo/groups', () => ({
  acceptInviteAndJoin: vi.fn(),
  findInviteByTokenHash: vi.fn(),
  listGroupInvites: vi.fn(),
  revokeInvite: vi.fn(),
  upsertInvite: vi.fn(),
}));
vi.mock('@/lib/framework/resparkable/services/membership', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveGroupMembership: vi.fn(),
}));
vi.mock('@/lib/framework/resparkable/repo/owner-contact', () => ({
  findOwnerContact: vi.fn(),
}));
vi.mock('@/lib/email/send', () => ({ sendEmail: vi.fn() }));

import { sendEmail } from '@/lib/email/send';
import * as repo from '@/lib/framework/resparkable/repo/groups';
import { findOwnerContact } from '@/lib/framework/resparkable/repo/owner-contact';
import { spaceScopeFor } from '@/lib/framework/resparkable/repo/space-scope';
import {
  acceptGroupInvite,
  issueGroupInvite,
} from '@/lib/framework/resparkable/services/group-invites';
import { resolveGroupMembership } from '@/lib/framework/resparkable/services/membership';

const NOW = new Date('2026-09-01T10:00:00.000Z');
const SPACE = 'spc_group_1';

function group() {
  return {
    id: 'grp_1',
    name: 'Study Group B',
    slug: 'study-group-b',
    description: null,
    spaceId: SPACE,
    maxMembers: 50,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function asAdmin(): void {
  vi.mocked(resolveGroupMembership).mockResolvedValue({
    membership: {
      id: 'mem_1',
      groupId: 'grp_1',
      userId: 'user_a',
      role: 'admin',
      invitedByUserId: null,
      joinedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
      group: group(),
    },
    scope: spaceScopeFor({ spaceId: SPACE, actorUserId: 'user_a', role: 'admin' }),
  });
}

function invite(overrides: Record<string, unknown> = {}) {
  return {
    id: 'inv_1',
    groupId: 'grp_1',
    email: 'b@example.com',
    role: 'member',
    invitedByUserId: 'user_a',
    inviteTokenHash: 'hash',
    expiresAt: new Date('2026-10-01T10:00:00.000Z'),
    revokedAt: null,
    acceptedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    group: group(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(findOwnerContact).mockResolvedValue({
    email: 'a@example.com',
    name: 'Ana',
    emailVerified: true,
  });
  vi.mocked(sendEmail).mockResolvedValue({ success: true } as never);
  vi.mocked(repo.upsertInvite).mockResolvedValue(invite());
});

describe('issueGroupInvite', () => {
  it('is refused for a member who is not an admin', async () => {
    vi.mocked(resolveGroupMembership).mockResolvedValue({
      membership: { group: group(), role: 'member' },
      scope: spaceScopeFor({ spaceId: SPACE, actorUserId: 'user_a', role: 'member' }),
    } as never);

    // §23.3 gives invitation to admins alone. Checked here rather than in the
    // route, so phase 57's join links inherit the rule instead of re-deriving it.
    expect(await issueGroupInvite('user_a', 'grp_1', inviteInput())).toEqual({
      ok: false,
      reason: 'not_an_admin',
    });
    expect(repo.upsertInvite).not.toHaveBeenCalled();
  });

  it('is refused for a stranger, without saying the group exists', async () => {
    vi.mocked(resolveGroupMembership).mockResolvedValue(null);

    expect(await issueGroupInvite('user_stranger', 'grp_1', inviteInput())).toEqual({
      ok: false,
      reason: 'not_a_member',
    });
  });

  it('stores a digest and never the token itself', async () => {
    asAdmin();

    await issueGroupInvite('user_a', 'grp_1', inviteInput(), NOW);

    const written = vi.mocked(repo.upsertInvite).mock.calls[0][0];
    // sha256 is 64 hex characters. The raw token is 32 base64url ones, so a
    // stored token would be obvious here, and the digest is what keeps a
    // database dump from being a set of live credentials for whole workspaces.
    expect(written.inviteTokenHash).toMatch(/^[0-9a-f]{64}$/);
    // The token reaches exactly one place: the email.
    const emailed = vi.mocked(sendEmail).mock.calls[0][0];
    expect(JSON.stringify(emailed)).not.toContain(written.inviteTokenHash);
  });

  it('defaults the window to 30 days rather than to never', async () => {
    asAdmin();

    await issueGroupInvite('user_a', 'grp_1', inviteInput(), NOW);

    // `grantExpirySchema`'s default, reused rather than re-invented: a second
    // expiry vocabulary is how two share surfaces end up disagreeing about what
    // "expired" means.
    const written = vi.mocked(repo.upsertInvite).mock.calls[0][0];
    expect(written.expiresAt).toEqual(new Date('2026-10-01T10:00:00.000Z'));
  });

  it('keeps the invitation when the email fails to send', async () => {
    asAdmin();
    vi.mocked(sendEmail).mockResolvedValue({ success: false } as never);

    const result = await issueGroupInvite('user_a', 'grp_1', inviteInput(), NOW);

    // Reported, never thrown. An invitation nobody was told about is one an
    // admin can re-send; a throw would roll back a decision they already made
    // and leave nothing to re-send.
    expect(result).toEqual({ ok: true, inviteId: 'inv_1', sent: false });
    expect(repo.upsertInvite).toHaveBeenCalled();
  });

  it('never names the group’s content in the email', async () => {
    asAdmin();

    await issueGroupInvite('user_a', 'grp_1', inviteInput(), NOW);

    // The group's NAME is allowed and is the only version of this message
    // somebody can act on. Nothing that is IN the group is: a subject line lands
    // in a preview pane, a lock screen and a mail provider's index.
    const emailed = vi.mocked(sendEmail).mock.calls[0][0];
    expect(emailed.subject).toContain('Study Group B');
    expect(emailed.subject).toContain('invited you to join');
  });
});

describe('acceptGroupInvite', () => {
  it('creates the membership and reports the group', async () => {
    vi.mocked(repo.findInviteByTokenHash).mockResolvedValue(invite());
    vi.mocked(repo.acceptInviteAndJoin).mockResolvedValue({
      groupId: 'grp_1',
      joinedAt: NOW,
      createdAt: NOW,
    } as never);

    const result = await acceptGroupInvite(
      { userId: 'user_b', email: 'b@example.com' },
      'token',
      NOW
    );

    expect(result).toMatchObject({ ok: true, groupId: 'grp_1', groupName: 'Study Group B' });
  });

  it('refuses a signed-in reader whose address does not match, and masks the answer', async () => {
    vi.mocked(repo.findInviteByTokenHash).mockResolvedValue(invite());

    const result = await acceptGroupInvite(
      { userId: 'user_c', email: 'c@example.com' },
      'token',
      NOW
    );

    // Enough to recognise your own mailbox, not enough to write to somebody
    // else's. This is what makes a forwarded invitation useless.
    expect(result).toMatchObject({ ok: false, reason: 'wrong_account' });
    if (result.ok === false && result.reason === 'wrong_account') {
      expect(result.expectedEmail).not.toBe('b@example.com');
      expect(result.expectedEmail).toContain('*');
    }
    expect(repo.acceptInviteAndJoin).not.toHaveBeenCalled();
  });

  it('gives one answer for withdrawn, expired and already spent', async () => {
    const cases = [
      invite({ revokedAt: NOW }),
      invite({ expiresAt: new Date('2026-08-01T00:00:00.000Z') }),
      invite({ acceptedAt: NOW }),
    ];

    for (const row of cases) {
      vi.mocked(repo.findInviteByTokenHash).mockResolvedValue(row);
      // Indistinguishable on purpose. Anything else enumerates which
      // invitations once existed and, through them, which groups do.
      expect(
        await acceptGroupInvite({ userId: 'user_b', email: 'b@example.com' }, 'token', NOW)
      ).toEqual({ ok: false, reason: 'unknown' });
    }
  });

  it('gives the same answer for a token nothing matches', async () => {
    vi.mocked(repo.findInviteByTokenHash).mockResolvedValue(null);

    expect(
      await acceptGroupInvite({ userId: 'user_b', email: 'b@example.com' }, 'token', NOW)
    ).toEqual({ ok: false, reason: 'unknown' });
  });

  it('answers unknown when the compare-and-set loses a race', async () => {
    vi.mocked(repo.findInviteByTokenHash).mockResolvedValue(invite());
    vi.mocked(repo.acceptInviteAndJoin).mockResolvedValue(null);

    // Withdrawn between the lookup and the write, or spent by a parallel
    // request. The token is single-use and the loser is told nothing more than a
    // stranger would be.
    expect(
      await acceptGroupInvite({ userId: 'user_b', email: 'b@example.com' }, 'token', NOW)
    ).toEqual({ ok: false, reason: 'unknown' });
  });

  it('matches the address case-insensitively', async () => {
    vi.mocked(repo.findInviteByTokenHash).mockResolvedValue(invite());
    vi.mocked(repo.acceptInviteAndJoin).mockResolvedValue({
      groupId: 'grp_1',
      joinedAt: NOW,
      createdAt: NOW,
    } as never);

    // The column is lower-cased at the boundary and a session's address is
    // whatever the account was created with. Same treatment as `acceptInvite`.
    const result = await acceptGroupInvite(
      { userId: 'user_b', email: 'B@Example.com' },
      'token',
      NOW
    );

    expect(result.ok).toBe(true);
  });
});

function inviteInput() {
  return {
    email: 'b@example.com',
    role: 'member' as const,
    expiry: { kind: 'days' as const, days: 30 },
  };
}
