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
 *      one — with a single deliberate exception: `invites/accept` constructs its
 *      own `{ userId, email }`, because accepting requires **both** to be
 *      present and a `ResparkableViewer` allows either to be null. It is not a
 *      viewer and is not passed anywhere that takes one; `acceptInvite`
 *      lower-cases the address itself.
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
 */

import type { AuthSession } from '@/lib/auth/guards';
import type { ResparkableViewer } from '@/lib/framework/resparkable/access/types';
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
 * is how the personal case is told apart without a second query.
 */
export function viewerFor(session: AuthSession, scope: SpaceScope): ResparkableViewer {
  const personal = scope.spaceId === session.user.id;
  return {
    userId: session.user.id,
    email: session.user.email.toLowerCase(),
    group: personal ? null : { spaceId: scope.spaceId, canWrite: permissionsFor(scope.role).write },
  };
}
