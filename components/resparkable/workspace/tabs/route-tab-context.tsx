'use client';

/**
 * RouteTabMarker: "this content is the route-backed tab".
 *
 * The tree's one `source: 'route'` tab renders the real page under `app/`
 * rather than a tab adapter, and its identity is the browser URL. A control
 * inside it that has to leave the page (a permanent delete from a detail view)
 * may move the URL; a control anywhere else must not, because that would
 * replace what the route-backed tab is showing in some other pane.
 *
 * Stated positively, by `WorkspacePane` where it renders `routeContent`, rather
 * than inferred from the absence of a tab boundary: Sparkey, Activity and the
 * Launcher have no tab boundary either, and none of them is that page.
 */

import * as React from 'react';

const RouteTabContext = React.createContext(false);

export interface RouteTabMarkerProps {
  children: React.ReactNode;
}

export function RouteTabMarker({ children }: RouteTabMarkerProps): React.ReactElement {
  return <RouteTabContext.Provider value={true}>{children}</RouteTabContext.Provider>;
}

/** `true` inside the route-backed tab's content, `false` everywhere else. */
export function useIsRouteTab(): boolean {
  return React.useContext(RouteTabContext);
}
