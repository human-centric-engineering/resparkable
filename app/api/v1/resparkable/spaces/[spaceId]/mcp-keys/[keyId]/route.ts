/**
 * Resparkable — revoke your own MCP key
 *
 * DELETE /api/v1/resparkable/spaces/:spaceId/mcp-keys/:keyId
 *
 * Deletes the row rather than deactivating it. A person revoking their own
 * credential wants it gone, and they have no admin surface on which a
 * deactivated row would mean anything: leaving one would be retaining a record
 * they cannot read. An administrator's revocation is kept, for the opposite
 * reason; `mcp/keys.ts` spells out both halves.
 *
 * A key that is not the caller's own, live, and scoped to this workspace is
 * `Key not found`. So is a key an admin revoked a moment ago, which is what
 * sends the card back to offering Generate.
 *
 * **A browser session, like mint and rotate.** An earlier draft of this route
 * allowed an API-key session here, reasoning that revoking makes no credential
 * and that tooling which spots a compromised key should be able to retire it.
 * That was wrong, and core's own `DELETE /api/v1/user/api-keys/:keyId` says why
 * in a comment written for exactly this mistake: guarding minting and leaving
 * revocation open is half a rule, a narrowly-scoped key could list its owner's
 * keys and destroy every one of them, and "a rule that holds on one verb is the
 * kind nobody remembers". The tooling argument does not survive either, for the
 * reason core gives: a rotate-and-revoke script needs the rotate too, and that
 * already requires a browser.
 *
 * Authentication: required, and a browser session specifically.
 */

import { getRouteLogger } from '@/lib/api/context';
import { successResponse } from '@/lib/api/responses';
import { withAuth } from '@/lib/auth/guards';
import { revokeConnectionKey } from '@/lib/framework/resparkable/mcp/keys';
import {
  refuseConnectionKey,
  requireBrowserSession,
  requireConnectionSpace,
} from '@/lib/framework/resparkable/mcp/route-support';
import { getClientIP } from '@/lib/security/ip';

export const DELETE = withAuth<{ spaceId: string; keyId: string }>(
  async (request, session, { params }) => {
    await requireBrowserSession(request, session, 'Revoking');

    const log = await getRouteLogger(request);
    const { spaceId, keyId } = await params;

    const scope = await requireConnectionSpace(session.user.id, spaceId);

    const result = await revokeConnectionKey(scope, keyId, { clientIp: getClientIP(request) });
    if (!result.ok) refuseConnectionKey(result.reason);

    log.info('Resparkable connection key revoked', {
      spaceId: scope.spaceId,
      keyId: result.value.id,
    });

    return successResponse({ id: result.value.id, revoked: true });
  }
);
