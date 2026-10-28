/**
 * Admin Orchestration — Per-org usage (§110 t-790)
 *
 * GET /api/v1/admin/orchestration/costs/orgs
 *
 * Each org's AI spend, calls and tokens for one UTC calendar month, beside
 * its `quotas.monthlyBudgetUsd` cap, plus a bucket for rows with no org (an
 * erased org's detached spend). The usage data a fork's plans and invoices
 * are built from; those stay the fork's. See `getOrgUsage`.
 *
 * Query params (validated by `orgUsageQuerySchema`):
 *   period? – `YYYY-MM`, UTC; defaults to the current month
 *   orgId?  – narrow the answer to one org (the org detail page)
 *
 * **Install org only at `multi`.** The answer includes every tenant's spend,
 * so an admin switched into a customer's org is refused with a 403 — the rule
 * an org's caps are written under (`PATCH /api/v1/admin/orgs/[id]`), and for
 * the same reason: what one tenant may see of another. An unbound admin API
 * key, which enters no org and acts as the install org, is allowed. At
 * `single` the one org is the install org, and the answer is its one row.
 *
 * Authentication: Admin role required. Rate limiting is enforced centrally
 * by `proxy.ts` via the policy table at `lib/security/rate-limit-policy.ts`.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { APIError, ErrorCodes } from '@/lib/api/errors';
import { successResponse } from '@/lib/api/responses';
import { validateQueryParams } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { orgUsageQuerySchema } from '@/lib/validations/orchestration';
import { getOrgUsage } from '@/lib/orchestration/llm/cost-reports';
import { getTenantContext } from '@/lib/tenancy/context';
import {
  canChangeSharedSettings,
  SHARED_SETTINGS_REFUSAL_CODE,
} from '@/lib/tenancy/shared-settings';

/** The words an admin sees when a customer org's context asks for every org's usage. */
const USAGE_REFUSAL =
  "Every organisation's usage can only be viewed from the install organisation. Switch to the install organisation to see it.";

/** The current UTC month, `YYYY-MM`. */
function currentPeriod(): string {
  return new Date().toISOString().slice(0, 7);
}

export const GET = withAdminAuth(async (request, session) => {
  const log = await getRouteLogger(request);

  if (session.principal.credential !== 'api-key' && !canChangeSharedSettings()) {
    log.warn('tenancy: refused the per-org usage read outside the install org', {
      actorUserId: session.user.id,
      activeOrgId: getTenantContext()?.orgId ?? null,
    });
    throw new APIError(USAGE_REFUSAL, ErrorCodes.FORBIDDEN, 403, {
      reason: SHARED_SETTINGS_REFUSAL_CODE,
    });
  }

  const { searchParams } = new URL(request.url);
  const params = validateQueryParams(searchParams, orgUsageQuerySchema);

  const report = await getOrgUsage({
    period: params.period ?? currentPeriod(),
    ...(params.orgId ? { orgId: params.orgId } : {}),
  });

  log.info('Per-org usage fetched', {
    period: report.period,
    orgCount: report.orgs.length,
    totalCostUsd: report.totals.totalCostUsd,
  });

  return successResponse(report);
});
