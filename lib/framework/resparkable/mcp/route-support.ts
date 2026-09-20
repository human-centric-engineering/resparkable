/**
 * The three things all four connection-key routes have to agree about.
 *
 * A lib module rather than shared exports from a `route.ts`, because Next
 * type-checks a route file's exports and an extra one is a build error. It is
 * also the better home: three files inlining the same refusal table is three
 * places for one of them to answer 403 where the others answer 404.
 */

import { getRouteLogger } from '@/lib/api/context';
import { ConflictError, ForbiddenError, NotFoundError } from '@/lib/api/errors';
import { isApiKeySession } from '@/lib/auth/api-keys';
import type { ConnectionKeyRefusal } from '@/lib/framework/resparkable/mcp/keys';
import type { SpaceScope } from '@/lib/framework/resparkable/repo/space-scope';
import { resolveActiveSpaceScope } from '@/lib/framework/resparkable/services/membership';
import type { AuthSession } from '@/lib/auth/guards';

/**
 * One refusal vocabulary, one place it becomes a status code.
 *
 * `server_disabled` is a **409 rather than a 503**: nothing is broken and the
 * caller's authority is fine, the install is simply in a state where this is
 * not available, and the answer is "ask an administrator" rather than "try
 * again in a minute". Same shape, and the same reasoning, as the last-admin
 * refusal on groups.
 *
 * `no_such_key` covers every kind of miss there is: another person's key, an
 * admin's unscoped service key, a key for a different workspace, a key an
 * admin has revoked. One answer, so the route confirms nothing about keys that
 * are not the caller's.
 */
export function refuseConnectionKey(reason: ConnectionKeyRefusal): never {
  switch (reason) {
    case 'server_disabled':
      throw new ConflictError(
        'The MCP server is switched off for this install. An administrator has to turn it on before a key will connect.'
      );
    case 'already_exists':
      throw new ConflictError(
        'You already have a key for this workspace. Regenerate it, or revoke it and make a new one.'
      );
    case 'no_such_key':
      throw new NotFoundError('Key not found');
  }
}

/**
 * The workspace named by the path segment, or a 404.
 *
 * **404 rather than 403**, because a 403 tells whoever guessed an id that they
 * guessed right. `resolveActiveSpaceScope` answers `null` alike for a workspace
 * that does not exist, one the caller has left, and one they have only asked to
 * join, and the message names none of those. The wording matches
 * `requestSpaceScope`, the `?space=` equivalent, so the two surfaces cannot
 * start disagreeing about what a missing workspace sounds like.
 */
export async function requireConnectionSpace(
  actorUserId: string,
  spaceId: string
): Promise<SpaceScope> {
  const scope = await resolveActiveSpaceScope(actorUserId, spaceId);
  if (!scope) throw new NotFoundError('Workspace not found');
  return scope;
}

/**
 * Refuse a credential-authenticated caller on the verbs that make key material.
 *
 * Minting a credential over a credential is privilege laundering: an API key
 * reaching this route could mint an MCP key acting as its owner, and the narrow
 * scope the API key was issued with would then bound nothing. Rotation is the
 * same act with an extra step, so it is refused too.
 *
 * Same refusal, and the same reasoning, as `POST /api/v1/user/api-keys`. The
 * read is deliberately not refused: listing your own key prefixes escalates
 * nothing.
 *
 * @param verb Used in the message, so the caller is told which act was refused
 *   rather than being left to guess ("Creating", "Regenerating").
 */
export async function requireBrowserSession(
  request: Request,
  session: AuthSession,
  verb: string
): Promise<void> {
  if (!isApiKeySession(session)) return;

  const log = await getRouteLogger(request);
  log.warn('Rejected API-key attempt to make MCP connection key material', {
    userId: session.user.id,
    verb,
  });
  throw new ForbiddenError(`${verb} a key requires a browser session`);
}
