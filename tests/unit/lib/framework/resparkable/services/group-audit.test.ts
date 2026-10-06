/**
 * Unit Tests: the group admin record (phase 58, §23.13).
 *
 * Admins read every entry; anybody else reads what was done to them. Decided
 * from the role, never by a membership-shaped query.
 *
 * @see lib/framework/resparkable/services/group-audit.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/framework/resparkable/repo/group-audit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/framework/resparkable/repo/group-audit')>()),
  insertGroupAuditEntry: vi.fn(),
  listGroupAuditEntries: vi.fn(),
}));
vi.mock('@/lib/framework/resparkable/repo/groups', () => ({ findAccountNames: vi.fn() }));
vi.mock('@/lib/framework/resparkable/services/membership', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/framework/resparkable/services/membership')>()),
  resolveGroupMembership: vi.fn(),
}));
vi.mock('@/lib/logging', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

import {
  insertGroupAuditEntry,
  listGroupAuditEntries,
} from '@/lib/framework/resparkable/repo/group-audit';
import { findAccountNames } from '@/lib/framework/resparkable/repo/groups';
import { listGroupAudit, recordGroupAudit } from '@/lib/framework/resparkable/services/group-audit';
import { resolveGroupMembership } from '@/lib/framework/resparkable/services/membership';
import { logger } from '@/lib/logging';

const ROWS = [
  {
    id: 'a1',
    groupId: 'grp_1',
    actorUserId: 'user_sam',
    subjectUserId: 'user_me',
    action: 'role_changed',
    metadata: { from: 'member', to: 'viewer' },
    createdAt: new Date('2026-10-01T10:00:00.000Z'),
  },
  {
    id: 'a2',
    groupId: 'grp_1',
    actorUserId: 'user_me',
    subjectUserId: null,
    action: 'join_link_minted',
    metadata: null,
    createdAt: new Date('2026-10-02T10:00:00.000Z'),
  },
];

function as(role: string) {
  vi.mocked(resolveGroupMembership).mockResolvedValue({
    scope: { role },
    membership: { group: { name: 'Study group' } },
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listGroupAuditEntries).mockResolvedValue(ROWS);
  vi.mocked(findAccountNames).mockResolvedValue(
    new Map([
      ['user_sam', 'Sam'],
      ['user_me', 'Me'],
    ])
  );
});

describe('listGroupAudit', () => {
  it('refuses somebody who is not in the group', async () => {
    vi.mocked(resolveGroupMembership).mockResolvedValue(null);

    expect(await listGroupAudit('user_me', 'grp_1')).toEqual({ ok: false, reason: 'not_a_member' });
    expect(listGroupAuditEntries).not.toHaveBeenCalled();
  });

  it('gives an admin every entry, with names and whose part it was', async () => {
    as('admin');

    const result = await listGroupAudit('user_me', 'grp_1');

    expect(listGroupAuditEntries).toHaveBeenCalledWith('grp_1', {});
    expect(result).toMatchObject({ ok: true, scope: 'all' });
    if (!result.ok) throw new Error('expected ok');
    expect(result.entries[0]).toMatchObject({
      actorName: 'Sam',
      subjectName: 'Me',
      aboutYou: true,
      byYou: false,
    });
    expect(result.entries[1]).toMatchObject({ subjectName: null, byYou: true });
  });

  it('gives any other member only what was done to them', async () => {
    as('member');

    const result = await listGroupAudit('user_me', 'grp_1');

    expect(listGroupAuditEntries).toHaveBeenCalledWith('grp_1', { subjectUserId: 'user_me' });
    expect(result).toMatchObject({ ok: true, scope: 'about_you' });
  });
});

describe('recordGroupAudit', () => {
  it('writes the entry', async () => {
    const entry = {
      groupId: 'grp_1',
      actorUserId: 'user_me',
      action: 'join_link_revoked' as const,
    };

    await recordGroupAudit(entry);

    expect(insertGroupAuditEntry).toHaveBeenCalledWith(entry);
  });

  it('never fails the action it records', async () => {
    vi.mocked(insertGroupAuditEntry).mockRejectedValue(new Error('db down'));

    await expect(
      recordGroupAudit({ groupId: 'grp_1', actorUserId: 'user_me', action: 'topped_up' })
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      'Resparkable group audit entry not written',
      expect.objectContaining({ groupId: 'grp_1', action: 'topped_up' })
    );
  });
});
