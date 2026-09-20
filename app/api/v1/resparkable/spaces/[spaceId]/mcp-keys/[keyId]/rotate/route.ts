/**
 * Resparkable — regenerate your own MCP key
 *
 * POST /api/v1/resparkable/spaces/:spaceId/mcp-keys/:keyId/rotate
 *
 * Fresh secret material on the same row. The previous key stops working the
 * moment this returns, and the new plaintext is in the response body and
 * nowhere else, ever again.
 *
 * **Regenerating does not reactivate a deactivated key and does not clear an
 * expiry.** Either would let a person undo an administrator's decision from
 * their own settings page. A key an admin revoked is `Key not found` here, so
 * the card offers Generate instead and a new row is minted beside the old one.
 *
 * Takes no body, for the same reason the mint route does not: there is nothing
 * about a key for its holder to choose.
 *
 * Authentication: required, and a browser session specifically.
 */

import { getRouteLogger } from '@/lib/api/context';
import { successResponse } from '@/lib/api/responses';
import { withAuth } from '@/lib/auth/guards';
import { rotateConnectionKey } from '@/lib/framework/resparkable/mcp/keys';
import {
  refuseConnectionKey,
  requireBrowserSession,
  requireConnectionSpace,
} from '@/lib/framework/resparkable/mcp/route-support';
import { getClientIP } from '@/lib/security/ip';

export const POST = withAuth<{ spaceId: string; keyId: string }>(
  async (request, session, { params }) => {
    await requireBrowserSession(request, session, 'Regenerating');

    const log = await getRouteLogger(request);
    const { spaceId, keyId } = await params;

    const scope = await requireConnectionSpace(session.user.id, spaceId);

    const result = await rotateConnectionKey(scope, keyId, { clientIp: getClientIP(request) });
    if (!result.ok) refuseConnectionKey(result.reason);

    log.info('Resparkable connection key regenerated', {
      spaceId: scope.spaceId,
      keyId: result.value.id,
      keyPrefix: result.value.keyPrefix,
    });

    return successResponse(result.value);
  }
);
