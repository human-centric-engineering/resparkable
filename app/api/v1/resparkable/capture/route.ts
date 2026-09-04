/**
 * POST /api/v1/resparkable/capture — the front door.
 *
 * A narrower door than `POST /resparkable/thoughts`, and idempotent where that one
 * is not exposed to be. Everything that captures — the quick-capture box, a
 * share sheet, an iOS Shortcut, inbound email, an agent mid-conversation —
 * comes through here, so every field this endpoint does *not* accept is a field
 * none of them can get wrong.
 *
 * **`externalId` is what makes a retry safe.** A phone on a flaky connection, a
 * redelivered Postmark webhook and a double-tapped Shortcut button all send the
 * same thing twice. With an `externalId` the second one returns the first one's
 * row and reports `deduped: true`, rather than creating a second inbox item or
 * failing with a 409. Losing a captured thought is the one unforgivable failure
 * in this product; quietly duplicating one is the second.
 *
 * Authentication: required.
 */

import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { successResponse } from '@/lib/api/responses';
import { validateRequestBody } from '@/lib/api/validation';
import { withAuth } from '@/lib/auth/guards';
import { captureThought } from '@/lib/framework/resparkable/services/capture';
import { resolveActiveSpaceScope } from '@/lib/framework/resparkable/services/membership';
import { captureSchema } from '@/lib/framework/resparkable/validations';

export const POST = withAuth(async (request, session) => {
  const log = await getRouteLogger(request);

  const { spaceId, ...input } = await validateRequestBody(request, captureSchema);

  // The target comes from the BODY, and this route does not call
  // `requestSpaceScope`: it never reads `?space=`, so a capture cannot inherit
  // the workspace somebody happens to be looking at. Absent means personal.
  // See the schema's own note, and test 13e.
  const scope = await resolveActiveSpaceScope(session.user.id, spaceId ?? null);
  if (!scope) throw new NotFoundError('Workspace not found');

  const { thought, deduped } = await captureThought(scope, input);

  log.info('Resparkable capture', { source: thought.source, deduped, toGroup: Boolean(spaceId) });

  // 200 on a dedupe, 201 on a create — the status says which happened without
  // the caller having to read the body, and a retry that gets 200 is a retry
  // that worked.
  return successResponse({ thought, deduped }, undefined, { status: deduped ? 200 : 201 });
});
