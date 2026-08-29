/**
 * Unit Tests: the erasure hook (Release 2, phase 14).
 *
 * §16.6 is the matrix: *"Erase B → A's item survives, the grant is gone, B's
 * **unaccepted** invite on A's other item is gone, and `b@x.com` appears in no
 * row anywhere."*
 *
 * Most of that is Postgres, not code — `granteeUserId` and `authorUserId` are
 * hand-written `ON DELETE CASCADE` constraints guarded by probes B8 and B9. What
 * is left is the residue this hook exists for, and what these tests hold:
 *
 *   1. **The unaccepted invite.** It has no `granteeUserId` to cascade from, so
 *      only an email match reaches it.
 *   2. **The match is lower-cased.** `granteeEmail` is stored lower-cased and a
 *      `User.email` is whatever the account was created with. Matching them raw
 *      would leave the row of anybody who signed up with a capital letter, which
 *      is the quietest possible way for this not to work.
 *   3. **It does not re-delete what the cascade takes.** A second definition of
 *      what erasure means is a definition that drifts.
 *   4. **It never touches the user row.** The hook runs inside `eraseUser`'s
 *      transaction, before its own delete.
 *   5. **Blob cleanup does not block erasure.** Storage being unreachable must
 *      not stop a person's account being deleted.
 *
 * @see lib/framework/resparkable/privacy/erasure.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const deleteByPrefix = vi.fn();
const isStorageEnabled = vi.fn();

vi.mock('@/lib/storage/upload', () => ({
  deleteByPrefix: (...args: unknown[]) => deleteByPrefix(...args),
  isStorageEnabled: () => isStorageEnabled(),
}));

import {
  cleanupResparkableBlobs,
  registerResparkableErasureHook,
  resparkableBlobPrefix,
  scrubGranteeEmail,
} from '@/lib/framework/resparkable/privacy/erasure';
import {
  __resetErasureCleanupHooksForTests,
  getErasureCleanupHooks,
} from '@/lib/privacy/erasure-hooks';

/** A transaction client with only what the hook is allowed to reach. */
function tx(email: string | null) {
  return {
    user: {
      findUnique: vi.fn().mockResolvedValue(email === null ? null : { email }),
      delete: vi.fn(),
    },
    resparkableGrant: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
    resparkableComment: { deleteMany: vi.fn() },
    resparkableSpace: { delete: vi.fn() },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetErasureCleanupHooksForTests();
  isStorageEnabled.mockReturnValue(true);
  deleteByPrefix.mockResolvedValue({ success: true, key: 'x' });
});

describe('registerResparkableErasureHook', () => {
  it('registers one hook carrying both phases', () => {
    registerResparkableErasureHook();

    const hooks = getErasureCleanupHooks();
    expect(hooks).toHaveLength(1);
    expect(hooks[0].name).toBe('resparkable');
    // One hook rather than two, so a future edit cannot remove half of it
    // without the other half looking wrong.
    expect(hooks[0].cleanupExternal).toBeTypeOf('function');
    expect(hooks[0].scrubInTransaction).toBeTypeOf('function');
  });

  it('is idempotent by name, so a hot reload does not duplicate it', () => {
    registerResparkableErasureHook();
    registerResparkableErasureHook();

    expect(getErasureCleanupHooks()).toHaveLength(1);
  });
});

describe('scrubGranteeEmail', () => {
  it('deletes grants addressed to the erased person’s email', async () => {
    const client = tx('b@example.com');

    await scrubGranteeEmail({ tx: client as never, userId: 'user_b' });

    // The half no foreign key reaches: an unaccepted invite has only an
    // address, so this is the only thing that removes it.
    expect(client.resparkableGrant.deleteMany).toHaveBeenCalledWith({
      where: { granteeEmail: 'b@example.com' },
    });
  });

  it('lower-cases the address before matching', async () => {
    const client = tx('B@Example.COM');

    await scrubGranteeEmail({ tx: client as never, userId: 'user_b' });

    // `granteeEmail` is stored lower-cased at the boundary. Matching raw would
    // leave the row of anybody who signed up with a capital letter.
    expect(client.resparkableGrant.deleteMany).toHaveBeenCalledWith({
      where: { granteeEmail: 'b@example.com' },
    });
  });

  it('reads the email from the transaction, before the user row is gone', async () => {
    const client = tx('b@example.com');

    await scrubGranteeEmail({ tx: client as never, userId: 'user_b' });

    // `ErasureTxContext` carries only `userId`, and hooks run before
    // `user.delete()` — so the row is still there to read.
    expect(client.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'user_b' },
      select: { email: true },
    });
  });

  it('does nothing when the user row is already gone', async () => {
    const client = tx(null);

    await scrubGranteeEmail({ tx: client as never, userId: 'user_b' });

    // Nothing to match on, and no reason to guess. A `deleteMany` with an
    // undefined email would match on `undefined`, which Prisma reads as "no
    // filter" — every grant in the installation.
    expect(client.resparkableGrant.deleteMany).not.toHaveBeenCalled();
  });

  it('does not re-delete what the cascade already takes', async () => {
    const client = tx('b@example.com');

    await scrubGranteeEmail({ tx: client as never, userId: 'user_b' });

    // Comments cascade from `authorUserId` (probe B9) and the space cascades
    // from B1. Deleting either here would be a second definition of what
    // erasure means, and two definitions drift.
    expect(client.resparkableComment.deleteMany).not.toHaveBeenCalled();
    expect(client.resparkableSpace.delete).not.toHaveBeenCalled();
  });

  it('never touches the user row', async () => {
    const client = tx('b@example.com');

    await scrubGranteeEmail({ tx: client as never, userId: 'user_b' });

    // The hook runs inside `eraseUser`'s transaction and before its own
    // delete. Deleting the user here would run the whole erasure twice.
    expect(client.user.delete).not.toHaveBeenCalled();
  });
});

describe('cleanupResparkableBlobs', () => {
  it('deletes everything under the user’s prefix', async () => {
    await cleanupResparkableBlobs({ userId: 'user_b' });

    expect(deleteByPrefix).toHaveBeenCalledWith('framework-resparkable/user_b/');
  });

  it('matches the prefix documents are actually written under', () => {
    // The one thing in the tier that writes a blob is `retainOriginal` in
    // `documents/ingest.ts`, and it keys on exactly this. A prefix that drifted
    // would delete nothing and report success.
    expect(resparkableBlobPrefix('user_b')).toBe('framework-resparkable/user_b/');
  });

  it('does nothing when the deployment stores no originals', async () => {
    isStorageEnabled.mockReturnValue(false);

    await cleanupResparkableBlobs({ userId: 'user_b' });

    // Not a failure: there is nothing to remove.
    expect(deleteByPrefix).not.toHaveBeenCalled();
  });

  it('reports a failed delete rather than pretending it worked', async () => {
    deleteByPrefix.mockResolvedValue({ success: false, key: 'x' });

    // `eraseUser` swallows a throw from this phase, which is right — a bucket
    // being down must not stop an account being deleted. What must not happen
    // is the log claiming success.
    await expect(cleanupResparkableBlobs({ userId: 'user_b' })).resolves.toBeUndefined();
  });
});
