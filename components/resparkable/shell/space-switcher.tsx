'use client';

/**
 * The workspace switcher: the one control that says which brain you are in.
 *
 * ## Why it is in the header and not the tab strip
 *
 * §24.2 settles this and the reasoning is not aesthetic. The tab strip already
 * answers one question, *which view of this brain*, and its state is held per
 * surface. Putting workspaces in the same strip would make one row answer two
 * questions at once, and the cost lands on the user: opening an item in
 * workspace B would seat its tab next to workspace A's, and closing a tab and
 * leaving a workspace would become the same gesture. Workspaces sit above the
 * strip because that is the level in the hierarchy they occupy.
 *
 * ## Switching is navigation, and that is the whole trick
 *
 * A switch is `router.push` to the same page with a different `?space=`. It is
 * not a state change, a fetch or a context update, which is what buys the three
 * properties §24.2 asked for and none of which had to be built: a workspace is
 * a link, the back button walks between workspaces, and two browser tabs can
 * hold two different ones.
 *
 * **Every other search param survives the switch.** Switching workspace while
 * looking at Tuesday should still be looking at Tuesday. The one exception is a
 * param naming a row id, and this component does not know which those are, so
 * it keeps everything: a stale id resolves to a 404 in the new workspace, which
 * is a visible wrong answer rather than a silent one.
 *
 * ## It renders only when there is something to switch to
 *
 * A user in no group has one workspace, and a switcher with one entry is a
 * control that costs header space to say something the header already says.
 * It appears the moment a second workspace exists, which is the moment it
 * starts meaning something.
 *
 * ## Personal is the absence of a param
 *
 * So switching back to personal REMOVES `?space=` rather than setting it to the
 * user id. Same URL as before groups existed, which is what keeps every
 * bookmark and emailed link resolving.
 *
 * @see .context/framework/resparkable/plan.md: §24.2
 * @see lib/framework/resparkable/ui/active-space.ts
 */

import * as React from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Check, ChevronsUpDown, User, Users } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SPACE_PARAM, readSpaceTarget } from '@/lib/framework/resparkable/ui/active-space';
import type { OpenableSpaceWire } from '@/lib/framework/resparkable/ui/payloads';

export interface SpaceSwitcherProps {
  /**
   * Read server-side by the layout, so the first paint already names the
   * workspace. A client fetch here would put a spinner in the header on every
   * cold load, for a list that changes about once a month.
   */
  spaces: OpenableSpaceWire[];
}

export function SpaceSwitcher({ spaces }: SpaceSwitcherProps): React.ReactElement | null {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const target = readSpaceTarget(searchParams);

  // An unknown target falls back to the first entry rather than rendering a
  // blank trigger. The page underneath is already 404ing in that case, and a
  // switcher that still names a workspace is what the user needs in order to
  // get out of it.
  const active = spaces.find((space) => space.spaceId === target) ?? spaces[0];

  if (spaces.length < 2 || !active) return null;

  const groups = spaces.filter((space) => space.kind === 'group');
  const personal = spaces.filter((space) => space.kind === 'personal');

  const switchTo = (space: OpenableSpaceWire): void => {
    const next = new URLSearchParams(searchParams);
    if (space.kind === 'personal') next.delete(SPACE_PARAM);
    else next.set(SPACE_PARAM, space.spaceId);

    const query = next.toString();
    router.push(query ? `${pathname}?${query}` : pathname);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="max-w-[12rem] justify-between gap-2"
          // The accessible name says what the control does AND where you are,
          // because a screen reader user gets no chevron and no visual grouping.
          aria-label={`Workspace: ${active.name}. Switch workspace`}
        >
          {active.kind === 'group' ? (
            <Users className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          ) : (
            <User className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          )}
          <span className="truncate">{active.name}</span>
          <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 opacity-60" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>Yours</DropdownMenuLabel>
        {personal.map((space) => (
          <SpaceItem
            key={space.spaceId}
            space={space}
            active={space.spaceId === active.spaceId}
            onSelect={switchTo}
          />
        ))}

        {groups.length > 0 && (
          <>
            <DropdownMenuSeparator />
            {/* Labelled by kind, in one list. A member should not have to know
                whose a workspace is in order to open it (§24.2). */}
            <DropdownMenuLabel>Groups</DropdownMenuLabel>
            {groups.map((space) => (
              <SpaceItem
                key={space.spaceId}
                space={space}
                active={space.spaceId === active.spaceId}
                onSelect={switchTo}
              />
            ))}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SpaceItem({
  space,
  active,
  onSelect,
}: {
  space: OpenableSpaceWire;
  active: boolean;
  onSelect: (space: OpenableSpaceWire) => void;
}): React.ReactElement {
  return (
    <DropdownMenuItem
      onSelect={() => onSelect(space)}
      className="flex items-center justify-between gap-2"
    >
      <span className="truncate">{space.name}</span>
      <span className="flex shrink-0 items-center gap-2">
        {/* The role is shown on group workspaces only. On a personal one it is
            always `owner`, and a label saying so would be noise. */}
        {space.kind === 'group' && (
          <span className="text-muted-foreground text-[11px] capitalize">{space.role}</span>
        )}
        {active && <Check className="h-3.5 w-3.5" aria-hidden="true" />}
      </span>
    </DropdownMenuItem>
  );
}
