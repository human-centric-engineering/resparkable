/**
 * Unit Tests: group join links (Release 9, phase 57, §23.11).
 *
 * A join link is a bearer credential to a whole workspace, so what has to hold
 * is the discipline §13's public links already carry, plus two rules unique to
 * this surface:
 *
 *   1. **`role` can never be `admin`.** Refused twice: `createJoinLinkSchema`
 *      at the boundary, and `mintJoinLink` again for a caller that reaches the
 *      service without going through the schema (test 13i).
 *   2. **Only the digest is stored.** The raw token is returned once, by
 *      `mintJoinLink`, and never again; the view handed to the admin's list
 *      carries no `tokenHash`.
 *   3. **Every bad-token reason collapses to `unknown`** before redemption is
 *      even attempted: unknown, revoked, expired and used-up are one answer,
 *      because anything else is an oracle about which links once existed.
 *      `group_full` is the one exception, because the person holding a live
 *      link is somebody an admin chose to let knock.
 *   4. **Approval and rejection are admin-only**, and reuse the same refusal
 *      vocabulary `resolveGroupMembership` already gives everything else in
 *      the tier.
 *
 * The repo layer is mocked throughout: this is about the service's decisions,
 * not the SQL, which `repo/groups.test.ts` covers.
 *
 * @see lib/framework/resparkable/services/group-join-links.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/framework/resparkable/repo/groups', () => ({
  approveJoinRequest: vi.fn(),
  createJoinLink: vi.fn(),
  deleteJoinRequest: vi.fn(),
  findJoinLinkByTokenHash: vi.fn(),
  listJoinLinks: vi.fn(),
  redeemJoinLink: vi.fn(),
  revokeJoinLink: vi.fn(),
}));
vi.mock('@/lib/framework/resparkable/services/membership', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveGroupMembership: vi.fn(),
}));
vi.mock('@/lib/env', () => ({ env: { NEXT_PUBLIC_APP_URL: 'https://app.example.com' } }));
vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { hashShareToken } from '@/lib/framework/resparkable/access/resolve';
import * as repo from '@/lib/framework/resparkable/repo/groups';
import { spaceScopeFor } from '@/lib/framework/resparkable/repo/space-scope';
import {
  approveGroupJoinRequest,
  defaultApprovalFor,
  mintJoinLink,
  redeemJoinLinkToken,
  rejectGroupJoinRequest,
} from '@/lib/framework/resparkable/services/group-join-links';
import { resolveGroupMembership } from '@/lib/framework/resparkable/services/membership';
import type { CreateJoinLinkInput } from '@/lib/framework/resparkable/validations';

const NOW = new Date('2026-09-25T10:00:00.000Z');
const SPACE = 'spc_group_1';
const DAY_MS = 24 * 60 * 60 * 1000;

function group(overrides: Record<string, unknown> = {}) {
  return {
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
    ...overrides,
  };
}

function resolvedAs(role: 'admin' | 'member' | 'viewer') {
  return {
    membership: {
      id: 'mem_a',
      groupId: 'grp_1',
      userId: 'user_a',
      role,
      invitedByUserId: null,
      soleAdminNotifiedAt: null,
      dailyCreditCap: null,
      joinedAt: NOW,
      requestedAt: null,
      joinLinkId: null,
      createdAt: NOW,
      updatedAt: NOW,
      group: group(),
    },
    scope: spaceScopeFor({ spaceId: SPACE, actorUserId: 'user_a', role }),
  };
}

function link(overrides: Record<string, unknown> = {}) {
  return {
    id: 'link_1',
    groupId: 'grp_1',
    tokenHash: 'digest_1',
    tokenPrefix: 'abcdef',
    role: 'member',
    approval: 'request',
    maxUses: null,
    useCount: 0,
    expiresAt: new Date('2026-10-25T10:00:00.000Z'),
    revokedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    group: group(),
    ...overrides,
  };
}

const VALID_INPUT: CreateJoinLinkInput = {
  role: 'member',
  expiry: { kind: 'days', days: 30 },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('mintJoinLink', () => {
  it('refuses role: admin even when the caller bypasses the schema, and asks nothing about membership', async () => {
    // The schema already refuses `admin` at the boundary. This proves the
    // second layer: a caller that skips `createJoinLinkSchema` still cannot
    // mint one, and the check happens before any membership read at all.
    const bypassed = {
      role: 'admin',
      expiry: { kind: 'days', days: 30 },
    } as unknown as CreateJoinLinkInput;

    const result = await mintJoinLink('user_a', 'grp_1', bypassed, NOW);

    expect(result).toEqual({ ok: false, reason: 'admin_link' });
    expect(resolveGroupMembership).not.toHaveBeenCalled();
    expect(repo.createJoinLink).not.toHaveBeenCalled();
  });

  it('refuses a non-member', async () => {
    vi.mocked(resolveGroupMembership).mockResolvedValue(null);

    const result = await mintJoinLink('user_stranger', 'grp_1', VALID_INPUT, NOW);

    expect(result).toEqual({ ok: false, reason: 'not_a_member' });
    expect(repo.createJoinLink).not.toHaveBeenCalled();
  });

  it('refuses a member who is not an admin', async () => {
    vi.mocked(resolveGroupMembership).mockResolvedValue(resolvedAs('member'));

    const result = await mintJoinLink('user_a', 'grp_1', VALID_INPUT, NOW);

    expect(result).toEqual({ ok: false, reason: 'not_an_admin' });
    expect(repo.createJoinLink).not.toHaveBeenCalled();
  });

  it('mints a 32-character base64url token and stores only its sha256 digest and a 6-character prefix', async () => {
    vi.mocked(resolveGroupMembership).mockResolvedValue(resolvedAs('admin'));
    vi.mocked(repo.createJoinLink).mockResolvedValue(link());

    const result = await mintJoinLink('user_a', 'grp_1', VALID_INPUT, NOW);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The token is returned here and nowhere else. Verified by shape rather
    // than by value, since it is 24 random bytes.
    expect(result.token).toMatch(/^[A-Za-z0-9_-]{32}$/);

    const data = vi.mocked(repo.createJoinLink).mock.calls[0][0];
    // The stored hash is the digest of the RETURNED token, never the token
    // itself — a database dump must not be a set of live credentials.
    expect(data.tokenHash).toBe(hashShareToken(result.token));
    expect(data.tokenHash).not.toBe(result.token);
    expect(data.tokenPrefix).toBe(result.token.slice(0, 6));
    expect(data.tokenPrefix).toHaveLength(6);
  });

  it('never returns the digest on the view the admin’s list renders', async () => {
    vi.mocked(resolveGroupMembership).mockResolvedValue(resolvedAs('admin'));
    vi.mocked(repo.createJoinLink).mockResolvedValue(link());

    const result = await mintJoinLink('user_a', 'grp_1', VALID_INPUT, NOW);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.link).not.toHaveProperty('tokenHash');
  });

  it('defaults approval to request for a member link', async () => {
    vi.mocked(resolveGroupMembership).mockResolvedValue(resolvedAs('admin'));
    vi.mocked(repo.createJoinLink).mockResolvedValue(link());

    await mintJoinLink(
      'user_a',
      'grp_1',
      { role: 'member', expiry: { kind: 'days', days: 30 } },
      NOW
    );

    expect(vi.mocked(repo.createJoinLink).mock.calls[0][0]).toMatchObject({ approval: 'request' });
  });

  it('defaults approval to open for a viewer link', async () => {
    vi.mocked(resolveGroupMembership).mockResolvedValue(resolvedAs('admin'));
    vi.mocked(repo.createJoinLink).mockResolvedValue(link());

    await mintJoinLink(
      'user_a',
      'grp_1',
      { role: 'viewer', expiry: { kind: 'days', days: 30 } },
      NOW
    );

    expect(vi.mocked(repo.createJoinLink).mock.calls[0][0]).toMatchObject({ approval: 'open' });
  });

  it('lets the admin override the default approval for either role', async () => {
    vi.mocked(resolveGroupMembership).mockResolvedValue(resolvedAs('admin'));
    vi.mocked(repo.createJoinLink).mockResolvedValue(link());

    await mintJoinLink(
      'user_a',
      'grp_1',
      { role: 'viewer', approval: 'request', expiry: { kind: 'days', days: 30 } },
      NOW
    );

    expect(vi.mocked(repo.createJoinLink).mock.calls[0][0]).toMatchObject({ approval: 'request' });
  });

  it('turns a days expiry into an absolute timestamp from now', async () => {
    vi.mocked(resolveGroupMembership).mockResolvedValue(resolvedAs('admin'));
    vi.mocked(repo.createJoinLink).mockResolvedValue(link());

    await mintJoinLink(
      'user_a',
      'grp_1',
      { role: 'member', expiry: { kind: 'days', days: 7 } },
      NOW
    );

    const data = vi.mocked(repo.createJoinLink).mock.calls[0][0];
    expect(data.expiresAt).toEqual(new Date(NOW.getTime() + 7 * DAY_MS));
  });

  it('mints an expiresAt of null for an explicit "never"', async () => {
    vi.mocked(resolveGroupMembership).mockResolvedValue(resolvedAs('admin'));
    vi.mocked(repo.createJoinLink).mockResolvedValue(link());

    await mintJoinLink('user_a', 'grp_1', { role: 'member', expiry: { kind: 'never' } }, NOW);

    expect(vi.mocked(repo.createJoinLink).mock.calls[0][0]).toMatchObject({ expiresAt: null });
  });

  it('returns a join URL built from the returned token, not the digest', async () => {
    vi.mocked(resolveGroupMembership).mockResolvedValue(resolvedAs('admin'));
    vi.mocked(repo.createJoinLink).mockResolvedValue(link());

    const result = await mintJoinLink('user_a', 'grp_1', VALID_INPUT, NOW);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.url).toBe(`https://app.example.com/resparkable/groups/join/${result.token}`);
  });
});

describe('defaultApprovalFor', () => {
  it('is request for member and open for viewer', () => {
    expect(defaultApprovalFor('member')).toBe('request');
    expect(defaultApprovalFor('viewer')).toBe('open');
  });
});

describe('redeemJoinLinkToken', () => {
  it('answers unknown for a token that resolves to no link, without redeeming anything', async () => {
    vi.mocked(repo.findJoinLinkByTokenHash).mockResolvedValue(null);

    const result = await redeemJoinLinkToken('user_b', 'sometoken', NOW);

    expect(result).toEqual({ ok: false, reason: 'unknown' });
    expect(repo.redeemJoinLink).not.toHaveBeenCalled();
  });

  it('answers unknown for a revoked link, without redeeming anything', async () => {
    vi.mocked(repo.findJoinLinkByTokenHash).mockResolvedValue(link({ revokedAt: NOW }));

    const result = await redeemJoinLinkToken('user_b', 'sometoken', NOW);

    expect(result).toEqual({ ok: false, reason: 'unknown' });
    expect(repo.redeemJoinLink).not.toHaveBeenCalled();
  });

  it('answers unknown for an expired link, without redeeming anything', async () => {
    vi.mocked(repo.findJoinLinkByTokenHash).mockResolvedValue(
      link({ expiresAt: new Date('2026-01-01T00:00:00.000Z') })
    );

    const result = await redeemJoinLinkToken('user_b', 'sometoken', NOW);

    expect(result).toEqual({ ok: false, reason: 'unknown' });
    expect(repo.redeemJoinLink).not.toHaveBeenCalled();
  });

  it('passes a used-up link through to the repo rather than short-circuiting, and maps its spent answer to unknown', async () => {
    // The used-up check now lives inside the repo transaction, behind the
    // group lock, alongside "are you already in" — a link that looked used up
    // here but was refunded a use a moment ago (a withdrawn request) must not
    // be turned away by a check made outside that lock.
    vi.mocked(repo.findJoinLinkByTokenHash).mockResolvedValue(link({ maxUses: 5, useCount: 5 }));
    vi.mocked(repo.redeemJoinLink).mockResolvedValue({ kind: 'spent' });

    const result = await redeemJoinLinkToken('user_b', 'sometoken', NOW);

    expect(result).toEqual({ ok: false, reason: 'unknown' });
    expect(repo.redeemJoinLink).toHaveBeenCalledWith(
      expect.objectContaining({ maxUses: 5, useCount: 5 }),
      'user_b',
      NOW
    );
  });

  it('passes an unlimited link (maxUses null) through with whatever its useCount is', async () => {
    vi.mocked(repo.findJoinLinkByTokenHash).mockResolvedValue(
      link({ maxUses: null, useCount: 500 })
    );
    vi.mocked(repo.redeemJoinLink).mockResolvedValue({ kind: 'joined' });

    const result = await redeemJoinLinkToken('user_b', 'sometoken', NOW);

    expect(result.ok).toBe(true);
    expect(repo.redeemJoinLink).toHaveBeenCalledWith(
      expect.objectContaining({ maxUses: null, useCount: 500 }),
      'user_b',
      NOW
    );
  });

  it('maps a repo "spent" outcome to the same unknown answer as a bad token', async () => {
    vi.mocked(repo.findJoinLinkByTokenHash).mockResolvedValue(link());
    vi.mocked(repo.redeemJoinLink).mockResolvedValue({ kind: 'spent' });

    const result = await redeemJoinLinkToken('user_b', 'sometoken', NOW);

    expect(result).toEqual({ ok: false, reason: 'unknown' });
  });

  it('answers group_full with the group’s name: the one failure that explains itself', async () => {
    vi.mocked(repo.findJoinLinkByTokenHash).mockResolvedValue(link());
    vi.mocked(repo.redeemJoinLink).mockResolvedValue({ kind: 'group_full' });

    const result = await redeemJoinLinkToken('user_b', 'sometoken', NOW);

    expect(result).toEqual({ ok: false, reason: 'group_full', groupName: 'Study Group B' });
  });

  it.each(['joined', 'requested', 'already_member', 'already_requested'] as const)(
    'passes a %s outcome through with the group id and name',
    async (outcome) => {
      vi.mocked(repo.findJoinLinkByTokenHash).mockResolvedValue(link());
      vi.mocked(repo.redeemJoinLink).mockResolvedValue({ kind: outcome });

      const result = await redeemJoinLinkToken('user_b', 'sometoken', NOW);

      expect(result).toEqual({
        ok: true,
        outcome,
        groupId: 'grp_1',
        groupName: 'Study Group B',
      });
    }
  );

  it('resolves the link by the digest of the given token, never the raw token', async () => {
    vi.mocked(repo.findJoinLinkByTokenHash).mockResolvedValue(link());
    vi.mocked(repo.redeemJoinLink).mockResolvedValue({ kind: 'joined' });

    await redeemJoinLinkToken('user_b', 'sometoken', NOW);

    expect(repo.findJoinLinkByTokenHash).toHaveBeenCalledWith(hashShareToken('sometoken'));
  });
});

describe('approveGroupJoinRequest', () => {
  it('is admin only: refuses a non-member', async () => {
    vi.mocked(resolveGroupMembership).mockResolvedValue(null);

    const result = await approveGroupJoinRequest('user_stranger', 'grp_1', 'user_b', NOW);

    expect(result).toEqual({ ok: false, reason: 'not_a_member' });
    expect(repo.approveJoinRequest).not.toHaveBeenCalled();
  });

  it('is admin only: refuses a member who is not an admin', async () => {
    vi.mocked(resolveGroupMembership).mockResolvedValue(resolvedAs('member'));

    const result = await approveGroupJoinRequest('user_a', 'grp_1', 'user_b', NOW);

    expect(result).toEqual({ ok: false, reason: 'not_an_admin' });
    expect(repo.approveJoinRequest).not.toHaveBeenCalled();
  });

  it('maps no_such_request to no_such_member', async () => {
    vi.mocked(resolveGroupMembership).mockResolvedValue(resolvedAs('admin'));
    vi.mocked(repo.approveJoinRequest).mockResolvedValue('no_such_request');

    const result = await approveGroupJoinRequest('user_a', 'grp_1', 'user_b', NOW);

    expect(result).toEqual({ ok: false, reason: 'no_such_member' });
  });

  it('passes group_full straight through: the cap is re-checked on approval too', async () => {
    vi.mocked(resolveGroupMembership).mockResolvedValue(resolvedAs('admin'));
    vi.mocked(repo.approveJoinRequest).mockResolvedValue('group_full');

    const result = await approveGroupJoinRequest('user_a', 'grp_1', 'user_b', NOW);

    expect(result).toEqual({ ok: false, reason: 'group_full' });
  });

  it('succeeds for an admin approving a pending request under the cap', async () => {
    vi.mocked(resolveGroupMembership).mockResolvedValue(resolvedAs('admin'));
    vi.mocked(repo.approveJoinRequest).mockResolvedValue('approved');

    const result = await approveGroupJoinRequest('user_a', 'grp_1', 'user_b', NOW);

    expect(result).toEqual({ ok: true });
    expect(repo.approveJoinRequest).toHaveBeenCalledWith('grp_1', 'user_b', NOW);
  });
});

describe('rejectGroupJoinRequest', () => {
  it('is admin only: refuses a non-member', async () => {
    vi.mocked(resolveGroupMembership).mockResolvedValue(null);

    const result = await rejectGroupJoinRequest('user_stranger', 'grp_1', 'user_b');

    expect(result).toEqual({ ok: false, reason: 'not_a_member' });
    expect(repo.deleteJoinRequest).not.toHaveBeenCalled();
  });

  it('is admin only: refuses a member who is not an admin', async () => {
    vi.mocked(resolveGroupMembership).mockResolvedValue(resolvedAs('viewer'));

    const result = await rejectGroupJoinRequest('user_a', 'grp_1', 'user_b');

    expect(result).toEqual({ ok: false, reason: 'not_an_admin' });
    expect(repo.deleteJoinRequest).not.toHaveBeenCalled();
  });

  it('answers no_such_member when there was no pending row to delete', async () => {
    vi.mocked(resolveGroupMembership).mockResolvedValue(resolvedAs('admin'));
    vi.mocked(repo.deleteJoinRequest).mockResolvedValue(false);

    const result = await rejectGroupJoinRequest('user_a', 'grp_1', 'user_b');

    expect(result).toEqual({ ok: false, reason: 'no_such_member' });
  });

  it('deletes the pending row and leaves nothing behind, per §23.11', async () => {
    vi.mocked(resolveGroupMembership).mockResolvedValue(resolvedAs('admin'));
    vi.mocked(repo.deleteJoinRequest).mockResolvedValue(true);

    const result = await rejectGroupJoinRequest('user_a', 'grp_1', 'user_b');

    expect(result).toEqual({ ok: true });
    expect(repo.deleteJoinRequest).toHaveBeenCalledWith('grp_1', 'user_b');
  });
});
