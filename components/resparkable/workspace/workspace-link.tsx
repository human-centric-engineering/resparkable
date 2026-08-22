'use client';

/**
 * WorkspaceLink — an in-content link that opens a tab where a tab is what
 * "open this" means, and stays an ordinary link everywhere else.
 *
 * ## The disagreement this settles
 *
 * After the shell cutover the app held two answers to the same question at
 * once. `BoardTab`'s "All boards" called `openTab`, so it opened in the pane
 * you clicked from. `ProjectDetail`'s area breadcrumb, `EntityChip`, and
 * every list row were still plain `<Link>`s, so they moved the browser URL,
 * which the route bridge turns into the tree's single route-backed tab. In
 * one pane that difference is invisible. In two it is the whole thing:
 * clicking a project link inside a launcher-opened Board tab in the right
 * pane replaced whatever the *left* pane was showing, and left the pane you
 * clicked in untouched. The thing you asked for opened somewhere you were
 * not looking.
 *
 * Decided once, here: **inside the workspace, an in-content link opens a
 * tab.** A tabbed shell's answer to "open this" is a tab, and it opens where
 * the click happened.
 *
 * ## Why this is an `<a href>` and not a button
 *
 * Because it is still a link, and everything a person expects of one has to
 * keep working. The real href is on the element, so ⌘/Ctrl-click and
 * middle-click open a genuine browser tab at that URL (which loads the shell
 * with that route as its route-backed tab, exactly as a bookmark does),
 * "Copy link address" copies something real, the status bar shows a
 * destination, and a screen reader announces a link. Only an unmodified
 * primary click is intercepted, which is the same contract Next's own `Link`
 * has with the browser.
 *
 * ## Where it degrades, and why that is the point
 *
 * Three ways out, all of them ordinary `<Link>`:
 *
 * - **No workspace above it.** `/resparkable/capture`, or a component under
 *   test with no shell around it. There is no pane to open a tab in.
 * - **An href that resolves to no tab kind.** `/resparkable/chat` (a
 *   redirect), or anything outside `/resparkable`. Real navigation is the
 *   only correct answer.
 * - **`external`.** An opt-out for a link that should genuinely leave, kept
 *   explicit so a caller has to mean it.
 *
 * So adopting this in a shared view component is safe: on its own page it
 * behaves precisely as the `<Link>` it replaced, and inside a tab it stops
 * acting on a pane the person was not looking at.
 *
 * ## Where the rule stops
 *
 * Content, not chrome. `ResparkableAppHeader`'s brand mark stays a real
 * `<Link>` and its search box stays a real `router.push`, both deliberately:
 * they sit above the pane tree rather than inside any pane, so "the pane you
 * clicked from" does not mean anything for them, and the header is the one
 * place where moving the actual URL is the point. The rule this component
 * settles is about a link rendered *inside* a tab's content, which is where
 * the two behaviours disagreed.
 */

import * as React from 'react';
import Link from 'next/link';

import { useOptionalWorkspace } from '@/components/resparkable/workspace/workspace-context';
import { resolveTabForHref } from '@/lib/framework/resparkable/ui/workspace/tab-registry';

export interface WorkspaceLinkProps extends Omit<
  React.ComponentPropsWithoutRef<'a'>,
  'href' | 'onClick'
> {
  href: string;
  /** Forces ordinary navigation. For a destination that really should leave. */
  external?: boolean;
  /** Runs before the tab opens. Use it to close a dialog or a sheet the link sits in. */
  onNavigate?: () => void;
  children: React.ReactNode;
}

/**
 * The browser is already doing something else with this click: a modifier is
 * held (new tab, new window, download, save), it is not the primary button,
 * or a handler upstream has claimed it. Mirrors Next's own `Link`.
 */
function browserWillHandle(event: React.MouseEvent<HTMLAnchorElement>): boolean {
  return (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  );
}

export function WorkspaceLink({
  href,
  external = false,
  onNavigate,
  children,
  ...rest
}: WorkspaceLinkProps): React.ReactElement {
  const workspace = useOptionalWorkspace();
  const target = React.useMemo(() => (external ? null : resolveTabForHref(href)), [external, href]);

  // `rest` is spread first, deliberately: `<Button asChild>` and friends wrap
  // this in a Radix `Slot`, which passes its own props down, and a `className`
  // or `onClick` arriving that way must not silently replace the handler this
  // component exists to install. Ours win.
  if (!workspace || !target) {
    return (
      <Link {...rest} href={href} onClick={onNavigate}>
        {children}
      </Link>
    );
  }

  return (
    <a
      {...rest}
      href={href}
      onClick={(event) => {
        if (browserWillHandle(event)) return;
        event.preventDefault();
        onNavigate?.();
        workspace.openTab(target.kind, target.params);
      }}
    >
      {children}
    </a>
  );
}
