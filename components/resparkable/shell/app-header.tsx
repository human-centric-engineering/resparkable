/**
 * ResparkableAppHeader — the workspace shell's own sticky top chrome.
 *
 * Distinct from Sunrise's own `components/layouts/app-header.tsx`, which
 * still wraps every `(protected)` route (including `/resparkable`) above
 * this one and keeps the account menu — this header does not repeat
 * `UserButton`. What it does repeat, deliberately, is the brand mark and the
 * theme toggle: once the three-pane shell lands (Phase 8) this is the chrome
 * a session actually lives under, and Sunrise's own header can scroll out of
 * reach the same way `AppHeader`'s own doc comment says a header the brand
 * and controls live in must not.
 *
 * ## What this replaces
 *
 * `resparkable-nav.tsx`'s rail head used to carry the "way home" link as
 * plain `.term-label` text ("Resparkable"), because the rail was 224px of
 * text already. That rail is gone in the workspace shell — nothing else
 * says the brand's name once the plain nav rail is deleted (Phase 9) — so
 * the link is upgraded to the real `BrandMark`, the same mark Sunrise's own
 * header renders as its logo slot.
 *
 * ## Why the search box is `compact`
 *
 * This header is a single ~40px sticky bar, not a page with room to spare —
 * `resparkable-search-box.tsx`'s `size="compact"` variant exists for exactly
 * this caller (see that file's own header comment). Submitting still just
 * navigates to `RESPARKABLE_ROUTES.searchFor(query)`; Phase 8's
 * `route-tab-bridge.tsx` is what turns that navigation into an open,
 * route-backed Search tab — nothing here needs to know about tabs at all.
 *
 * `.lattice-chrome` (`design-language.md`) is the same translucent,
 * blurred-and-saturated panel treatment Sunrise's own sticky header uses,
 * so the two headers read as one family when stacked.
 */

import Link from 'next/link';

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

      <ThemeToggle />
    </header>
  );
}
