/**
 * `GET /api/v1/resparkable/groups/[id]/audit`: the group's admin record
 * (§23.13, phase 58).
 *
 * An admin gets every entry; any other member gets the entries about them.
 * Not a member, or no such group: the same 404, for §16.2's reason.
 *
 * @see lib/framework/resparkable/services/group-audit.ts
 */

import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { successResponse } from '@/lib/api/responses';
import { withAuth } from '@/lib/auth/guards';
import { listGroupAudit } from '@/lib/framework/resparkable/services/group-audit';

export const GET = withAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const { id } = await params;

  const result = await listGroupAudit(session.user.id, id);
  if (!result.ok) throw new NotFoundError('Group not found');

  log.info('Resparkable group audit list', {
    groupId: id,
    scope: result.scope,
    count: result.entries.length,
  });

  return successResponse(result.entries, { count: result.entries.length, scope: result.scope });
});
