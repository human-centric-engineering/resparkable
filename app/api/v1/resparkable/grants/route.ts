/**
 * GET  /api/v1/resparkable/grants — the grants this owner has issued.
 * POST /api/v1/resparkable/grants — share an item with a named person.
 *
 * The named-grant counterpart of `/share-links`, and the difference between the
 * two is the product's own: **a public link is a document, a named grant is a
 * relationship** (§13). A link hands over content and nothing about the person;
 * a grant hands over the owner's identity too, and — with `role: 'commenter'` —
 * a way to say something back.
 *
 * **POST is an upsert.** Sharing again with the same address on the same item
 * changes the existing grant rather than adding a second one beside it; the
 * database enforces that with `@@unique([entityType, entityId, granteeEmail])`,
 * and the alternative would be a 409 the UI would have to explain.
 *
 * **The response says nothing about whether the address has an account.** §13
 * requires an identical shape either way, or "share with someone" becomes an
 * account-existence oracle anyone can query one address at a time. See
 * `services/grants.ts` for what that rules out of the summary.
 *
 * No email is sent here. The invite (phase 13) is a separate gesture layered on
 * top, so a grant is a database fact before it is a message — a send that fails
 * leaves working access rather than a person told they have access and does not.
 *
 * Authentication: required.
 */

import { getRouteLogger } from '@/lib/api/context';
import { NotFoundError } from '@/lib/api/errors';
import { successResponse } from '@/lib/api/responses';
import { validateQueryParams, validateRequestBody } from '@/lib/api/validation';
import { withAuth } from '@/lib/auth/guards';
import { ownerScope } from '@/lib/framework/resparkable/repo/owner-scope';
import { issueGrant, listOwnGrants } from '@/lib/framework/resparkable/services/grants';
import { createGrantSchema, grantListQuerySchema } from '@/lib/framework/resparkable/validations';

export const GET = withAuth(async (request, session) => {
  const log = await getRouteLogger(request);
  const scope = ownerScope(session.user.id);

  const query = validateQueryParams(new URL(request.url).searchParams, grantListQuerySchema);

  const grants = await listOwnGrants(scope, query);

  log.info('Resparkable grants list', { count: grants.length });

  return successResponse(grants, { count: grants.length });
});

export const POST = withAuth(async (request, session) => {
  const log = await getRouteLogger(request);
  const scope = ownerScope(session.user.id);

  const body = await validateRequestBody(request, createGrantSchema);

  const grant = await issueGrant(scope, body);
  // Not the caller's item, or no such item. 404 rather than 403, for the reason
  // every read in this tier gives: a 403 confirms the row exists to someone who
  // guessed an id.
  if (!grant) throw new NotFoundError('Item not found');

  // No address in the log line. It is one person's contact details sitting in
  // another person's infrastructure for the life of the log.
  log.info('Resparkable grant issued', { entityType: grant.entityType, role: grant.role });

  return successResponse({ grant }, undefined, { status: 201 });
});
