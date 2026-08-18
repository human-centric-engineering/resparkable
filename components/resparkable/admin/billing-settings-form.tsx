'use client';

/**
 * BillingSettingsForm: the global policy behind Resparkable's credit ledger.
 *
 * Mirrors `DocumentSettingsForm`'s shape (same save/dirty/error state machine)
 * against `ResparkableBillingSettings` instead of `ResparkableSettings`.
 */

import * as React from 'react';
import { AlertCircle, Check, Loader2, Save } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { FieldHelp } from '@/components/ui/field-help';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { apiClient, APIClientError } from '@/lib/api/client';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import {
  resparkableAdminBillingSettingsResponseSchema,
  type ResparkableAdminBillingSettingsResponse,
} from '@/lib/framework/resparkable/validations';

interface Props {
  initial: ResparkableAdminBillingSettingsResponse;
}

export function BillingSettingsForm({ initial }: Props): React.ReactElement {
  const [creditsPerUsd, setCreditsPerUsd] = React.useState(String(initial.creditsPerUsd));
  const [serviceChargePercent, setServiceChargePercent] = React.useState(
    String(initial.serviceChargePercent)
  );
  const [costVisible, setCostVisible] = React.useState(initial.costVisibleToUsersDefault);
  const [currencyLabel, setCurrencyLabel] = React.useState(initial.currencyLabel);
  const [newUserGrant, setNewUserGrant] = React.useState(String(initial.newUserGrantCredits));
  const [saved, setSaved] = React.useState(initial);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [justSaved, setJustSaved] = React.useState(false);

  const parsedCreditsPerUsd = Number.parseFloat(creditsPerUsd);
  const parsedServiceCharge = Number.parseFloat(serviceChargePercent);
  const parsedNewUserGrant = Number.parseFloat(newUserGrant);

  const creditsPerUsdValid = Number.isFinite(parsedCreditsPerUsd) && parsedCreditsPerUsd > 0;
  const serviceChargeValid =
    Number.isFinite(parsedServiceCharge) && parsedServiceCharge >= 0 && parsedServiceCharge <= 1000;
  const newUserGrantValid = Number.isFinite(parsedNewUserGrant) && parsedNewUserGrant >= 0;
  const currencyLabelValid = currencyLabel.trim().length > 0 && currencyLabel.trim().length <= 32;
  const allValid =
    creditsPerUsdValid && serviceChargeValid && newUserGrantValid && currencyLabelValid;

  const dirty =
    (creditsPerUsdValid && parsedCreditsPerUsd !== saved.creditsPerUsd) ||
    (serviceChargeValid && parsedServiceCharge !== saved.serviceChargePercent) ||
    costVisible !== saved.costVisibleToUsersDefault ||
    (currencyLabelValid && currencyLabel.trim() !== saved.currencyLabel) ||
    (newUserGrantValid && parsedNewUserGrant !== saved.newUserGrantCredits);

  async function handleSave(): Promise<void> {
    setSubmitting(true);
    setError(null);
    setJustSaved(false);
    try {
      const raw = await apiClient.patch<unknown>(RESPARKABLE_API.ADMIN.BILLING_SETTINGS, {
        body: {
          creditsPerUsd: parsedCreditsPerUsd,
          serviceChargePercent: parsedServiceCharge,
          costVisibleToUsersDefault: costVisible,
          currencyLabel: currencyLabel.trim(),
          newUserGrantCredits: parsedNewUserGrant,
        },
      });

      // Parsed, not asserted: a fetch response is external data (CLAUDE.md).
      const next = resparkableAdminBillingSettingsResponseSchema.parse(raw);
      setSaved(next);
      setJustSaved(true);
    } catch (err) {
      setError(
        err instanceof APIClientError || err instanceof Error
          ? err.message
          : 'Failed to save, please try again.'
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          Billing policy
          <FieldHelp title="Billing policy" contentClassName="w-96">
            <p>
              Every agent turn (chat, ideate, scheduled workflows) debits the caller&rsquo;s credit
              balance for its real provider cost, plus this service charge, converted to credits at
              the rate below. A zero or negative balance blocks further agent-backed calls until an
              admin grants more.
            </p>
          </FieldHelp>
        </CardTitle>
        <CardDescription>
          Applies to every user of this deployment. Phase 1 is admin-grant only, there is no
          purchase flow yet.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-6">
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="resparkable-credits-per-usd" className="flex items-center gap-2">
              Credits per US dollar
              <FieldHelp title="Credits per US dollar" contentClassName="w-80">
                <p>
                  How many credits one dollar of real provider cost (plus the service charge below)
                  converts to. 1 means credits and dollars track 1:1.
                </p>
              </FieldHelp>
            </Label>
            <Input
              id="resparkable-credits-per-usd"
              type="number"
              min={0}
              step="any"
              value={creditsPerUsd}
              onChange={(event) => setCreditsPerUsd(event.target.value)}
              aria-invalid={!creditsPerUsdValid}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="resparkable-service-charge" className="flex items-center gap-2">
              Service charge (%)
              <FieldHelp title="Service charge" contentClassName="w-80">
                <p>
                  Added on top of real provider cost before converting to credits. 0 means the debit
                  exactly matches provider cost.
                </p>
              </FieldHelp>
            </Label>
            <Input
              id="resparkable-service-charge"
              type="number"
              min={0}
              max={1000}
              step="any"
              value={serviceChargePercent}
              onChange={(event) => setServiceChargePercent(event.target.value)}
              aria-invalid={!serviceChargeValid}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="resparkable-currency-label" className="flex items-center gap-2">
              Currency label
              <FieldHelp title="Currency label" contentClassName="w-80">
                <p>
                  What the balance is called wherever it&rsquo;s shown to a user, e.g.
                  &ldquo;credits&rdquo;.
                </p>
              </FieldHelp>
            </Label>
            <Input
              id="resparkable-currency-label"
              value={currencyLabel}
              onChange={(event) => setCurrencyLabel(event.target.value)}
              maxLength={32}
              aria-invalid={!currencyLabelValid}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="resparkable-new-user-grant" className="flex items-center gap-2">
              New-user grant
              <FieldHelp title="New-user grant" contentClassName="w-80">
                <p>
                  Credits a brand-new space starts with automatically. 0 means every user starts at
                  zero until an admin grants them credits.
                </p>
              </FieldHelp>
            </Label>
            <Input
              id="resparkable-new-user-grant"
              type="number"
              min={0}
              step="any"
              value={newUserGrant}
              onChange={(event) => setNewUserGrant(event.target.value)}
              aria-invalid={!newUserGrantValid}
            />
          </div>
        </div>

        <div className="flex items-center gap-3">
          <Switch
            id="resparkable-cost-visible"
            checked={costVisible}
            onCheckedChange={setCostVisible}
          />
          <Label htmlFor="resparkable-cost-visible" className="flex items-center gap-2">
            Show cost to users by default
            <FieldHelp title="Show cost to users" contentClassName="w-80">
              <p>Whether a user sees what a turn cost them in credits, by default.</p>
            </FieldHelp>
          </Label>
        </div>

        {saved.isDefault && !justSaved && (
          <p className="text-muted-foreground text-xs">
            Nothing has been saved yet: these are the platform defaults, which apply until you
            change them.
          </p>
        )}

        {error && (
          <p className="text-destructive flex items-center gap-2 text-sm" role="alert">
            <AlertCircle className="h-4 w-4" />
            {error}
          </p>
        )}

        <div className="flex items-center gap-3">
          <Button
            type="button"
            onClick={() => void handleSave()}
            disabled={!dirty || !allValid || submitting}
          >
            {submitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Saving…
              </>
            ) : (
              <>
                <Save className="mr-2 h-4 w-4" />
                Save
              </>
            )}
          </Button>
          {justSaved && !dirty && (
            <span className="text-muted-foreground flex items-center gap-1 text-sm">
              <Check className="h-4 w-4" />
              Saved
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
