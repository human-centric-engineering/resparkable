/**
 * POST /api/v1/admin/resparkable/billing/grants: grant (or deduct) credits.
 *
 * `amount` may be negative (a correction), but not zero; see the Zod schema.
 * Creates the target user's credit account first if it doesn't exist yet, so
 * granting a brand-new user works on the first try — which requires their
 * `ResparkableSpace` to already exist too, since the credit account's FK
 * targets that row, not `User` directly (see `ensureResparkableSpace`'s doc
 * comment). A user who has never opened Resparkable has neither yet, so this
 * route bootstraps the space before creating the account, rather than
 * surfacing a raw FK-violation 500 for exactly the "grant a brand-new user"
 * case the account-creation already claims to handle.
 *
 * Rate limiting: `/api/v1/admin/**` already carries the admin section cap from
 * `proxy.ts`. Nothing to add here: this is a cheap DB write with no provider
 * call, the same shape as the existing settings PATCH.
 */

import { getRouteLogger } from '@/lib/api/context';
import { successResponse } from '@/lib/api/responses';
import { validateRequestBody } from '@/lib/api/validation';
import { withAdminAuth } from '@/lib/auth/guards';
import { grantCreditsAsAdmin } from '@/lib/framework/resparkable/repo/billing';
import { ensureResparkableSpace } from '@/lib/framework/resparkable/services/space';
import { resparkableCreditGrantSchema } from '@/lib/framework/resparkable/validations';

export const POST = withAdminAuth(async (request, session) => {
  const log = await getRouteLogger(request);

  const body = await validateRequestBody(request, resparkableCreditGrantSchema);

  await ensureResparkableSpace(body.userId);
  const entry = await grantCreditsAsAdmin(body.userId, body.amount, body.note, session.user.id);

  log.info('Resparkable admin credit grant recorded', {
    targetUserId: body.userId,
    amount: body.amount,
  });

  return successResponse({ entry });
});
