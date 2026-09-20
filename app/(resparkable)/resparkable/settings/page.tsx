import type { Metadata } from 'next';
import { z } from 'zod';

import { AboutSparkey } from '@/components/settings/about-sparkey';
import { ConnectAssistantCard } from '@/components/resparkable/settings/connect-assistant-card';
import { SpaceSettingsForm } from '@/components/resparkable/settings/space-settings-form';
import { LoadError } from '@/components/resparkable/ui/load-error';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import { readSpaceTarget } from '@/lib/framework/resparkable/ui/active-space';
import {
  readResparkable,
  type ResparkableSearchParams,
} from '@/lib/framework/resparkable/ui/server-read';
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

/**
 * Enough of the switcher's payload to name the open workspace.
 *
 * Read here because `readSpaceTarget` answers `null` for the personal space,
 * and the Connect card needs a **concrete** space id: a key is minted for a
 * named workspace, and "the one you happen to be in" is not a thing a
 * credential can carry. Resolved the same way the header switcher resolves it,
 * so the card can never name a different workspace from the one in the corner
 * of the screen.
 */
const spacesSchema = z.array(z.object({ spaceId: z.string(), name: z.string() }));

export default async function ResparkableSettingsPage({
  searchParams,
}: {
  searchParams: ResparkableSearchParams;
}) {
  const space = readSpaceTarget(await searchParams);
  const [result, spaces, pronoun] = await Promise.all([
    readResparkable(RESPARKABLE_API.SPACE, settingsSchema, space),
    readResparkable(RESPARKABLE_API.SPACES, spacesSchema, space),
    getSparkeyPronoun(),
  ]);

  // `listOpenableSpaces` always puts the personal space first, so the fallback
  // is the same one the switcher falls back to rather than an arbitrary row.
  const openSpace = spaces.ok
    ? (spaces.data.find((entry) => entry.spaceId === space) ?? spaces.data[0])
    : undefined;

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

      {/* Connecting an assistant is about Sparkey's neighbours rather than
          about the ranking settings below, so it sits with the card that
          introduces the assistant. Rendered off its own read for the same
          reason `<AboutSparkey>` is: a failure fetching timezone and priority
          data has no bearing on it. */}
      {/* `key` on the workspace, and it is load-bearing rather than tidiness.
          The switcher changes workspace with `router.push` on this same route,
          which is a soft navigation: React keeps the client component instance
          and only the props change. The card holds a minted plaintext in state,
          so without this it would go on showing workspace A's secret and A's
          paste-ready snippets under a heading that now names B, and somebody
          would paste a key believing it reaches the workspace they are looking
          at. Remounting drops that state with the workspace it belonged to. */}
      {openSpace ? (
        <ConnectAssistantCard
          key={openSpace.spaceId}
          spaceId={openSpace.spaceId}
          spaceName={openSpace.name}
        />
      ) : null}

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
