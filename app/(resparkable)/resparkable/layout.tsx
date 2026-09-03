import type { Metadata } from 'next';
import { Suspense } from 'react';

import { MaintenanceWrapperWithAdminNotice } from '@/components/maintenance-wrapper';
import { WorkspaceShell } from '@/components/resparkable/shell/workspace-shell';
import { WorkspaceShellSkeleton } from '@/components/resparkable/shell/workspace-shell-skeleton';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import { openableSpacesSchema } from '@/lib/framework/resparkable/ui/payloads';
import { readResparkable } from '@/lib/framework/resparkable/ui/server-read';

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
 * It does fetch one thing again, from phase 47: the list of workspaces the
 * switcher shows. That read belongs here and nowhere else in the tree, for
 * a reason specific to layouts — a layout is handed no `searchParams`, so
 * it cannot know the active workspace, and this is the only Resparkable
 * read that does not need to. Everything else a page shows is space-scoped
 * and is therefore read by the page, which does get `searchParams`.
 *
 * `ResparkableSidekick` (the fixed capture drawer) and `ResparkableNav`
 * (the rail) are unused from here on, but not deleted — Phase 9's job,
 * once nothing else could plausibly still reference them.
 *
 * `MaintenanceWrapperWithAdminNotice` is async (a DB read plus a session
 * check) and un-Suspended before this point in the tree — without a
 * boundary of its own, that gap has nothing standing in for the shell
 * it's about to render. `WorkspaceShellSkeleton` is that boundary's
 * fallback, shaped like the real three-pane shell rather than a bare
 * spinner, so a slow maintenance check reads as "the workspace is
 * loading" instead of a blank screen with only the pane collapse
 * buttons floating on it (live feedback).
 */
export default async function ResparkableLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // The switcher's list, read here rather than in the client component that
  // shows it. A layout renders once and survives client-side navigation, so
  // this is one request per cold load rather than one per page, and the header
  // names the workspace on the first paint instead of after a spinner.
  //
  // `null` because this list is keyed on the ACTOR, not on a workspace: "which
  // workspaces are mine" asked from inside one of them would be circular. It is
  // also the one read in the tier a layout can make, since a layout is handed no
  // `searchParams` and therefore cannot know the active space at all.
  //
  // A failure degrades to no switcher rather than taking the shell down. The
  // list is chrome; the workspace still resolves from the URL underneath it.
  const spaces = await readResparkable(RESPARKABLE_API.SPACES, openableSpacesSchema, null);

  return (
    <Suspense fallback={<WorkspaceShellSkeleton />}>
      <MaintenanceWrapperWithAdminNotice>
        <WorkspaceShell spaces={spaces.ok ? spaces.data : []}>{children}</WorkspaceShell>
      </MaintenanceWrapperWithAdminNotice>
    </Suspense>
  );
}
