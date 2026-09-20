/**
 * Resparkable — a person's own MCP key for one workspace
 *
 * GET  /api/v1/resparkable/spaces/:spaceId/mcp-keys — your live keys for it, and whether the server is on
 * POST /api/v1/resparkable/spaces/:spaceId/mcp-keys — generate one (no body; the plaintext is returned once)
 *
 * Until this route existed, a person could not get an MCP key at all: minting
 * lived behind `withAdminAuth`, and since a key acts as its creator, an admin
 * had to sign in as you to connect your assistant.
 *
 * The workspace comes from the path and is resolved through membership, so a
 * workspace the caller is not in is 404. Everything a key carries is decided by
 * `mcp/keys.ts`; these handlers resolve a workspace, refuse a
 * credential-authenticated session, and turn a refusal into a status code.
 *
 * Rate limiting is the section cap `proxy.ts` applies to `/api/v1/**`, with no
 * per-flow sub-cap on purpose: one live key per person per workspace is a far
 * tighter bound than a limiter would be.
 *
 * Authentication: required, and a browser session specifically for POST.
 */

import { getRouteLogger } from '@/lib/api/context';
import { successResponse } from '@/lib/api/responses';
import { withAuth } from '@/lib/auth/guards';
import { mintConnectionKey, readConnectionKeys } from '@/lib/framework/resparkable/mcp/keys';
import {
  refuseConnectionKey,
  requireBrowserSession,
  requireConnectionSpace,
} from '@/lib/framework/resparkable/mcp/route-support';
import { getClientIP } from '@/lib/security/ip';

export const GET = withAuth<{ spaceId: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const { spaceId } = await params;

  const scope = await requireConnectionSpace(session.user.id, spaceId);
  const view = await readConnectionKeys(scope);

  log.info('Resparkable connection keys listed', {
    spaceId: scope.spaceId,
    count: view.keys.length,
    serverEnabled: view.serverEnabled,
  });

  return successResponse(view);
});

export const POST = withAuth<{ spaceId: string }>(async (request, session, { params }) => {
  await requireBrowserSession(request, session, 'Creating');

  const log = await getRouteLogger(request);
  const { spaceId } = await params;
  const scope = await requireConnectionSpace(session.user.id, spaceId);

  // No body is read, at all. Every field on the row is forced or derived, and
  // that is the whole reason a self-service credential surface is safe.
  const result = await mintConnectionKey(scope, {
    personName: session.user.name,
    clientIp: getClientIP(request),
  });
  if (!result.ok) refuseConnectionKey(result.reason);

  // The prefix, never the plaintext. The secret is in the response body and
  // nowhere else in the system, ever again.
  log.info('Resparkable connection key created', {
    spaceId: scope.spaceId,
    keyId: result.value.id,
    keyPrefix: result.value.keyPrefix,
  });

  return successResponse(result.value, undefined, { status: 201 });
});
