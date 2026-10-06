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
import {
  assertCanWrite,
  resolveActiveSpaceScope,
} from '@/lib/framework/resparkable/services/membership';
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
  actorUserId: string,
  options: RequestSpaceScopeOptions = {}
): Promise<SpaceScope> {
  const target = readSpaceTarget(new URL(request.url).searchParams);
  const scope = await resolveActiveSpaceScope(actorUserId, target);

  if (!scope) {
    // The message names no space id and does not say "you are not a member",
    // for the reason the status code is 404 in the first place.
    throw new NotFoundError('Workspace not found');
  }

  // A viewer reads and writes nothing (§23.3). Asked here because every
  // content route already passes through, so a route added later is covered
  // without its author remembering (phase-58-59-plan.md Decision 1, test 13o).
  const access = options.access ?? (READ_METHODS.has(request.method) ? 'read' : 'write');
  if (access === 'write') assertCanWrite(scope);

  return scope;
}

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface RequestSpaceScopeOptions {
  /**
   * Whether the request changes the space. Inferred from the method when
   * absent: anything but `GET`/`HEAD`/`OPTIONS` is a write, and a viewer is
   * refused it. Pass `'read'` only for a non-`GET` that changes nothing in the
   * space itself, such as marking the feed as seen, which writes the caller's
   * own membership row.
   */
  access?: 'read' | 'write';
}
