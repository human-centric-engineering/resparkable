'use client';

/**
 * PaneRail — the collapsed-drawer state Sparkey and Activity fall back to:
 * a thin, always-visible strip with a `.term-label` (`design-language.md`)
 * running vertically, and the pane's own icon above it. The whole strip is
 * one `<button>`, not just the icon — real usage flagged a target as small
 * as the icon alone as fiddly, and there's nothing else to click in a
 * collapsed rail anyway. `aria-label`/`title` carry the accessible name;
 * the visible icon and label are `aria-hidden` so they don't get
 * concatenated into it.
 *
 * The icon is the caller's own — `SparkIcon` for Sparkey, `Waves` for
 * Activity — the same one each pane's expanded header shows next to its
 * title, not a generic open/close chevron. A collapsed rail used to show a
 * direction-of-travel chevron instead; live feedback asked for this to read
 * as "this is the Sparkey/Activity rail" rather than just "something is
 * here, click to open."
 *
 * Rendered by `SparkeyPane`/`ActivityPane` themselves, inside their own
 * `ResizablePanel`, rather than by `WorkspaceShell` swapping in a
 * replacement — the pane's real content (composer draft, review state)
 * stays mounted underneath the whole time; only which of the two JSX
 * branches that pane's own render returns changes.
 *
 * Re-expanding is *also* available from `PaneCollapseButton`, floating on
 * the `ResizableHandle` this rail sits against — two affordances for the
 * same action isn't redundant here: the handle button is the one control
 * that's visible in both the collapsed and expanded state, so it's what a
 * person looks for first, while clicking the rail itself is what actually
 * happens when someone reaches for "the Sparkey column" without consciously
 * aiming for a specific control.
 */

import * as React from 'react';

import { cn } from '@/lib/utils';

export interface PaneRailProps {
  label: string;
  /** Which edge of the shell this pane's rail sits against. */
  side: 'left' | 'right';
  /** The pane's own icon — same one its expanded header shows beside the title. */
  icon: React.ComponentType<React.SVGProps<SVGSVGElement>>;
  onExpand?: () => void;
}

export function PaneRail({ label, side, icon: Icon, onExpand }: PaneRailProps): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onExpand}
      aria-label={`Show ${label}`}
      title={`Show ${label}`}
      className={cn(
        'bg-background hover:bg-accent flex h-full w-full flex-col items-center gap-3 py-3 transition-colors',
        side === 'left' ? 'border-r' : 'border-l'
      )}
    >
      <Icon className="text-primary h-4 w-4 shrink-0" aria-hidden="true" />
      {/* No `text-orientation: upright` — the default `mixed` orientation is
          what rotates each glyph onto its side, the actual look "vertical
          label" means here (a book-spine title), not stacked upright
          letters read one at a time. */}
      <span aria-hidden="true" className="term-label [writing-mode:vertical-rl]">
        {label}
      </span>
    </button>
  );
}
