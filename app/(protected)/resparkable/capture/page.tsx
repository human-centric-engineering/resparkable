import type { Metadata } from 'next';

import { QuickCapture } from '@/components/resparkable/layout/quick-capture';

export const metadata: Metadata = {
  title: 'Capture',
  description: 'Capture a thought shared from another app.',
};

/**
 * The PWA share-target landing page (phase 9, §8).
 *
 * ## Why this page exists at all
 *
 * The capture drawer (`resparkable-sidekick.tsx`) already covers every other
 * entry point, but Android's Web Share Target API opens a **page**, not a
 * drawer — there is no way to hand a share intent to something that starts
 * closed. `app/manifest.ts` declares `share_target: { method: 'GET', action:
 * '/resparkable/capture', params: { title, text, url } }`, so sharing a page
 * from the browser or a link from another app lands here with those three
 * query params set.
 *
 * ## Same box, same draft-until-you-press-Capture contract
 *
 * This renders the same `QuickCapture` component the drawer does, just inline
 * in the page body instead of a fixed panel — no bespoke form, no separate
 * submit path. `initialValue` only seeds the textarea; nothing is sent until
 * a person presses Capture, same as anything typed by hand. When there is
 * shared content, `initialSource="pwa"` tags it — cleared back to unset by
 * `QuickCapture`'s own rule the moment the box is edited by hand, same as a
 * voice transcript or an extracted image would be.
 *
 * ## iOS has no equivalent
 *
 * Share Target is Android-only; Safari's share sheet has nothing that opens a
 * URL with the shared content attached. The iOS two-second-capture answer is
 * the Shortcut recipe in `install.md` §4.3, unrelated to this page.
 */
export default async function ResparkableCapturePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const initialValue = composeSharedContent(params);

  return (
    <div className="mx-auto max-w-2xl">
      <QuickCapture
        initialValue={initialValue}
        {...(initialValue ? { initialSource: 'pwa' as const } : {})}
        focusSignal={1}
        className="min-h-[50vh]"
      />
    </div>
  );
}

function firstString(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? '';
}

/**
 * Joins whatever the share sheet sent into one draft.
 *
 * The URL is appended on its own line only when the shared text doesn't
 * already contain it — most share sheets (browser "Share page…") put the link
 * inside `text` already, and repeating it would just be noise at the bottom
 * of every shared page.
 *
 * Exported so it can be tested directly rather than through a rendered page.
 */
export function composeSharedContent(
  params: Record<string, string | string[] | undefined>
): string {
  const title = firstString(params.title);
  const text = firstString(params.text);
  const url = firstString(params.url);

  const parts = [title, text].filter(Boolean);
  if (url && !parts.some((part) => part.includes(url))) parts.push(url);

  return parts.join('\n\n');
}
