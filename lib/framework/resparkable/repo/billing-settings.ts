/**
 * Billing-settings repo: the singleton `ResparkableBillingSettings` row.
 *
 * Same exception `repo/settings.ts` documents: no `OwnerScope`, because what
 * this holds (credits-per-dollar, service charge, the default new-user grant)
 * is a deployment-wide policy, not user data. Writes are admin-only, enforced
 * at the route by `withAdminAuth`; this layer has no idea who is calling.
 */

import { prisma } from '@/lib/db/client';
import type { ResparkableBillingSettings } from '@prisma/client';

/** Mirrors `RESPARKABLE_SETTINGS_SLUG`; see `repo/settings.ts` for why a slug. */
export const RESPARKABLE_BILLING_SETTINGS_SLUG = 'global';

/**
 * Read the billing settings row, or `null` when none has been written.
 *
 * `null` is the normal state of a fresh install: the resolvers in
 * `lib/framework/resparkable/settings.ts` turn it into the code defaults.
 */
export async function findResparkableBillingSettings(): Promise<ResparkableBillingSettings | null> {
  return prisma.resparkableBillingSettings.findUnique({
    where: { slug: RESPARKABLE_BILLING_SETTINGS_SLUG },
  });
}

export interface ResparkableBillingSettingsWrite {
  creditsPerUsd?: number;
  serviceChargePercent?: number;
  costVisibleToUsersDefault?: boolean;
  currencyLabel?: string;
  newUserGrantCredits?: number;
}

/**
 * Create-or-update the singleton. The slug is the spread that wins: see
 * `repo/settings.ts`'s `upsertResparkableSettings` for why it goes last.
 */
export async function upsertResparkableBillingSettings(
  data: ResparkableBillingSettingsWrite
): Promise<ResparkableBillingSettings> {
  return prisma.resparkableBillingSettings.upsert({
    where: { slug: RESPARKABLE_BILLING_SETTINGS_SLUG },
    create: { ...data, slug: RESPARKABLE_BILLING_SETTINGS_SLUG },
    update: data,
  });
}
