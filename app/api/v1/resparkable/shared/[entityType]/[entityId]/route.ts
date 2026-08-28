/**
 * GET /api/v1/resparkable/shared/[entityType]/[entityId] — one shared item.
 *
 * The authenticated mirror of `/api/v1/resparkable/public/[token]`. Same
 * projection, same cascade, different basis — and two differences a reader can
 * see, both of which are the line §13 draws between a link and a grant:
 *
 *   • **The owner is named.** A grantee is in a relationship with a person, so
 *     `ownerIdentity` is not redacted here. A stranger holding a URL gets the
 *     content and learns nothing about whose it is.
 *   • **Comments are open** to a `commenter` grant (phase 13). A link never
 *     carries them.
 *
 * **Resolution happens on this request, not on the list's.** A grant revoked a
 * second ago is a 404 here, because nothing in the access layer caches beyond
 * one request (§16.3). That is the point of paying for a resolve on every read.
 *
 * **The owner gets a 404 from their own item on this route.** `/shared` is the
 * surface for other people's things; serving the owner here would give them a
 * second, differently-redacted view of their own brain and a second set of
 * rules to keep in step with the first.
 *
 * Every failure is the same failure — unknown type, unknown id, no grant,
 * revoked grant, expired grant, deleted item, and the owner's own item all
 * return the same 404. Anything distinguishable is an oracle.
 *
 * Authentication: required.
 */

import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { successResponse } from '@/lib/api/responses';
import { withAuth } from '@/lib/auth/guards';
import { readSharedWithMe } from '@/lib/framework/resparkable/services/shared-with-me';
import { viewerFromSession } from '@/lib/framework/resparkable/api/viewer';

export const GET = withAuth<{ entityType: string; entityId: string }>(
  async (request, session, { params }) => {
    const log = await getRouteLogger(request);
    const { entityType, entityId } = await params;

    // The type is not validated against the shareable list here on purpose. The
    // resolver already denies anything that is not on it, and a 400 for
    // `thought` while `project` returned 404 would tell an unauthenticated
    // guesser which types are shareable and, worse, would separate "wrong type"
    // from "no access" in the response.
    const result = await readSharedWithMe(viewerFromSession(session), { entityType, entityId });
    if (!result) throw new NotFoundError('Not found');

    log.info('Resparkable shared item read', {
      entityType,
      basis: result.access.basis,
      children: result.payload.children.length,
    });

    return successResponse({
      ...result.payload,
      owner: result.owner,
      basis: result.access.basis,
      canComment: result.access.permissions.comment,
      // Names the granted parent when this item was reached through a cascade,
      // so the UI can say "shared as part of Acme Redesign" rather than
      // implying the child was handed over on its own.
      via: result.access.via,
    });
  }
);
