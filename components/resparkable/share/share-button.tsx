'use client';

/**
 * ShareButton — the control that opens `ShareDialog`, and the state it needs.
 *
 * ## Why this exists rather than five copies of three lines
 *
 * Every shareable surface needs the same three things: a piece of `open` state,
 * a button, and a mounted `ShareDialog`. Release 2 shipped two of them by hand
 * (the project detail page and the board header) and the other four shareable
 * types shipped with no affordance at all, which is the gap this closes. Five
 * hand-rolled copies is how one of them ends up with a different label, a
 * missing `aria-label`, or a dialog that never gets the `entityType` right.
 * That last one is now the type's job rather than this comment's:
 * `ShareDialogProps.entityType` is `ResparkableShareableType`, so a typo or a
 * `thought` fails to compile instead of failing at the grants POST.
 *
 * The dialog itself is unchanged and stays the place all the reasoning lives.
 * This is a wrapper.
 *
 * ## Where the control goes, and the three places it deliberately does not
 *
 * §13's list is `area`, `goal`, `project`, `review`, `board`, `task`, and not
 * `thought`. Five of the six have a control:
 *
 *   | Type      | Where                                                        |
 *   | --------- | ------------------------------------------------------------ |
 *   | `area`    | the row on Life (`areas-view.tsx`)                           |
 *   | `goal`    | the node in the goal tree (`goals-view.tsx`)                  |
 *   | `project` | the project detail header (`project-detail.tsx`)              |
 *   | `board`   | the board header (`board-view.tsx`)                           |
 *   | `task`    | the card detail sheet (`card-detail-sheet.tsx`)               |
 *   | `review`  | nowhere, on purpose. See below                                |
 *
 * Three omissions, all decisions rather than oversights:
 *
 *   • **`TaskRow` has no share button**, so a task is shared from its card and
 *     not from a ranked list. That component's own docblock is the reason: a
 *     ranked list is a decision aid, everything on the row has to help make the
 *     decision, and "a row that shows everything shows nothing". §13's stated
 *     reason for making `task` shareable at all was §12's, that a board is
 *     worthless if you cannot hand somebody a single card, and the card is
 *     exactly where this puts it.
 *   • **`review` has none anywhere**, because regeneration writes a new row
 *     and a link minted on today's briefing would outlive the only surface
 *     that could revoke it. It waits for an owner-side "things I have shared"
 *     page. `briefing-card.tsx` carries the full reasoning at the point where
 *     the button would otherwise go, and its test asserts the absence.
 *   • **A `thought` has no share button anywhere**, because it is not
 *     shareable and that is a feature (§13). The raw capture inbox is the
 *     likeliest place for something its author would be mortified to leak.
 *     Promote it to a task first, which is the workflow regardless.
 *
 * ## Dense rows get the icon, headers get the word
 *
 * `compact` matches `ArchiveControls`, which sits next to this on every list row
 * and made the same call. An icon-only button carries its name in `aria-label`
 * and that label names the item, so a screen reader hears "Share Career" rather
 * than the fifth "Share" on the page.
 */

import * as React from 'react';
import { Share2 } from 'lucide-react';

import { ShareDialog, type ShareDialogProps } from '@/components/resparkable/share/share-dialog';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface ShareButtonProps extends Pick<
  ShareDialogProps,
  'entityType' | 'entityId' | 'title' | 'filterBoard'
> {
  /** Icon-only, for a list row that already carries three other controls. */
  compact?: boolean;
  /** Applied to the button, not the dialog — headers position their own. */
  className?: string;
  /** Forwarded to the dialog, so a snapshot can reload the surface behind it. */
  onSnapshot?: ShareDialogProps['onSnapshot'];
}

export function ShareButton({
  entityType,
  entityId,
  title,
  filterBoard,
  compact = false,
  className,
  onSnapshot,
}: ShareButtonProps): React.ReactElement {
  const [open, setOpen] = React.useState(false);

  return (
    <>
      <Button
        type="button"
        variant={compact ? 'ghost' : 'outline'}
        size="sm"
        className={cn(className)}
        // Always set, not only when compact: the label names the item, and on a
        // page with six of these the visible word "Share" alone does not.
        aria-label={`Share ${title}`}
        onClick={() => setOpen(true)}
      >
        <Share2 className={cn('h-3.5 w-3.5', !compact && 'mr-1.5')} aria-hidden="true" />
        {!compact && 'Share'}
      </Button>

      <ShareDialog
        open={open}
        onOpenChange={setOpen}
        entityType={entityType}
        entityId={entityId}
        title={title}
        {...(filterBoard ? { filterBoard } : {})}
        {...(onSnapshot ? { onSnapshot } : {})}
      />
    </>
  );
}
