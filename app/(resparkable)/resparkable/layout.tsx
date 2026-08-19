import type { Metadata } from 'next';

import { MaintenanceWrapperWithAdminNotice } from '@/components/maintenance-wrapper';
import { WorkspaceShell } from '@/components/resparkable/shell/workspace-shell';

export const metadata: Metadata = {
  title: {
    template: '%s · Resparkable',
    default: 'Resparkable',
  },
  description: 'Your second brain — capture, connect and prioritise.',
  /**
   * iOS has no `manifest.json` install prompt — `apple-mobile-web-app-*`
   * meta tags are the whole of what makes "Add to Home Screen" produce a
   * standalone window instead of a bookmark that opens Safari chrome.
   * Declared here rather than the root layout because only `/resparkable`
   * is meant to be installed as an app; the marketing and admin surfaces
   * are not.
   */
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'Resparkable',
  },
};

/**
 * The Resparkable shell — Phase 8's cutover, moved to its own route group
 * post-launch feedback.
 *
 * ## What replaced what
 *
 * The old shell (nav rail + capture drawer + a single `SectionHeader`
 * above `{children}`) is gone. `WorkspaceShell` — a Server/Client split
 * this file needs because `metadata` above can only be exported from a
 * Server Component, and everything the new shell does (media query,
 * `WorkspaceProvider`, panel state) needs `'use client'` — replaces it
 * with the three-pane layout the build plan describes: Sparkey (chat /
 * capture / instruct), the Workspace pane tree (tabs, splits, launcher),
 * and Activity (the discovery feed). `{children}` — whatever page.tsx
 * Next.js resolved for the current route, untouched — becomes that pane
 * tree's one route-backed tab via `RouteTabBridge`, so every existing deep
 * link, bookmark and email link keeps resolving exactly as it did before
 * this phase.
 *
 * ## Why this lives in `(resparkable)`, not `(protected)`
 *
 * A first cut kept `/resparkable` inside `(protected)`, inheriting Sunrise's
 * own sticky `AppHeader`+`ProtectedNav`+padded `<main>`+`ProtectedFooter` —
 * stacked on top of this shell's own header, it read as two apps glued
 * together rather than one immersive surface, which real usage caught
 * immediately. A layout can't opt a subtree out of an ancestor's chrome in
 * the App Router — the only fix is not being a descendant of it. Route
 * groups don't affect the URL (`/resparkable` is unchanged) and protection
 * is enforced by `proxy.ts` on the literal pathname prefix
 * (`lib/app/protected-routes.ts`'s `appProtectedRoutes`), not on folder
 * placement — so this move is free from an auth standpoint. It does mean
 * this layout re-declares `MaintenanceWrapperWithAdminNotice` itself, since
 * it no longer inherits `(protected)/layout.tsx`'s copy.
 *
 * `ResparkableAppHeader` now carries everything Sunrise's global header did
 * for this surface: `UserButton` gives back Profile/Settings/Admin/sign-out
 * via the avatar dropdown Sunrise's own header already used, rather than a
 * second nav row.
 *
 * The counts this layout used to fetch (`/resparkable/counts`, for the old
 * rail's badges) have no reader left: the rail is deleted, and neither the
 * launcher nor the tab strip shows a numeric badge. Activity now surfaces
 * pending connections directly, as a live, browsable feed rather than a
 * count — a deliberate upgrade over a number, not an oversight. Nothing
 * else in the new shell wants those three counts, so this layout no
 * longer fetches them.
 *
 * `ResparkableSidekick` (the fixed capture drawer) and `ResparkableNav`
 * (the rail) are unused from here on, but not deleted — Phase 9's job,
 * once nothing else could plausibly still reference them.
 */
export default function ResparkableLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <MaintenanceWrapperWithAdminNotice>
      <WorkspaceShell>{children}</WorkspaceShell>
    </MaintenanceWrapperWithAdminNotice>
  );
}
