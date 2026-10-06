/**
 * Unit Tests: a group space's storage quota (phase 58, §23.13).
 *
 * @see lib/framework/resparkable/services/storage-quota.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/framework/resparkable/repo/groups', () => ({ findGroupBySpaceId: vi.fn() }));
vi.mock('@/lib/framework/resparkable/repo/documents', () => ({ sumDocumentBytes: vi.fn() }));

import { sumDocumentBytes } from '@/lib/framework/resparkable/repo/documents';
import { findGroupBySpaceId } from '@/lib/framework/resparkable/repo/groups';
import { spaceScopeFor } from '@/lib/framework/resparkable/repo/space-scope';
import {
  DEFAULT_GROUP_STORAGE_QUOTA_BYTES,
  resolveStorageQuotaBytes,
  storageUsage,
} from '@/lib/framework/resparkable/services/storage-quota';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolveStorageQuotaBytes', () => {
  it('has no total for a personal space', async () => {
    vi.mocked(findGroupBySpaceId).mockResolvedValue(null);

    expect(await resolveStorageQuotaBytes('user_a')).toBeNull();
  });

  it('defaults a group to 2 GiB when the group has set nothing', async () => {
    vi.mocked(findGroupBySpaceId).mockResolvedValue({ storageQuotaBytes: null } as never);

    expect(await resolveStorageQuotaBytes('spc_g')).toBe(DEFAULT_GROUP_STORAGE_QUOTA_BYTES);
    expect(DEFAULT_GROUP_STORAGE_QUOTA_BYTES).toBe(2 * 1024 * 1024 * 1024);
  });

  it('reads the group’s own number, from the BigInt column, as a number', async () => {
    vi.mocked(findGroupBySpaceId).mockResolvedValue({
      storageQuotaBytes: BigInt(500_000_000),
    } as never);

    expect(await resolveStorageQuotaBytes('spc_g')).toBe(500_000_000);
  });
});

describe('storageUsage', () => {
  it('pairs what the space holds with its quota', async () => {
    vi.mocked(findGroupBySpaceId).mockResolvedValue({ storageQuotaBytes: null } as never);
    vi.mocked(sumDocumentBytes).mockResolvedValue(1234);
    const scope = spaceScopeFor({ spaceId: 'spc_g', actorUserId: 'user_a', role: 'member' });

    expect(await storageUsage(scope)).toEqual({
      usedBytes: 1234,
      quotaBytes: DEFAULT_GROUP_STORAGE_QUOTA_BYTES,
    });
  });
});
