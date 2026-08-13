/**
 * The PWA manifest's content, as data.
 *
 * `app/manifest.ts` is a one-line re-export of this — the same split the tier
 * uses everywhere else a Sunrise-level file has to exist at all (compare
 * `lib/app/rate-limit.ts`'s relationship to `registerResparkableRateLimits()`).
 * A manifest is inherently whole-app in scope, so keeping the actual content
 * here means a host that wants its own PWA identity edits one small
 * pass-through file instead of untangling it from Resparkable's.
 *
 * ## `share_target` is `method: 'GET'`, deliberately
 *
 * A `POST` share target needs a service-worker `fetch` handler to intercept
 * the submission — real work, and a second thing that can silently stop
 * working. `GET` needs none: the browser just navigates to
 * `/resparkable/capture?title=…&text=…&url=…`, which is a page
 * (`app/(protected)/resparkable/capture/page.tsx`) that already knows how to
 * read those three params. The cost is Android-only — iOS Safari has no
 * `share_target` equivalent at all; see `capture-channels.md` for the
 * Shortcut path that covers iOS instead.
 *
 * ## Colours match the icon, not `--color-primary`
 *
 * `background_color` (splash screen) and `theme_color` (status bar / task
 * switcher chrome) are both the icon's own dark ground (`#10121a`), not the
 * amber accent — a manifest has one static colour pair, chosen once at
 * install time, while `--color-primary` already varies by theme
 * (`brand-theme.css`). The dark ground is the one constant across both.
 */

import type { MetadataRoute } from 'next';

export const RESPARKABLE_MANIFEST: MetadataRoute.Manifest = {
  name: 'Resparkable',
  short_name: 'Resparkable',
  description: 'Your second brain — capture, connect and prioritise.',
  start_url: '/resparkable',
  display: 'standalone',
  background_color: '#10121a',
  theme_color: '#10121a',
  icons: [
    { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    {
      src: '/icons/icon-512-maskable.png',
      sizes: '512x512',
      type: 'image/png',
      purpose: 'maskable',
    },
  ],
  shortcuts: [
    { name: 'Capture', url: '/resparkable/capture' },
    { name: 'Today', url: '/resparkable' },
    { name: 'Inbox', url: '/resparkable/inbox' },
  ],
  share_target: {
    action: '/resparkable/capture',
    method: 'GET',
    params: { title: 'title', text: 'text', url: 'url' },
  },
};

export default RESPARKABLE_MANIFEST;
