import type { Metadata } from 'next';

import { ResparkableSettingsTabs } from '@/components/resparkable/admin/resparkable-settings-tabs';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import {
  resparkableAdminBillingSettingsResponseSchema,
  resparkableAdminCreditAccountRowSchema,
  resparkableAdminSettingsResponseSchema,
} from '@/lib/framework/resparkable/validations';
import { logger } from '@/lib/logging';
import { z } from 'zod';

export const metadata: Metadata = {
  title: 'Settings · Resparkable',
  description: 'Deployment-wide document handling and billing.',
};

/**
 * Read the settings through the API rather than the repo.
 *
 * Slightly indirect for a server component, but it keeps one implementation of
 * "what are the effective settings" — including the resolved storage capability,
 * which the form's whole layout depends on — rather than a page that computes it
 * one way and the API another. Parsed with Zod because a fetch response is
 * external data, even when we wrote the endpoint (CLAUDE.md: no `as` on external
 * data).
 */
async function getSettings() {
  try {
    const response = await serverFetch(RESPARKABLE_API.ADMIN.SETTINGS);
    if (!response.ok) return null;
    const body = await parseApiResponse<unknown>(response);
    if (!body.success) return null;
    return resparkableAdminSettingsResponseSchema.parse(body.data);
  } catch (error) {
    logger.error('Resparkable admin settings page: fetch failed', error);
    return null;
  }
}

async function getBillingSettings() {
  try {
    const response = await serverFetch(RESPARKABLE_API.ADMIN.BILLING_SETTINGS);
    if (!response.ok) return null;
    const body = await parseApiResponse<unknown>(response);
    if (!body.success) return null;
    return resparkableAdminBillingSettingsResponseSchema.parse(body.data);
  } catch (error) {
    logger.error('Resparkable admin billing settings page: fetch failed', error);
    return null;
  }
}

const billingAccountsResponseSchema = z.object({
  accounts: z.array(resparkableAdminCreditAccountRowSchema),
});

/**
 * `null` on failure, never `[]` — the two must stay distinguishable. This
 * fetch is independent of `getBillingSettings()`'s, and the Billing tab
 * renders each of the two independently: collapsing "the accounts fetch
 * failed" into the same empty array as "there are genuinely no users yet"
 * would let a broken accounts endpoint read as a quiet, correct-looking
 * empty table indefinitely.
 */
async function getCreditAccounts() {
  try {
    const response = await serverFetch(RESPARKABLE_API.ADMIN.BILLING_ACCOUNTS);
    if (!response.ok) return null;
    const body = await parseApiResponse<unknown>(response);
    if (!body.success) return null;
    return billingAccountsResponseSchema.parse(body.data).accounts;
  } catch (error) {
    logger.error('Resparkable admin billing accounts page: fetch failed', error);
    return null;
  }
}

export default async function ResparkableSettingsPage() {
  const [documentSettings, billingSettings, creditAccounts] = await Promise.all([
    getSettings(),
    getBillingSettings(),
    getCreditAccounts(),
  ]);

  return (
    <div className="space-y-6">
      <header className="bg-background sticky top-0 z-30 -mx-6 border-b px-6 pt-3 pb-3">
        <h1 className="text-2xl font-semibold">Resparkable Settings</h1>
        <p className="text-muted-foreground text-sm">
          Deployment-wide document handling and billing. These are operator settings, everything
          else in Resparkable belongs to the individual user.
        </p>
      </header>

      <ResparkableSettingsTabs
        documentSettings={documentSettings}
        billingSettings={billingSettings}
        creditAccounts={creditAccounts}
      />
    </div>
  );
}
