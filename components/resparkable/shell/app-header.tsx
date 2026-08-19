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
 */

import Link from 'next/link';

import { UserButton } from '@/components/auth/user-button';
import { BrandMark } from '@/components/brand/brand-mark';
import { ResparkableSearchBox } from '@/components/resparkable/layout/resparkable-search-box';
import { ThemeToggle } from '@/components/theme-toggle';
import { RESPARKABLE_ROUTES } from '@/lib/framework/resparkable/ui/routes';

export function ResparkableAppHeader() {
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
        <ThemeToggle />
        <UserButton />
      </div>
    </header>
  );
}
