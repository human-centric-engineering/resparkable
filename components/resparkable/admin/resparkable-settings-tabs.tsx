'use client';

/**
 * ResparkableSettingsTabs: Settings / Billing, URL-synced like
 * `UserManagementTabs`. Server-fetched data comes in as props; each tab's
 * form/table owns its own save state.
 */

import type { ReactNode } from 'react';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  DocumentSettingsForm,
  type ResparkableDocumentSettings,
} from '@/components/resparkable/admin/document-settings-form';
import { BillingSettingsForm } from '@/components/resparkable/admin/billing-settings-form';
import { CreditAccountsTable } from '@/components/resparkable/admin/credit-accounts-table';
import { useUrlTabs } from '@/lib/hooks/use-url-tabs';
import type {
  ResparkableAdminBillingSettingsResponse,
  ResparkableAdminCreditAccountRow,
} from '@/lib/framework/resparkable/validations';

const ALLOWED_TABS = ['settings', 'billing'] as const;
type ResparkableSettingsTab = (typeof ALLOWED_TABS)[number];

/** Matches `DEFAULT_BILLING_SETTINGS.currencyLabel` (`lib/framework/resparkable/settings.ts`) — kept as a literal here rather than imported, so this client bundle doesn't pull in that module's other exports. */
const DEFAULT_CURRENCY_LABEL = 'credits';

interface Props {
  documentSettings: ResparkableDocumentSettings | null;
  billingSettings: ResparkableAdminBillingSettingsResponse | null;
  /** `null` when the accounts fetch itself failed — distinct from a genuine empty list. */
  creditAccounts: ResparkableAdminCreditAccountRow[] | null;
}

export function ResparkableSettingsTabs({
  documentSettings,
  billingSettings,
  creditAccounts,
}: Props) {
  const { activeTab, setActiveTab } = useUrlTabs<ResparkableSettingsTab>({
    defaultTab: 'settings',
    allowedTabs: ALLOWED_TABS,
  });

  return (
    <Tabs
      value={activeTab}
      onValueChange={(v) => setActiveTab(v as ResparkableSettingsTab)}
      className="space-y-4"
    >
      <TabsList>
        <TabsTrigger value="settings">Settings</TabsTrigger>
        <TabsTrigger value="billing">Billing</TabsTrigger>
      </TabsList>

      <TabsContent value="settings">
        {documentSettings ? (
          <DocumentSettingsForm initial={documentSettings} />
        ) : (
          <SettingsLoadError>
            Resparkable is running on its defaults: originals discarded after parsing, 25 MB upload
            ceiling. Check the server logs for the failure and reload.
          </SettingsLoadError>
        )}
      </TabsContent>

      <TabsContent value="billing" className="space-y-6">
        {billingSettings ? (
          <BillingSettingsForm initial={billingSettings} />
        ) : (
          <SettingsLoadError>
            Billing is running on its defaults: 1 credit per US dollar, no service charge, no
            new-user grant. Check the server logs for the failure and reload.
          </SettingsLoadError>
        )}

        {/*
          Independent of the settings-form branch above: the two fetches
          (billing policy, credit accounts) are separate requests, and one
          failing must not hide the other's already-fetched, valid data —
          nor should a `[]` here be read as "the accounts fetch failed" when
          it might just mean there are no users yet (see `getCreditAccounts`'s
          own `null`-vs-`[]` distinction).
        */}
        {creditAccounts ? (
          <CreditAccountsTable
            accounts={creditAccounts}
            currencyLabel={billingSettings?.currencyLabel ?? DEFAULT_CURRENCY_LABEL}
          />
        ) : (
          <SettingsLoadError heading="Couldn’t load account balances.">
            Check the server logs for the failure and reload.
          </SettingsLoadError>
        )}
      </TabsContent>
    </Tabs>
  );
}

function SettingsLoadError({
  heading = 'Couldn’t load settings.',
  children,
}: {
  heading?: string;
  children: ReactNode;
}) {
  return (
    <div className="rounded border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
      <p className="font-medium">{heading}</p>
      <p className="mt-1">{children}</p>
    </div>
  );
}
