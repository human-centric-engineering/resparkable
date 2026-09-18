'use client';

/**
 * The workspaces a person can open, made available below the shell.
 *
 * The list is read once by the layout (server-side, so the header names the
 * workspace on the first paint) and needs to reach two very different places:
 * the switcher in the header, which gets it as a prop, and every capture
 * control in the tree, which does not. Prop-drilling it through Sparkey, the
 * pane tree and the mobile switcher to reach a textarea would touch a dozen
 * components that have no interest in workspaces, so it goes in a context.
 *
 * Deliberately not a fetch, and deliberately not state. It is a value that
 * arrived with the page, and treating it as anything more would put a second
 * source of truth about workspaces next to the URL.
 *
 * **A stale list is a harmless list.** Nothing here is trusted: a capture
 * naming a workspace the reader has since been removed from resolves to no
 * scope on the server and comes back a 404. The list decides what a menu
 * offers, never what a write is allowed to do.
 */

import * as React from 'react';

import type { OpenableSpaceWire } from '@/lib/framework/resparkable/ui/payloads';

const SpacesContext = React.createContext<OpenableSpaceWire[]>([]);

export function SpacesProvider({
  spaces,
  children,
}: {
  spaces: OpenableSpaceWire[];
  children: React.ReactNode;
}): React.ReactElement {
  return <SpacesContext.Provider value={spaces}>{children}</SpacesContext.Provider>;
}

/**
 * Every workspace the reader can open, personal first.
 *
 * Empty outside the shell, which is the honest answer for a component under
 * test or on a page with no workspace above it: no list means no choice to
 * offer, and capture falls back to the personal space, which is the default
 * anyway.
 */
export function useOpenableSpaces(): OpenableSpaceWire[] {
  return React.useContext(SpacesContext);
}
