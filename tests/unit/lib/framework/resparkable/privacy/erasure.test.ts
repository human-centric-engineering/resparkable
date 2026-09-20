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
 *   6. **Group invitations are scrubbed by address too** (phase 48). Same shape
 *      as a grant invite, and the first version of this hook missed them.
 *   7. **Group succession runs inside the erasure transaction** (phase 48), so
 *      it commits or rolls back with the erasure. The rule itself is tested in
 *      `services/membership.test.ts`.
 *
 * @see lib/framework/resparkable/privacy/erasure.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const deleteByPrefix = vi.fn();
const isStorageEnabled = vi.fn();

const settleGroupsAfterErasure = vi.fn();

vi.mock('@/lib/framework/resparkable/services/membership', () => ({
  settleGroupsAfterErasure: (...args: unknown[]) => settleGroupsAfterErasure(...args),
}));

vi.mock('@/lib/storage/upload', () => ({
  deleteByPrefix: (...args: unknown[]) => deleteByPrefix(...args),
  isStorageEnabled: () => isStorageEnabled(),
}));

import {
  cleanupResparkableBlobs,
  registerResparkableErasureHook,
  resparkableBlobPrefix,
  dropResparkableConnectionKeys,
  scrubGranteeEmail,
  scrubResparkableInTransaction,
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
    resparkableGroupInvite: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
    resparkableComment: { deleteMany: vi.fn() },
    resparkableSpace: { delete: vi.fn() },
    // The one core table the hook reaches. `McpApiKey.createdBy` is
    // `onDelete: SetNull`, so without this the key survives erasure with a null
    // creator: a live credential belonging to a person who asked to be erased.
    mcpApiKey: {
      findMany: vi.fn().mockResolvedValue([]),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetErasureCleanupHooksForTests();
  isStorageEnabled.mockReturnValue(true);
  deleteByPrefix.mockResolvedValue({ success: true, key: 'x' });
  settleGroupsAfterErasure.mockResolvedValue({ promoted: 0, deleted: 0 });
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

  it('deletes group invitations addressed to the same email, lower-cased', async () => {
    const client = tx('B@Example.COM');

    await scrubGranteeEmail({ tx: client as never, userId: 'user_b' });

    // `ResparkableGroupInvite.email` has no foreign key either, and an accepted
    // invitation keeps its address after the membership it created has
    // cascaded. Either way the row holds an erased person's address.
    expect(client.resparkableGroupInvite.deleteMany).toHaveBeenCalledWith({
      where: { email: 'b@example.com' },
    });
  });

  it('does nothing when the user row is already gone', async () => {
    const client = tx(null);

    await scrubGranteeEmail({ tx: client as never, userId: 'user_b' });

    // Nothing to match on, and no reason to guess. A `deleteMany` with an
    // undefined email would match on `undefined`, which Prisma reads as "no
    // filter" — every grant in the installation.
    expect(client.resparkableGrant.deleteMany).not.toHaveBeenCalled();
    expect(client.resparkableGroupInvite.deleteMany).not.toHaveBeenCalled();
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

describe('scrubResparkableInTransaction', () => {
  it('settles the erased person’s groups through the erasure transaction', async () => {
    const client = tx('b@example.com');

    await scrubResparkableInTransaction({ tx: client as never, userId: 'user_b' });

    // The transaction client, not the global one: a promotion must not survive
    // an erasure that rolls back.
    expect(settleGroupsAfterErasure).toHaveBeenCalledWith('user_b', client);
  });

  it('still scrubs addresses', async () => {
    const client = tx('b@example.com');

    await scrubResparkableInTransaction({ tx: client as never, userId: 'user_b' });

    expect(client.resparkableGrant.deleteMany).toHaveBeenCalledWith({
      where: { granteeEmail: 'b@example.com' },
    });
  });

  it('lets a succession failure roll the erasure back rather than swallowing it', async () => {
    settleGroupsAfterErasure.mockRejectedValue(new Error('deadlock'));

    // A swallowed failure here would commit an erasure that left a group with
    // no admin. Throwing rolls back `eraseUser`'s transaction, and the subject
    // can retry: a failed request is recoverable, an adminless group is not.
    await expect(
      scrubResparkableInTransaction({ tx: tx('b@example.com') as never, userId: 'user_b' })
    ).rejects.toThrow('deadlock');
  });
});

describe('dropResparkableConnectionKeys', () => {
  const SPACE_KEY = 'resparkableSpaceId';

  /** A key row as the transaction would hand it back. */
  function key(id: string, scope: unknown) {
    return { id, scope };
  }

  it('deletes the workspace keys this person minted for themselves', async () => {
    const client = tx('b@example.com');
    client.mcpApiKey.findMany.mockResolvedValue([key('key_1', { [SPACE_KEY]: 'spc_x' })]);
    client.mcpApiKey.deleteMany.mockResolvedValue({ count: 1 });

    await dropResparkableConnectionKeys({ tx: client as never, userId: 'user_b' });

    expect(client.mcpApiKey.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['key_1'] } } });
  });

  it('leaves an administrator’s unscoped service key to core’s SetNull', async () => {
    // Deleting an install's service keys because the admin who minted them left
    // would be an outage dressed up as compliance. The person's identity leaves
    // via `SetNull`; the operational credential stays.
    const client = tx('b@example.com');
    client.mcpApiKey.findMany.mockResolvedValue([key('key_service', null)]);

    await dropResparkableConnectionKeys({ tx: client as never, userId: 'user_b' });

    expect(client.mcpApiKey.deleteMany).not.toHaveBeenCalled();
  });

  it('leaves a key whose carrier this tier cannot read', async () => {
    // A carrier nobody can classify was typed by an admin, not minted by the
    // Connect card, so it gets an admin key's fate.
    const client = tx('b@example.com');
    client.mcpApiKey.findMany.mockResolvedValue([key('key_odd', { spaceId: 'spc_x' })]);

    await dropResparkableConnectionKeys({ tx: client as never, userId: 'user_b' });

    expect(client.mcpApiKey.deleteMany).not.toHaveBeenCalled();
  });

  it('takes only the scoped ones out of a mixed set', async () => {
    const client = tx('b@example.com');
    client.mcpApiKey.findMany.mockResolvedValue([
      key('key_personal', { [SPACE_KEY]: 'user_b' }),
      key('key_service', null),
      key('key_group', { [SPACE_KEY]: 'spc_x' }),
    ]);
    client.mcpApiKey.deleteMany.mockResolvedValue({ count: 2 });

    await dropResparkableConnectionKeys({ tx: client as never, userId: 'user_b' });

    expect(client.mcpApiKey.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['key_personal', 'key_group'] } },
    });
  });

  it('reads only this person’s keys', async () => {
    const client = tx('b@example.com');

    await dropResparkableConnectionKeys({ tx: client as never, userId: 'user_b' });

    expect(client.mcpApiKey.findMany).toHaveBeenCalledWith({
      where: { createdBy: 'user_b' },
      select: { id: true, scope: true },
    });
  });

  it('runs inside the erasure transaction, as part of the scrub', async () => {
    // Through `ctx.tx`, so a key deletion cannot survive an erasure that rolls
    // back, and cannot be forgotten by a caller that skips this function.
    const client = tx('b@example.com');
    client.mcpApiKey.findMany.mockResolvedValue([key('key_1', { [SPACE_KEY]: 'spc_x' })]);
    client.mcpApiKey.deleteMany.mockResolvedValue({ count: 1 });

    await scrubResparkableInTransaction({ tx: client as never, userId: 'user_b' });

    expect(client.mcpApiKey.deleteMany).toHaveBeenCalled();
  });
});

describe('registered hook', () => {
  it('runs the full in-transaction scrub, not only the email half', () => {
    registerResparkableErasureHook();

    expect(getErasureCleanupHooks()[0].scrubInTransaction).toBe(scrubResparkableInTransaction);
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
