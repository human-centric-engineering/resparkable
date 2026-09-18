/**
 * DELETE /api/v1/resparkable/share-links/[id] — revoke a public link.
 *
 * Revocation is immediate and permanent: the row keeps its history (when it was
 * made, how often it was opened) and stops resolving on the very next request.
 * There is no un-revoke — re-sharing mints a new token, because a link that
 * could come back to life is a link whose owner cannot be sure it is off.
 *
 * Idempotent: revoking an already-revoked link succeeds and changes nothing. A
 * double-clicked button is not a failure worth reporting.
 *
 * If this was the last live link on the item, the item's `visibility` flips
 * back to `'private'` in the same transaction — see `repo/share-links.ts` for
 * why the count is taken inside it.
 *
 * Authentication: required.
 */

import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { successResponse } from '@/lib/api/responses';
import { withAuth } from '@/lib/auth/guards';
import { revokeShareLink } from '@/lib/framework/resparkable/services/sharing';

export const DELETE = withAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const scope = await requestSpaceScope(request, session.user.id);
  const { id } = await params;

  const revoked = await revokeShareLink(scope, id);
  if (!revoked) throw new NotFoundError('Share link not found');

  log.info('Resparkable share link revoked', { id, entityType: revoked.entityType });

  return successResponse({ id: revoked.id, revokedAt: revoked.revokedAt });
});
import { requestSpaceScope } from '@/lib/framework/resparkable/api/space-request';
