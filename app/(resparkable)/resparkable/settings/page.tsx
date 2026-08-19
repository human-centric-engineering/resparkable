import type { Metadata } from 'next';
import { z } from 'zod';

import { AboutSparkey } from '@/components/settings/about-sparkey';
import { SpaceSettingsForm } from '@/components/resparkable/settings/space-settings-form';
import { LoadError } from '@/components/resparkable/ui/load-error';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import { readResparkable } from '@/lib/framework/resparkable/ui/server-read';
import { getSparkeyPronoun } from '@/lib/resparkable/get-sparkey-pronoun';

export const metadata: Metadata = {
  title: 'Settings',
  description: 'Your timezone, your week, and how things get ranked.',
};

/**
 * Personal settings.
 *
 * These are the user's own, not the deployment's — `/admin/resparkable/settings` is the
 * operator surface and covers document handling. Nothing here is shared.
 *
 * `inboxToken` is deliberately absent from the payload: it is a bearer credential that
 * routes email into this brain, and a general settings read is exactly the kind of
 * response that ends up in a log or a bug report. It gets its own endpoint when email
 * capture lands.
 */
const settingsSchema = z.object({
  timezone: z.string(),
  workStyle: z.string(),
  priorityWeights: z.record(z.string(), z.number()),
  connectionStrengthFloor: z.number(),
  /** The eight §11 windows, resolved to defaults where the user has set none. */
  retentionPolicy: z.record(z.string(), z.number()),
});

export default async function ResparkableSettingsPage() {
  const [result, pronoun] = await Promise.all([
    readResparkable(RESPARKABLE_API.SPACE, settingsSchema),
    getSparkeyPronoun(),
  ]);

  return (
    <div className="max-w-2xl space-y-4">
      {/* About Sparkey, ahead of everything else on this page: who it is and
          how to refer to it, before the settings that change how it behaves.
          Rendered independently of the space-settings fetch below — a failure
          fetching timezone/priority/retention data has no bearing on this
          card, and shouldn't take it down too (see server-read.ts's own note
          on failure being a state, not something that drags the whole page
          under it). */}
      <AboutSparkey pronoun={pronoun} />

      {result.ok ? (
        <>
          <p className="text-muted-foreground text-sm">
            Yours alone. Everything scheduled — snoozes, retention, &ldquo;tomorrow morning&rdquo; —
            resolves in the timezone below rather than the server&rsquo;s.
          </p>
          <SpaceSettingsForm initial={result.data} />
        </>
      ) : (
        <LoadError what="your settings" message={result.message} />
      )}
    </div>
  );
}
