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
 *      function makes `rg 'viewerFromSession\('` the complete list of places
 *      that build one at all.
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

/** The session, and nothing else, expressed as a viewer. */
export function viewerFromSession(session: AuthSession): ResparkableViewer {
  return {
    userId: session.user.id,
    email: session.user.email.toLowerCase(),
  };
}
