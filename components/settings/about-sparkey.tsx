'use client';

/**
 * About Sparkey: introduces the assistant honestly near the top of Settings,
 * before anything else, and lets the user pick how the app refers to it.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, CheckCircle2 } from 'lucide-react';
import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { useAnalytics, EVENTS } from '@/lib/analytics';
import { SparkGlyph } from '@/components/brand/spark-glyph';
import { useSparkeyPronounValue } from '@/components/resparkable/sparkey-pronoun-provider';
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

export function AboutSparkey() {
  const router = useRouter();
  const { track } = useAnalytics();
  const initialPronoun = useSparkeyPronounValue();
  const [pronoun, setPronoun] = useState(initialPronoun);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const handleChange = async (value: string) => {
    const next = value as SparkeyPronoun;
    const previous = pronoun;
    setPronoun(next);

    try {
      setIsLoading(true);
      setError(null);
      setSuccess(false);

      await apiClient.patch<UserPreferences>(API.USERS.ME_PREFERENCES, {
        body: { sparkey: { pronoun: next } },
      });

      void track(EVENTS.SPARKEY_PRONOUN_UPDATED, { pronoun: next });

      setSuccess(true);
      router.refresh();
      setTimeout(() => setSuccess(false), 3000);
    } catch (err) {
      setPronoun(previous);
      setError(err instanceof APIClientError ? err.message : 'Failed to update preference');
    } finally {
      setIsLoading(false);
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
            <SelectTrigger id="sparkey-pronoun" className="w-32" disabled={isLoading}>
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

        {isLoading && (
          <div className="text-muted-foreground mt-2 flex items-center gap-2 text-sm">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Saving...
          </div>
        )}
        {success && (
          <div className="mt-2 flex items-center gap-2 text-sm text-green-700 dark:text-green-400">
            <CheckCircle2 className="h-3.5 w-3.5" />
            Saved
          </div>
        )}
        {error && <div className="text-destructive mt-2 text-sm">{error}</div>}
      </CardContent>
    </Card>
  );
}
