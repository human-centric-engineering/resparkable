/**
 * The one line a Resparkable route handler writes to know which brain it is in.
 *
 * ## What replaced what
 *
 * Every route in this tier used to open with `spaceScope(session.user.id)`:
 * the session was the brain, so there was nothing to resolve. Phase 46 gave a
 * person more than one brain, and phase 47 gives them a way to say which. So
 * the mint moves out of the routes and behind this call, which reads the
 * target off the URL and turns it into a scope only if membership allows.
 *
 * The greppable trust boundary §23.4 relies on gets **shorter** rather than
 * longer as a result. `rg 'spaceScope\(|spaceScopeFor\('` used to return fifty
 * route files, each one an unaudited chance to mint a scope for the wrong
 * person; it now returns `services/membership.ts` and a short list of
 * background and export paths that have no session to read. That list is meant
 * to stay readable in one screen, and this file is why it can be.
 *
 * ## Not found, never forbidden
 *
 * A space the caller is not in, a pending membership and a space id somebody
 * invented are the same 404. §16.2's rule, unchanged: a 403 tells whoever
 * guessed an id that they guessed right.
 *
 * ## Where the target is not read from
 *
 * Capture. `POST /capture`, the two transcribe routes and the Sparkey capture
 * capability take an explicit target and default to personal, and none of them
 * calls this function. Ambient beats explicit is the wrong precedence for a
 * write that creates a row (§23.4, test 13e).
 *
 * @see .context/framework/resparkable/phase-46-plan.md: phase 47
 */

import { NotFoundError } from '@/lib/api/errors';
import { resolveActiveSpaceScope } from '@/lib/framework/resparkable/services/membership';
import type { SpaceScope } from '@/lib/framework/resparkable/repo/space-scope';
import { readSpaceTarget } from '@/lib/framework/resparkable/ui/active-space';

/**
 * Resolve the request's workspace, or refuse the request.
 *
 * Throws rather than returning `null` because there is exactly one thing every
 * caller would do with the null, and a helper that makes fifty routes each
 * write their own 404 is a helper that will eventually meet a route that
 * writes a 403 instead. `withAuth` turns the throw into the standard envelope.
 *
 * @param request - Any request whose `url` carries the search params. A route
 *   handler's `NextRequest` is one; the type is widened to `Request` so a test
 *   can call this without constructing Next's wrapper.
 * @param actorUserId - **Always** `session.user.id`. Never a body field.
 */
export async function requestSpaceScope(
  request: Request,
  actorUserId: string
): Promise<SpaceScope> {
  const target = readSpaceTarget(new URL(request.url).searchParams);
  const scope = await resolveActiveSpaceScope(actorUserId, target);

  if (!scope) {
    // The message names no space id and does not say "you are not a member",
    // for the reason the status code is 404 in the first place.
    throw new NotFoundError('Workspace not found');
  }

  return scope;
}
