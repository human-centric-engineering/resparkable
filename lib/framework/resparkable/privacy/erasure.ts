/**
 * Art. 17 — the two things the database cascade structurally cannot do.
 *
 * ## What the cascade already covers, and why that matters here
 *
 * Almost all of Resparkable's erasure is Postgres, not code. `ResparkableSpace`
 * holds one hand-written `ON DELETE CASCADE` into `"user"` (probe **B1**) and
 * every satellite table hangs off it, so erasing a person takes their whole
 * brain with them with nothing to remember and nothing to skip. The two
 * *cross-person* cases — a grant naming somebody else's mailbox, a comment
 * somebody else wrote — have their own hand-written FKs on `granteeUserId` and
 * `authorUserId` (probes **B8** and **B9**), so the damaging half of "erase the
 * person on the other end" is also enforced by the database.
 *
 * That is worth stating before anything below, because this file is
 * **best-effort by construction** and the reader should know how much of Art. 17
 * is not riding on it.
 *
 * ## The residue, which is what this file is for
 *
 * 1. **Unaccepted invites.** A grant issued to an address whose owner had no
 *    account has `granteeUserId: null`, so there is no foreign key to hang off.
 *    If that person later signs up and is then erased, their address stays on
 *    somebody else's row: retained personal data belonging to an erased person,
 *    on a row they cannot reach. That is the Art. 17 violation §13 names, and
 *    {@link scrubGranteeEmail} is the whole of the fix.
 * 2. **Stored document originals.** Object storage cannot enlist in a database
 *    transaction, so blobs under `framework-resparkable/<userId>/` need deleting
 *    by hand. `ResparkableDocument` rows cascade; the bytes do not.
 *
 * ## The registration hazard, stated plainly
 *
 * `lib/privacy/erasure-hooks.ts` is a **plain module-scoped `Map`** with no
 * lazy re-init, and `eraseUser()` runs in the route realm. Under Next 16 +
 * Turbopack, `instrumentation.ts` is a separate module graph (sunrise#462), so a
 * hook registered at boot **may not be present when erasure actually runs**.
 * #462 fixed exactly this for the context-contributor and capability registries
 * by making them `globalThis`-backed; the erasure registry was not part of that
 * change and there is no point in the erasure route's import graph a fork can
 * reach. Filed as ask #34.
 *
 * So: register at boot, and be honest that this is a belt over braces rather
 * than the braces. The braces are B1, B8 and B9, which are database
 * constraints and cannot fail to run.
 *
 * ## What must NOT be done here
 *
 * **Never `prisma.user.delete()`, and never a second cascade.** This hook runs
 * *inside* `eraseUser`'s transaction and *before* its own delete. Deleting rows
 * the cascade will delete anyway is not merely redundant — it is a second
 * definition of what erasure means, and the two drift.
 */

import { logger } from '@/lib/logging';
import {
  registerErasureCleanupHook,
  type ErasureExternalContext,
  type ErasureTxContext,
} from '@/lib/privacy/erasure-hooks';

/**
 * The object-storage prefix every Resparkable blob for one person sits under.
 *
 * Matches `retainOriginal` in `documents/ingest.ts`, which is the only thing in
 * the tier that writes a blob today. §13 also names
 * `resparkable-vaults/<userId>/` and `resparkable-vault-snapshots/<userId>/` —
 * **those do not exist**, and adding a delete for them would be code that
 * cannot be tested against anything. The one-time vault export streams a zip
 * and persists nothing; the Managed transport that would store vault state
 * server-side is Release 3 phase 17 and is on hold. Add the prefixes when the
 * blobs do, not before.
 */
export function resparkableBlobPrefix(userId: string): string {
  return `framework-resparkable/${userId}/`;
}

/**
 * Delete the erased person's stored document originals.
 *
 * Runs **before** the erasure transaction and best-effort: a throw here is
 * logged and swallowed by `eraseUser`, which is right. Object storage being
 * unreachable must not stop a person's account being deleted — the alternative
 * is an erasure request that fails because a bucket is down, which is worse for
 * the subject than a blob that outlives its row by a day.
 *
 * A storage provider that is not configured at all is not a failure: the
 * deployment stores no originals, so there is nothing to remove.
 */
export async function cleanupResparkableBlobs(ctx: ErasureExternalContext): Promise<void> {
  const { deleteByPrefix, isStorageEnabled } = await import('@/lib/storage/upload');
  if (!isStorageEnabled()) return;

  const prefix = resparkableBlobPrefix(ctx.userId);
  const result = await deleteByPrefix(prefix);

  logger.info('Resparkable blobs removed for erased user', {
    userId: ctx.userId,
    succeeded: result.success,
  });
}

/**
 * Delete grants addressed to the erased person's **email**.
 *
 * The half `granteeUserId`'s foreign key cannot reach: an unaccepted invite has
 * no id to cascade from, only an address.
 *
 * ## Why the email is read from the transaction rather than passed in
 *
 * `ErasureTxContext` carries only `userId`. Reading the address here works
 * because hooks run **before** `user.delete()` — the row is still there. Doing
 * it any other way would mean core threading an email through a context shape
 * that deliberately holds an id, and the id is the thing that cannot go stale.
 *
 * ## Why this deletes rather than nulls
 *
 * There is nothing to retain. A grant is a permission, not a record of
 * something that happened: the *owner's* audit answer to "who did I share with"
 * is legitimate, but it cannot be legitimate at the cost of holding an erased
 * person's address indefinitely on a row they can no longer see or revoke. §13
 * decided this; the same reasoning made `granteeUserId` CASCADE rather than
 * `SET NULL`.
 *
 * ## Why the address is lower-cased here too
 *
 * `granteeEmail` is stored lower-cased at the boundary, and a `User.email` is
 * whatever the account was created with. Matching them raw would leave the row
 * of anybody who signed up with a capital letter — which is the quietest
 * possible way for this to not work.
 */
export async function scrubGranteeEmail(ctx: ErasureTxContext): Promise<void> {
  const user = await ctx.tx.user.findUnique({
    where: { id: ctx.userId },
    select: { email: true },
  });
  // Already gone, or never there. Nothing to match on, and no reason to guess.
  if (!user) return;

  const email = user.email.toLowerCase();

  // Comments are NOT scrubbed here: `authorUserId` is a hand-written CASCADE
  // (probe B9), so `user.delete()` removes every comment this person wrote a
  // moment after this hook returns. Deleting them here as well would be a
  // second definition of what erasure means.
  const grants = await ctx.tx.resparkableGrant.deleteMany({ where: { granteeEmail: email } });

  logger.info('Resparkable grantee-email scrub', {
    userId: ctx.userId,
    grantsRemoved: grants.count,
  });
}

/**
 * Register the tier's erasure hook.
 *
 * Idempotent by name, so calling it twice replaces rather than duplicates —
 * which matters because Next re-evaluates modules on hot reload.
 *
 * One hook with both phases rather than two hooks, because they are one
 * decision about one person and splitting them would let a future edit remove
 * half of it without the other half looking wrong.
 */
export function registerResparkableErasureHook(): void {
  registerErasureCleanupHook({
    name: 'resparkable',
    cleanupExternal: cleanupResparkableBlobs,
    scrubInTransaction: scrubGranteeEmail,
  });
}
