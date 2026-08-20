/**
 * ResparkableAppHeader — the workspace shell's only header.
 *
 * `/resparkable` moved to its own route group specifically so this is the
 * *only* header on screen (`layout.tsx`'s own header comment) — a first cut
 * that kept Sunrise's `AppHeader`+`ProtectedNav` wrapping this one stacked
 * two headers, which real usage flagged immediately as looking like two
 * apps glued together. This header now carries everything that mattered
 * from Sunrise's: the brand mark as the way-home link, and — via
 * `UserButton`, the same component Sunrise's own `HeaderActions` renders —
 * the account menu, with Profile/Settings/Admin Dashboard/sign-out living in
 * the avatar dropdown rather than a separate nav row. `Dashboard` (Sunrise's
 * own top-level nav item) isn't in `UserButton`'s menu; reachable via the
 * brand mark's own home link or the browser, not duplicated here.
 *
 * ## Why the search box is `compact`
 *
 * This header is a single ~40px sticky bar, not a page with room to spare —
 * `resparkable-search-box.tsx`'s `size="compact"` variant exists for exactly
 * this caller (see that file's own header comment). Submitting still just
 * navigates to `RESPARKABLE_ROUTES.searchFor(query)`; `route-tab-bridge.tsx`
 * is what turns that navigation into an open, route-backed Search tab —
 * nothing here needs to know about tabs at all.
 *
 * `.lattice-chrome` (`design-language.md`) is the same translucent,
 * blurred-and-saturated panel treatment Sunrise's own sticky header used,
 * so the one header left reads as the same family, not a fork's own thing.
 *
 * Sparkey/Activity's collapse controls do **not** live here — a first cut
 * put them here (an always-visible chrome bar felt like the safe place for
 * a control tied to a panel that can shrink to nothing), but real usage
 * flagged it as disconnected from what it operated on. They now live on
 * `PaneCollapseButton`, floating on the `ResizableHandle` each pane sits
 * against, plus the whole `PaneRail` strip once a pane is collapsed — see
 * `workspace-shell.tsx`'s own header comment.
 *
 * "Present" is different from those and does belong here: it doesn't
 * operate on one pane, it starts a whole-workspace mode (`PresentPane`,
 * rendered full-screen by `workspace-shell.tsx`), and this header is the
 * one piece of chrome that's always on screen regardless of which panes are
 * open or collapsed. `onPresent` is optional so this component still
 * renders standalone (tests, Storybook-style usage) without a caller
 * wiring Present mode up.
 */

import Link from 'next/link';
import { Play } from 'lucide-react';

import { UserButton } from '@/components/auth/user-button';
import { BrandMark } from '@/components/brand/brand-mark';
import { ResparkableSearchBox } from '@/components/resparkable/layout/resparkable-search-box';
import { Button } from '@/components/ui/button';
import { ThemeToggle } from '@/components/theme-toggle';
import { RESPARKABLE_ROUTES } from '@/lib/framework/resparkable/ui/routes';

export interface ResparkableAppHeaderProps {
  onPresent?: () => void;
}

export function ResparkableAppHeader({ onPresent }: ResparkableAppHeaderProps = {}) {
  return (
    <header className="border-border/60 lattice-chrome sticky top-0 z-40 flex items-center gap-4 border-b px-3 py-2">
      <Link
        href={RESPARKABLE_ROUTES.TODAY}
        className="shrink-0 text-lg transition-opacity hover:opacity-75"
        aria-label="Resparkable — go to Today"
      >
        <BrandMark />
      </Link>

      <ResparkableSearchBox size="compact" className="w-full max-w-xs" />

      <div className="ml-auto flex shrink-0 items-center gap-2">
        {onPresent && (
          <Button size="sm" onClick={onPresent}>
            <Play className="h-3.5 w-3.5" aria-hidden="true" />
            Present
          </Button>
        )}
        <ThemeToggle />
        <UserButton />
      </div>
    </header>
  );
}
