/**
 * Unit Tests: the group admin record's storage (phase 58, §23.13).
 *
 * @see lib/framework/resparkable/repo/group-audit.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: { resparkableGroupAuditEntry: { create: vi.fn(), findMany: vi.fn() } },
}));

import { prisma } from '@/lib/db/client';
import {
  insertGroupAuditEntry,
  listGroupAuditEntries,
} from '@/lib/framework/resparkable/repo/group-audit';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.resparkableGroupAuditEntry.findMany).mockResolvedValue([]);
});

describe('insertGroupAuditEntry', () => {
  it('writes the entry, with no subject when the action landed on nobody', async () => {
    await insertGroupAuditEntry({ groupId: 'g', actorUserId: 'u', action: 'join_link_revoked' });

    expect(prisma.resparkableGroupAuditEntry.create).toHaveBeenCalledWith({
      data: { groupId: 'g', actorUserId: 'u', subjectUserId: null, action: 'join_link_revoked' },
    });
  });

  it('keeps the metadata when there is some', async () => {
    await insertGroupAuditEntry({
      groupId: 'g',
      actorUserId: null,
      subjectUserId: 's',
      action: 'role_changed',
      metadata: { to: 'admin' },
    });

    expect(prisma.resparkableGroupAuditEntry.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ actorUserId: null, metadata: { to: 'admin' } }),
    });
  });
});

describe('listGroupAuditEntries', () => {
  it('reads the group’s record newest first', async () => {
    await listGroupAuditEntries('g');

    expect(prisma.resparkableGroupAuditEntry.findMany).toHaveBeenCalledWith({
      where: { groupId: 'g' },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  });

  it('narrows to one person’s entries when the service asks', async () => {
    await listGroupAuditEntries('g', { subjectUserId: 's', take: 10 });

    expect(prisma.resparkableGroupAuditEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { groupId: 'g', subjectUserId: 's' }, take: 10 })
    );
  });
});
