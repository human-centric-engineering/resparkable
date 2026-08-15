'use client';

/**
 * About Sparkey: introduces the assistant honestly near the top of Settings,
 * before anything else, and lets the user pick how the app refers to it.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { useAnalytics, EVENTS } from '@/lib/analytics';
import { SparkGlyph } from '@/components/brand/spark-glyph';
import { SaveStatus, useSaveStatus } from '@/components/resparkable/ui/save-status';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { FieldHelp } from '@/components/ui/field-help';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  SPARKEY_PRONOUNS,
  SPARKEY_PRONOUN_LABELS,
  type SparkeyPronoun,
} from '@/lib/resparkable/sparkey-pronoun';
import type { UserPreferences } from '@/types';

export interface AboutSparkeyProps {
  pronoun: SparkeyPronoun;
}

export function AboutSparkey({ pronoun: initialPronoun }: AboutSparkeyProps) {
  const router = useRouter();
  const { track } = useAnalytics();
  const { state, message, run } = useSaveStatus();
  const [pronoun, setPronoun] = useState(initialPronoun);

  const handleChange = async (value: string) => {
    const next = value as SparkeyPronoun;
    const previous = pronoun;
    setPronoun(next);

    const ok = await run(
      () =>
        apiClient.patch<UserPreferences>(API.USERS.ME_PREFERENCES, {
          body: { sparkey: { pronoun: next } },
        }),
      (error) => (error instanceof APIClientError ? error.message : 'Failed to update preference')
    );

    if (ok) {
      void track(EVENTS.SPARKEY_PRONOUN_UPDATED, { pronoun: next });
      router.refresh();
    } else {
      setPronoun(previous);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <SparkGlyph className="h-5 w-9" />
          About Sparkey
        </CardTitle>
        <CardDescription>
          Never forget that Sparkey is a machine, not a human being. Sparkey is an assistant, a
          tool, an efficient task runner designed to help with your creative process, not to replace
          it and not to act as an authority over it.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-0.5">
            <Label htmlFor="sparkey-pronoun" className="flex items-center gap-1 text-base">
              How should we refer to Sparkey?
              <FieldHelp title="Sparkey's pronoun">
                Choose how the app refers to Sparkey in its own copy. Default: It, since Sparkey is
                a tool rather than a person.
              </FieldHelp>
            </Label>
            <p className="text-muted-foreground text-sm">Used wherever the app mentions Sparkey.</p>
          </div>
          <Select value={pronoun} onValueChange={(value) => void handleChange(value)}>
            <SelectTrigger id="sparkey-pronoun" className="w-32" disabled={state === 'saving'}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SPARKEY_PRONOUNS.map((option) => (
                <SelectItem key={option} value={option}>
                  {SPARKEY_PRONOUN_LABELS[option]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <SaveStatus state={state} message={state === 'error' ? message : null} className="mt-2" />
      </CardContent>
    </Card>
  );
}
