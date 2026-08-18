'use client';

/**
 * ResparkableSettingsTabs: Settings / Billing, URL-synced like
 * `UserManagementTabs`. Server-fetched data comes in as props; each tab's
 * form/table owns its own save state.
 */

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

interface Props {
  documentSettings: ResparkableDocumentSettings | null;
  billingSettings: ResparkableAdminBillingSettingsResponse | null;
  creditAccounts: ResparkableAdminCreditAccountRow[];
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
          <SettingsLoadError />
        )}
      </TabsContent>

      <TabsContent value="billing" className="space-y-6">
        {billingSettings ? (
          <>
            <BillingSettingsForm initial={billingSettings} />
            <CreditAccountsTable
              accounts={creditAccounts}
              currencyLabel={billingSettings.currencyLabel}
            />
          </>
        ) : (
          <SettingsLoadError />
        )}
      </TabsContent>
    </Tabs>
  );
}

function SettingsLoadError() {
  return (
    <div className="rounded border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
      <p className="font-medium">Couldn&rsquo;t load settings.</p>
      <p className="mt-1">Check the server logs for the failure and reload.</p>
    </div>
  );
}
