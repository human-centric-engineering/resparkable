/**
 * GET /api/v1/resparkable/grants/groups — the groups this workspace can share with.
 *
 * The caller's own joined groups, less the one whose workspace they are in,
 * each with its joined-member count (§23.7, phase 49). The share dialog's
 * group picker reads this, and it is the whole of how a grantor finds a group:
 * there is no directory of groups (§23.11), so sharing with a group means being
 * in it. `POST /grants` enforces the same rule rather than trusting this list.
 *
 * Authentication: required.
 */

import { getRouteLogger } from '@/lib/api/context';
import { successResponse } from '@/lib/api/responses';
import { withAuth } from '@/lib/auth/guards';
import { requestSpaceScope } from '@/lib/framework/resparkable/api/space-request';
import { listGrantTargetGroups } from '@/lib/framework/resparkable/services/grants';

export const GET = withAuth(async (request, session) => {
  const log = await getRouteLogger(request);
  const scope = await requestSpaceScope(request, session.user.id);

  const groups = await listGrantTargetGroups(scope);

  log.info('Resparkable grant target groups', { count: groups.length });

  return successResponse(groups, { count: groups.length });
});
