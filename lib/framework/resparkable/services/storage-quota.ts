/**
 * A group space's storage quota (§23.13, phase 58).
 *
 * The shared shelf is a real ingestion: the original is retained under
 * `framework-resparkable/<spaceId>/`, and a few books' worth adds up across a
 * class. So a group space has a total its retained originals may not exceed,
 * owned by the group: `ResparkableGroup.storageQuotaBytes`, `null` meaning
 * {@link DEFAULT_GROUP_STORAGE_QUOTA_BYTES}. A personal space has no total,
 * only the per-file cap it always had.
 */

import { sumDocumentBytes } from '@/lib/framework/resparkable/repo/documents';
import { findGroupBySpaceId } from '@/lib/framework/resparkable/repo/groups';
import type { SpaceScope } from '@/lib/framework/resparkable/repo/space-scope';

export { formatBytes } from '@/lib/framework/resparkable/ui/format-bytes';

/** 2 GiB: a class's worth of books and papers, with room. */
export const DEFAULT_GROUP_STORAGE_QUOTA_BYTES = 2 * 1024 * 1024 * 1024;

export interface StorageUsage {
  usedBytes: number;
  /** `null` for a personal space, which has no total. */
  quotaBytes: number | null;
}

/** The space's quota, or `null` when it has none (a personal space). */
export async function resolveStorageQuotaBytes(spaceId: string): Promise<number | null> {
  const group = await findGroupBySpaceId(spaceId);
  if (!group) return null;
  // BigInt in the column, a number everywhere else: 2 GiB and any quota an
  // admin could reasonably set are far inside `Number.MAX_SAFE_INTEGER`.
  return group.storageQuotaBytes === null
    ? DEFAULT_GROUP_STORAGE_QUOTA_BYTES
    : Number(group.storageQuotaBytes);
}

export async function storageUsage(scope: SpaceScope): Promise<StorageUsage> {
  const [usedBytes, quotaBytes] = await Promise.all([
    sumDocumentBytes(scope),
    resolveStorageQuotaBytes(scope.spaceId),
  ]);
  return { usedBytes, quotaBytes };
}
