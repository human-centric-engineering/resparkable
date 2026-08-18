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
import { withAdminAuth } from '@/lib/auth/guards';
import { listCreditAccountsForAdmin } from '@/lib/framework/resparkable/repo/billing';

export const GET = withAdminAuth(async (request) => {
  const url = new URL(request.url);
  const cursor = url.searchParams.get('cursor') ?? undefined;

  const accounts = await listCreditAccountsForAdmin({ cursor });

  return successResponse({ accounts });
});
