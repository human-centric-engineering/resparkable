/**
 * GET  /api/v1/resparkable/share-links — the owner's own public links.
 * POST /api/v1/resparkable/share-links — mint one.
 *
 * **The POST response is the only time the token exists outside a hash.**
 * `mintShareLink` generates it, stores the sha256 digest and hands the
 * plaintext back once; nothing in the system can produce it again. The list
 * endpoint returns `tokenPrefix` and never the token or the digest, so the UI
 * has to say "copy this now" and mean it. A lost link is re-minted, not
 * recovered.
 *
 * Minting flips the item's `visibility` to `'link'` and revoking the last live
 * link flips it back — both inside the same transaction as the link write, so
 * the badge cannot disagree with reality (`repo/share-links.ts`).
 *
 * Authentication: required. This is the owner's side of sharing; the reader's
 * side is `/api/v1/resparkable/public/[token]`, which has no session at all.
 */

import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { successResponse } from '@/lib/api/responses';
import { validateQueryParams, validateRequestBody } from '@/lib/api/validation';
import { withAuth } from '@/lib/auth/guards';
import { listOwnShareLinks, mintShareLink } from '@/lib/framework/resparkable/services/sharing';
import {
  createShareLinkSchema,
  shareLinkListQuerySchema,
} from '@/lib/framework/resparkable/validations';

export const GET = withAuth(async (request, session) => {
  const log = await getRouteLogger(request);
  const scope = await requestSpaceScope(request, session.user.id);

  const query = validateQueryParams(new URL(request.url).searchParams, shareLinkListQuerySchema);

  const links = await listOwnShareLinks(scope, query);

  log.info('Resparkable share links list', { count: links.length });

  return successResponse(links, { count: links.length });
});

export const POST = withAuth(async (request, session) => {
  const log = await getRouteLogger(request);
  const scope = await requestSpaceScope(request, session.user.id);

  const body = await validateRequestBody(request, createShareLinkSchema);

  const minted = await mintShareLink(scope, body);
  // Not the caller's item, or no such item. 404 rather than 403: a 403 would
  // confirm the row exists, which is the same enumeration vector every other
  // route in this tier declines to offer.
  if (!minted) throw new NotFoundError('Item not found');

  log.info('Resparkable share link created', { entityType: body.entityType });

  return successResponse(
    {
      link: {
        id: minted.link.id,
        entityType: minted.link.entityType,
        entityId: minted.link.entityId,
        tokenPrefix: minted.link.tokenPrefix,
        includeChildren: minted.link.includeChildren,
        includeTaskDetail: minted.link.includeTaskDetail,
        expiresAt: minted.link.expiresAt,
        createdAt: minted.link.createdAt,
      },
      // Shown once. The client must copy it now; there is no second chance,
      // deliberately.
      token: minted.token,
      path: `/s/${minted.token}`,
    },
    undefined,
    { status: 201 }
  );
});
import { requestSpaceScope } from '@/lib/framework/resparkable/api/space-request';
