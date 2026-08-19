'use client';

/**
 * SettingsTab — the launcher-opened counterpart to `app/(protected)/resparkable/settings/page.tsx`.
 *
 * `settingsSchema` is defined inline in the server page rather than in
 * `payloads.ts` — this duplicates it locally rather than exporting it from
 * the page (a server file `'use client'` components can't import from) or
 * inventing a new shared home for one schema this phase doesn't need
 * elsewhere.
 *
 * `AboutSparkey` is left out — it needs `getSparkeyPronoun()`, a
 * server-only helper, for what is purely a cosmetic wording choice (see
 * `GoalsTab`'s header comment for the same call made there). The settings
 * form itself is the substance of this tab.
 */

import * as React from 'react';
import { z } from 'zod';

import { SpaceSettingsForm } from '@/components/resparkable/settings/space-settings-form';
import { SkeletonList } from '@/components/resparkable/ui/skeleton';
import { TabLoadError } from '@/components/resparkable/workspace/tabs/tab-load-error';
import { useTabFetch } from '@/components/resparkable/workspace/tabs/use-tab-fetch';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';

const settingsSchema = z.object({
  timezone: z.string(),
  workStyle: z.string(),
  priorityWeights: z.record(z.string(), z.number()),
  connectionStrengthFloor: z.number(),
  retentionPolicy: z.record(z.string(), z.number()),
});

export function SettingsTab(): React.ReactElement {
  const [result, retry] = useTabFetch(RESPARKABLE_API.SPACE, settingsSchema);

  if (result.status === 'loading') return <SkeletonList label="Loading settings" />;
  if (result.status === 'error') {
    return <TabLoadError what="your settings" message={result.message} onRetry={retry} />;
  }

  return (
    <div className="max-w-2xl space-y-4 p-4">
      <p className="text-muted-foreground text-sm">
        Yours alone. Everything scheduled — snoozes, retention, &ldquo;tomorrow morning&rdquo; —
        resolves in the timezone below rather than the server&rsquo;s.
      </p>
      <SpaceSettingsForm initial={result.data} />
    </div>
  );
}
