/**
 * PATCH  /api/v1/resparkable/grants/[id] — change a grant's role, detail or expiry.
 * DELETE /api/v1/resparkable/grants/[id] — revoke it.
 *
 * **`granteeEmail` cannot be patched.** Re-addressing a grant is not an edit; it
 * is a revoke plus a new grant to a different person. Allowing it here would let
 * one request move access between mailboxes while the row's history said nothing
 * had happened.
 *
 * **Revocation takes effect on the grantee's next request.** The access layer
 * caches nothing beyond one request, which is what makes that sentence a
 * property of the system rather than a hope (§16.3).
 *
 * Unlike the share-link DELETE, this one is **not** idempotent: revoking an
 * already-revoked grant is a 404. The two differ because their rows differ — a
 * link's revocation is terminal, whereas a grant can be reinstated by sharing
 * again, so a second revoke that silently succeeded would be indistinguishable
 * from revoking a grant somebody had re-issued in between.
 *
 * Authentication: required.
 */

import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { successResponse } from '@/lib/api/responses';
import { validateRequestBody } from '@/lib/api/validation';
import { withAuth } from '@/lib/auth/guards';
import { revokeGrant, updateGrant } from '@/lib/framework/resparkable/services/grants';
import { updateGrantSchema } from '@/lib/framework/resparkable/validations';

export const PATCH = withAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const scope = await requestSpaceScope(request, session.user.id);
  const { id } = await params;

  const body = await validateRequestBody(request, updateGrantSchema);

  const grant = await updateGrant(scope, id, body);
  if (!grant) throw new NotFoundError('Grant not found');

  log.info('Resparkable grant updated', { id, role: grant.role });

  return successResponse({ grant });
});

export const DELETE = withAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const scope = await requestSpaceScope(request, session.user.id);
  const { id } = await params;

  const grant = await revokeGrant(scope, id);
  if (!grant) throw new NotFoundError('Grant not found');

  log.info('Resparkable grant revoked', { id, entityType: grant.entityType });

  return successResponse({ id: grant.id, revokedAt: grant.revokedAt });
});
import { requestSpaceScope } from '@/lib/framework/resparkable/api/space-request';
