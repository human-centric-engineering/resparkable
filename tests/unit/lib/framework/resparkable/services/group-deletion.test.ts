/**
 * Unit Tests: deleting a group (Release 9, phase 48, §23.6).
 *
 * The one action in the tier that destroys a workspace other people were
 * writing into. What has to hold:
 *
 *   1. **Nothing is deleted without the group's name typed back.** Checked in
 *      the service, so it holds for every caller and not only for the dialog.
 *   2. **Admin only, and a stranger learns nothing.** `not_a_member` for a
 *      non-member, which the route turns into a 404.
 *   3. **The space is what gets deleted**, never the group row, which would
 *      strand all 23 satellites.
 *   4. **Every other member is told, and the addresses are read before the
 *      delete**, because afterwards nothing says who was in the group.
 *   5. **A failed email does not un-report a committed delete.**
 *
 * @see lib/framework/resparkable/services/group-deletion.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/framework/resparkable/repo/groups', () => ({
  deleteGroupSpace: vi.fn(),
  listMemberContacts: vi.fn(),
}));

vi.mock('@/lib/framework/resparkable/repo/owner-contact', () => ({
  findOwnerContact: vi.fn(),
}));

vi.mock('@/lib/framework/resparkable/services/membership', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/framework/resparkable/services/membership')>();
  return {
    permissionsFor: actual.permissionsFor,
    resolveGroupMembership: vi.fn(),
  };
});

vi.mock('@/lib/email/send', () => ({ sendEmail: vi.fn() }));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import * as repo from '@/lib/framework/resparkable/repo/groups';
import { findOwnerContact } from '@/lib/framework/resparkable/repo/owner-contact';
import { spaceScopeFor } from '@/lib/framework/resparkable/repo/space-scope';
import {
  confirmationMatches,
  deleteGroupConfirmed,
} from '@/lib/framework/resparkable/services/group-deletion';
import { resolveGroupMembership } from '@/lib/framework/resparkable/services/membership';
import { sendEmail } from '@/lib/email/send';

const SPACE = 'spc_group_1';
const NOW = new Date('2026-09-18T10:00:00.000Z');

function resolvedAs(role: 'admin' | 'member' | 'viewer') {
  return {
    membership: {
      id: 'mem_a',
      groupId: 'grp_1',
      userId: 'user_a',
      role,
      invitedByUserId: null,
      soleAdminNotifiedAt: null,
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
        viewersCanInheritAdmin: true,
        createdAt: NOW,
        updatedAt: NOW,
      },
    },
    scope: spaceScopeFor({ spaceId: SPACE, actorUserId: 'user_a', role }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveGroupMembership).mockResolvedValue(resolvedAs('admin'));
  vi.mocked(findOwnerContact).mockResolvedValue({
    email: 'a@example.com',
    name: 'Ana',
    emailVerified: true,
  });
  vi.mocked(repo.listMemberContacts).mockResolvedValue([
    { userId: 'user_a', email: 'a@example.com', name: 'Ana' },
    { userId: 'user_b', email: 'b@example.com', name: 'Bo' },
    { userId: 'user_c', email: 'c@example.com', name: null },
  ]);
  vi.mocked(sendEmail).mockResolvedValue({ success: true, status: 'sent' as const });
});

describe('confirmationMatches', () => {
  it('accepts the exact name', () => {
    expect(confirmationMatches('Study Group B', 'Study Group B')).toBe(true);
  });

  it('forgives surrounding whitespace, which is invisible in an input', () => {
    expect(confirmationMatches('Study Group B', '  Study Group B ')).toBe(true);
  });

  it('does not forgive case: typing the name is how it gets read', () => {
    expect(confirmationMatches('Study Group B', 'study group b')).toBe(false);
  });

  it('refuses an empty confirmation', () => {
    expect(confirmationMatches('Study Group B', '   ')).toBe(false);
  });
});

describe('deleteGroupConfirmed', () => {
  it('refuses a mismatched name and deletes nothing', async () => {
    const result = await deleteGroupConfirmed('user_a', 'grp_1', 'Study Group A');

    expect(result).toEqual({ ok: false, reason: 'confirmation_mismatch' });
    expect(repo.deleteGroupSpace).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('refuses a member who is not an admin, even with the right name', async () => {
    vi.mocked(resolveGroupMembership).mockResolvedValue(resolvedAs('member'));

    const result = await deleteGroupConfirmed('user_a', 'grp_1', 'Study Group B');

    expect(result).toEqual({ ok: false, reason: 'not_an_admin' });
    expect(repo.deleteGroupSpace).not.toHaveBeenCalled();
  });

  it('answers a stranger with not_a_member before looking at the name', async () => {
    vi.mocked(resolveGroupMembership).mockResolvedValue(null);

    // The name check comes after membership, so a stranger guessing names
    // cannot tell a wrong name from a group they are not in.
    const result = await deleteGroupConfirmed('user_x', 'grp_1', 'wrong');

    expect(result).toEqual({ ok: false, reason: 'not_a_member' });
    expect(repo.listMemberContacts).not.toHaveBeenCalled();
  });

  it('deletes the space, not the group row', async () => {
    await deleteGroupConfirmed('user_a', 'grp_1', 'Study Group B');

    expect(repo.deleteGroupSpace).toHaveBeenCalledWith(SPACE);
  });

  it('reads who to tell before the delete, because the delete removes the memberships', async () => {
    const order: string[] = [];
    vi.mocked(repo.listMemberContacts).mockImplementation(async () => {
      order.push('read');
      return [{ userId: 'user_b', email: 'b@example.com', name: 'Bo' }];
    });
    vi.mocked(repo.deleteGroupSpace).mockImplementation(async () => {
      order.push('delete');
    });
    vi.mocked(sendEmail).mockImplementation(async () => {
      order.push('send');
      return { success: true, status: 'sent' as const };
    });

    await deleteGroupConfirmed('user_a', 'grp_1', 'Study Group B');

    expect(order).toEqual(['read', 'delete', 'send']);
  });

  it('emails every other member, and not the admin who did it', async () => {
    const result = await deleteGroupConfirmed('user_a', 'grp_1', 'Study Group B');

    const recipients = vi.mocked(sendEmail).mock.calls.map(([options]) => options.to);
    expect(recipients).toEqual(['b@example.com', 'c@example.com']);
    expect(result).toEqual({ ok: true, notified: 2, notifyFailed: 0 });
  });

  it('names the group in the subject and nothing that was in it', async () => {
    await deleteGroupConfirmed('user_a', 'grp_1', 'Study Group B');

    expect(vi.mocked(sendEmail).mock.calls[0][0].subject).toBe('Study Group B has been deleted');
  });

  it('reports a failed send without un-reporting the delete', async () => {
    vi.mocked(sendEmail)
      .mockResolvedValueOnce({ success: false, status: 'failed' as const, error: 'provider down' })
      .mockRejectedValueOnce(new Error('timeout'));

    const result = await deleteGroupConfirmed('user_a', 'grp_1', 'Study Group B');

    // The delete has committed. A throw here would tell the admin it failed.
    expect(repo.deleteGroupSpace).toHaveBeenCalled();
    expect(result).toEqual({ ok: true, notified: 0, notifyFailed: 2 });
  });
});
