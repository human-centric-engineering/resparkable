/**
 * GET /api/v1/admin/resparkable/billing/accounts: the per-user balance table.
 *
 * Every user of this deployment, balance defaulted to 0 for anyone who has
 * never touched a billing-aware code path yet. See
 * `listCreditAccountsForAdmin`'s doc comment for why this is two queries
 * merged in JS rather than a Prisma relation.
 *
 * Rate limiting: `/api/v1/admin/**` already carries the admin section cap from
 * `proxy.ts`. Nothing to add here.
 */

import { successResponse } from '@/lib/api/responses';
import { validateQueryParams } from '@/lib/api/validation';
import { withAdminAuth } from '@/lib/auth/guards';
import { listCreditAccountsForAdmin } from '@/lib/framework/resparkable/repo/billing';
import { resparkableBillingAccountsQuerySchema } from '@/lib/framework/resparkable/validations';

export const GET = withAdminAuth(async (request) => {
  const { cursor } = validateQueryParams(
    new URL(request.url).searchParams,
    resparkableBillingAccountsQuerySchema
  );

  const accounts = await listCreditAccountsForAdmin({ cursor });

  return successResponse({ accounts });
});
