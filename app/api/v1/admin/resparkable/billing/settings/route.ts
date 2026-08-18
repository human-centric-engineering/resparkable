/**
 * GET   /api/v1/admin/resparkable/billing/settings: read the global billing policy
 * PATCH /api/v1/admin/resparkable/billing/settings: update it
 *
 * Same shape as `/api/v1/admin/resparkable/settings` (`ResparkableSettings`):
 * admin-guarded, singleton-backed, resolved defaults on `GET`. See
 * `.context/framework/resparkable/phase-29-plan.md`.
 *
 * Rate limiting: `/api/v1/admin/**` already carries the admin section cap from
 * `proxy.ts`. Nothing to add here.
 */

import { getRouteLogger } from '@/lib/api/context';
import { successResponse } from '@/lib/api/responses';
import { validateRequestBody } from '@/lib/api/validation';
import { withAdminAuth } from '@/lib/auth/guards';
import {
  findResparkableBillingSettings,
  upsertResparkableBillingSettings,
} from '@/lib/framework/resparkable/repo/billing-settings';
import { resolveBillingSettings } from '@/lib/framework/resparkable/settings';
import { resparkableBillingSettingsSchema } from '@/lib/framework/resparkable/validations';

export const GET = withAdminAuth(async (request) => {
  const log = await getRouteLogger(request);

  const row = await findResparkableBillingSettings();
  const resolved = resolveBillingSettings(row);

  const payload = { ...resolved, isDefault: row === null };

  log.info('Resparkable admin billing settings read', { isDefault: payload.isDefault });

  return successResponse(payload);
});

export const PATCH = withAdminAuth(async (request) => {
  const log = await getRouteLogger(request);

  const body = await validateRequestBody(request, resparkableBillingSettingsSchema);

  const row = await upsertResparkableBillingSettings(body);
  const resolved = resolveBillingSettings(row);

  log.info('Resparkable admin billing settings updated', {
    creditsPerUsd: resolved.creditsPerUsd,
    serviceChargePercent: resolved.serviceChargePercent,
  });

  return successResponse({ ...resolved, isDefault: false });
});
