/**
 * Building a `ResparkableViewer` from a session, in exactly one place.
 *
 * ## Why this is a module and not two lines at each call site
 *
 * A viewer is the input to every cross-user read in the tier, and there are
 * exactly two ways to get one wrong. Both are one careless line, and neither
 * fails any test:
 *
 *   1. **Taking the identity from the request** rather than the session. A
 *      `granteeEmail` in a body, a `userId` in a query string, an address the
 *      client "already knows" — any of them turns the access layer into a
 *      lookup service for other people's brains. There is no route in this tier
 *      that should build a viewer from anything but a session, and having one
 *      function makes `rg 'viewerFor\('` the list of places that build
 *      one — with two deliberate exceptions: `invites/accept` and
 *      `groups/invites/accept` build their own `{ userId, email,
 *      emailVerified }` from `accountAddress`, because accepting requires an
 *      address and a `ResparkableViewer` allows it to be null. It is not a
 *      viewer and is not passed anywhere that takes one; `acceptInvite` and
 *      `acceptGroupInvite` apply the same address rule themselves.
 *   2. **Forgetting to lower-case the address.** A grant is addressed by email
 *      until it is accepted, and `granteeClauses` in `access/store.ts` matches
 *      the lower-cased form. A session carrying `Bob@Example.com` against a
 *      grant stored as `bob@example.com` produces a viewer who silently holds
 *      none of the grants issued to them — a failure that looks like "sharing is
 *      broken for some people" and is very hard to see in a test written with
 *      lower-case fixtures.
 *
 * Both are the sort of thing that stays correct as long as nobody adds a
 * fourteenth route in a hurry, which is not a guarantee.
 *
 * **`email` is taken even when `userId` is present.** They are not redundant:
 * the id matches grants that have been accepted or issued to an existing
 * account, and the address matches grants issued to a mailbox before its owner
 * ever signed in. A viewer built from the id alone would drop every unaccepted
 * invite, which is most of them on the day they are sent.
 *
 * **But only a verified one.** `matchableAddress` gives `null` for an account
 * that has not proven it owns its address, so such a viewer holds only the
 * grants bound to its id. Without that, anybody who opened an account under
 * another person's address on a deploy with verification off would read
 * everything shared with them (`privacy/address.ts`).
 */

import type { AuthSession } from '@/lib/auth/guards';
import type { ResparkableViewer } from '@/lib/framework/resparkable/access/types';
import { matchableAddress } from '@/lib/framework/resparkable/privacy/address';
import { readAddressOwner } from '@/lib/framework/resparkable/repo/grants';
import type { SpaceScope } from '@/lib/framework/resparkable/repo/space-scope';
import { permissionsFor } from '@/lib/framework/resparkable/services/membership';

/**
 * The session, and the workspace membership resolved for it, as a viewer.
 *
 * **The workspace comes from a `SpaceScope`, never from the request.** Phase 49
 * made the workspace part of the answer to "what has been shared with me", and
 * the only safe source for it is the scope `requestSpaceScope()` minted, which
 * has already checked that this person is a joined member. A group id read
 * straight off the URL would let anybody who learned one read what was shared
 * with that group.
 *
 * A personal scope's space key IS the session's user id (`createSpace`), which
 * is how the personal case is told apart. Only the personal case reads the
 * address (`accountAddress`, one query): inside a group the group is the
 * grantee and `granteeClauses` never looks at `email`, so a group viewer
 * carries none.
 */
export async function viewerFor(
  session: AuthSession,
  scope: SpaceScope
): Promise<ResparkableViewer> {
  const personal = scope.spaceId === session.user.id;
  return {
    userId: session.user.id,
    email: personal ? matchableAddress(await accountAddress(session)) : null,
    group: personal
      ? null
      : {
          spaceId: scope.spaceId,
          canWrite: permissionsFor(scope.role).write,
          canAdminister: permissionsFor(scope.role).administer,
        },
  };
}

/**
 * The session account's address and whether it has verified it, read
 * together from the `user` row.
 *
 * Not from the session. better-auth caches it for five minutes
 * (`lib/auth/config.ts`), and both fields can move in that time: a person who
 * confirms on their phone would be refused on their laptop, an admin can
 * un-verify an account, and an account can change its address. The two are
 * read as a pair because a fresh flag beside a cached address would vouch for
 * an address the account no longer holds, letting it match, and accept, what
 * was sent to that address's owner.
 *
 * An account deleted mid-session has no address and is verified for nothing.
 */
export async function accountAddress(
  session: AuthSession
): Promise<{ email: string; emailVerified: boolean }> {
  const row = await readAddressOwner(session.user.id);
  return { email: row?.email ?? '', emailVerified: row?.emailVerified ?? false };
}
