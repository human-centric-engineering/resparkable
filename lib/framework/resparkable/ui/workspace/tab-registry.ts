/**
 * The tab-kind registry — one entry per distinct kind of Workspace tab, and
 * the only place that says how a kind maps onto a route (for the kinds that
 * have one) and what a tab of that kind is called before its content has
 * loaded.
 *
 * Every existing `/resparkable/**` page keeps its own `page.tsx` (see the
 * build plan's "route-backed vs. launcher-opened tabs" section) — this
 * registry is what lets `route-tab-bridge.tsx` turn a pathname into a tab,
 * and what lets the launcher turn a tab kind back into a route to navigate
 * to. `note` is the one kind with no route of its own: a hand-edited
 * thought/note body, opened only from the launcher or from a link inside
 * another tab.
 *
 * Matching is deliberately unambiguous rather than longest-match-wins (the
 * pattern `section-help.ts` needs, because its entries overlap on purpose —
 * a project detail page falls through to the Projects entry). Here every
 * index kind's matcher requires an exact path and every detail kind's
 * matcher requires a further segment, so at most one entry ever matches a
 * given pathname. `tab-registry.test.ts`'s "coverage" describe block asserts
 * this registry accounts for every route in `RESPARKABLE_ROUTES`, the same
 * way `section-help.test.ts` asserts coverage of the nav.
 */

import { RESPARKABLE_ROUTES } from '@/lib/framework/resparkable/ui/routes';

export type TabKind =
  | 'today'
  | 'inbox'
  | 'plan'
  | 'projects'
  | 'project'
  | 'goals'
  | 'areas'
  | 'boards'
  | 'board'
  | 'documents'
  | 'entities'
  | 'entity'
  | 'connections'
  | 'graph'
  | 'vault'
  | 'settings'
  | 'archive'
  | 'search'
  | 'capture'
  | 'note';

/**
 * The small, flat set of fields any tab kind might need. Kept as one shape
 * (rather than a kind-specific union) because `TabState.params` is what gets
 * round-tripped through `useLocalStorage`'s `JSON.stringify`/`JSON.parse` —
 * a union would survive that trip fine, but a single flat shape keeps the
 * dedupe comparison in `split-tree.ts` a plain field-by-field check instead
 * of a kind-aware one.
 */
export interface TabParams {
  /** `project`, `entity`, `note` — the record's id. */
  id?: string;
  /** `board` — the board's slug. */
  slug?: string;
  /** `search` — the query string. */
  query?: string;
  /** `graph` — which node it opens focused on, and its type. */
  focusType?: string;
  focus?: string;
}

/** Every field defaulted, so two tabs with the same kind compare by simple equality. */
const EMPTY_PARAMS: TabParams = {};

export type TabSource = 'route' | 'launcher';

export interface TabState {
  id: string;
  kind: TabKind;
  params: TabParams;
  source: TabSource;
  /**
   * Overrides the registry's `defaultTitle` once real content is known — a
   * `project` tab starts as "Project" and becomes "Q3 Roadmap" once its
   * fetch resolves. Never set for kinds with a fixed title.
   */
  title?: string;
}

export interface TabRegistryEntry {
  kind: TabKind;
  /** Shown in the tab strip until/unless `TabState.title` overrides it. */
  defaultTitle: string;
  /** False only for `note` — the one kind with no URL of its own. */
  routeBacked: boolean;
  /** Route-backed only: does `pathname` belong to this kind, and with what params. */
  matchRoute?: (pathname: string) => TabParams | null;
  /** Route-backed only: the href for a tab of this kind with the given params. */
  buildRoute?: (params: TabParams) => string;
}

/** `pathname` is exactly `href` — an index page, never a detail page. */
function exact(href: string): (pathname: string) => TabParams | null {
  return (pathname) => (pathname === href ? EMPTY_PARAMS : null);
}

/** `pathname` is `href/<segment>` — a detail page, captured as `field`. */
function detail(href: string, field: 'id' | 'slug'): (pathname: string) => TabParams | null {
  const prefix = `${href}/`;
  return (pathname) => {
    if (!pathname.startsWith(prefix)) return null;
    const rest = pathname.slice(prefix.length);
    // A further `/` means this belongs to some deeper route this registry
    // doesn't model yet, not to the detail kind — don't half-match it.
    if (rest.length === 0 || rest.includes('/')) return null;
    return { [field]: rest };
  };
}

export const TAB_REGISTRY: Record<TabKind, TabRegistryEntry> = {
  today: {
    kind: 'today',
    defaultTitle: 'Today',
    routeBacked: true,
    matchRoute: exact(RESPARKABLE_ROUTES.TODAY),
    buildRoute: () => RESPARKABLE_ROUTES.TODAY,
  },
  inbox: {
    kind: 'inbox',
    defaultTitle: 'Inbox',
    routeBacked: true,
    matchRoute: exact(RESPARKABLE_ROUTES.INBOX),
    buildRoute: () => RESPARKABLE_ROUTES.INBOX,
  },
  plan: {
    kind: 'plan',
    defaultTitle: 'Plan',
    routeBacked: true,
    matchRoute: exact(RESPARKABLE_ROUTES.PLAN),
    buildRoute: () => RESPARKABLE_ROUTES.PLAN,
  },
  projects: {
    kind: 'projects',
    defaultTitle: 'Projects',
    routeBacked: true,
    matchRoute: exact(RESPARKABLE_ROUTES.PROJECTS),
    buildRoute: () => RESPARKABLE_ROUTES.PROJECTS,
  },
  project: {
    kind: 'project',
    defaultTitle: 'Project',
    routeBacked: true,
    matchRoute: detail(RESPARKABLE_ROUTES.PROJECTS, 'id'),
    buildRoute: (params) => RESPARKABLE_ROUTES.project(requireParam(params, 'id', 'project')),
  },
  goals: {
    kind: 'goals',
    defaultTitle: 'Goals',
    routeBacked: true,
    matchRoute: exact(RESPARKABLE_ROUTES.GOALS),
    buildRoute: () => RESPARKABLE_ROUTES.GOALS,
  },
  areas: {
    kind: 'areas',
    defaultTitle: 'Life',
    routeBacked: true,
    matchRoute: exact(RESPARKABLE_ROUTES.AREAS),
    buildRoute: () => RESPARKABLE_ROUTES.AREAS,
  },
  boards: {
    kind: 'boards',
    defaultTitle: 'Boards',
    routeBacked: true,
    matchRoute: exact(RESPARKABLE_ROUTES.BOARDS),
    buildRoute: () => RESPARKABLE_ROUTES.BOARDS,
  },
  board: {
    kind: 'board',
    defaultTitle: 'Board',
    routeBacked: true,
    matchRoute: detail(RESPARKABLE_ROUTES.BOARDS, 'slug'),
    buildRoute: (params) => RESPARKABLE_ROUTES.board(requireParam(params, 'slug', 'board')),
  },
  documents: {
    kind: 'documents',
    defaultTitle: 'Documents',
    routeBacked: true,
    matchRoute: exact(RESPARKABLE_ROUTES.DOCUMENTS),
    buildRoute: () => RESPARKABLE_ROUTES.DOCUMENTS,
  },
  entities: {
    kind: 'entities',
    defaultTitle: 'People',
    routeBacked: true,
    matchRoute: exact(RESPARKABLE_ROUTES.ENTITIES),
    buildRoute: () => RESPARKABLE_ROUTES.ENTITIES,
  },
  entity: {
    kind: 'entity',
    defaultTitle: 'Person',
    routeBacked: true,
    matchRoute: detail(RESPARKABLE_ROUTES.ENTITIES, 'id'),
    buildRoute: (params) => RESPARKABLE_ROUTES.entity(requireParam(params, 'id', 'entity')),
  },
  connections: {
    kind: 'connections',
    defaultTitle: 'Connections',
    routeBacked: true,
    matchRoute: exact(RESPARKABLE_ROUTES.CONNECTIONS),
    buildRoute: () => RESPARKABLE_ROUTES.CONNECTIONS,
  },
  graph: {
    kind: 'graph',
    defaultTitle: 'Graph',
    routeBacked: true,
    // Focus (`focusType`/`focus`) travels as a query string, which this
    // pathname-only matcher can't see — `route-tab-bridge.tsx` (Phase 8)
    // reads `useSearchParams()` itself and merges it into the tab's params.
    matchRoute: exact(RESPARKABLE_ROUTES.GRAPH),
    buildRoute: (params) =>
      params.focusType && params.focus
        ? RESPARKABLE_ROUTES.graphFocus(params.focusType, params.focus)
        : RESPARKABLE_ROUTES.GRAPH,
  },
  vault: {
    kind: 'vault',
    defaultTitle: 'Vault',
    routeBacked: true,
    matchRoute: exact(RESPARKABLE_ROUTES.VAULT),
    buildRoute: () => RESPARKABLE_ROUTES.VAULT,
  },
  settings: {
    kind: 'settings',
    defaultTitle: 'Settings',
    routeBacked: true,
    matchRoute: exact(RESPARKABLE_ROUTES.SETTINGS),
    buildRoute: () => RESPARKABLE_ROUTES.SETTINGS,
  },
  archive: {
    kind: 'archive',
    defaultTitle: 'Archive',
    routeBacked: true,
    matchRoute: exact(RESPARKABLE_ROUTES.ARCHIVE),
    buildRoute: () => RESPARKABLE_ROUTES.ARCHIVE,
  },
  search: {
    kind: 'search',
    defaultTitle: 'Search',
    routeBacked: true,
    // Same story as `graph`: `q` is a query param, merged in by the bridge.
    matchRoute: exact(RESPARKABLE_ROUTES.SEARCH),
    buildRoute: (params) =>
      params.query ? RESPARKABLE_ROUTES.searchFor(params.query) : RESPARKABLE_ROUTES.SEARCH,
  },
  capture: {
    kind: 'capture',
    defaultTitle: 'Capture',
    routeBacked: true,
    matchRoute: exact(RESPARKABLE_ROUTES.CAPTURE),
    buildRoute: () => RESPARKABLE_ROUTES.CAPTURE,
  },
  note: {
    kind: 'note',
    defaultTitle: 'Note',
    routeBacked: false,
  },
};

/** Every kind, in registry-declaration order — for exhaustive coverage tests. */
export const TAB_KINDS: TabKind[] = Object.keys(TAB_REGISTRY) as TabKind[];

function requireParam(params: TabParams, field: keyof TabParams, kind: string): string {
  const value = params[field];
  if (!value) {
    throw new Error(`buildRoute for '${kind}' tab requires params.${field}`);
  }
  return value;
}

/**
 * The kind and params `pathname` resolves to, or `null` if it matches no
 * route-backed tab kind. Entries are mutually exclusive by construction
 * (see the header comment), so the first match is the only match.
 */
export function resolveTabForPathname(
  pathname: string
): { kind: TabKind; params: TabParams } | null {
  for (const kind of TAB_KINDS) {
    const entry = TAB_REGISTRY[kind];
    if (!entry.matchRoute) continue;
    const params = entry.matchRoute(pathname);
    if (params) return { kind, params };
  }
  return null;
}

/** The href for a tab of this kind, or `null` for a kind with no route (`note`). */
export function buildRouteForTab(kind: TabKind, params: TabParams = EMPTY_PARAMS): string | null {
  return TAB_REGISTRY[kind].buildRoute?.(params) ?? null;
}

/** The tab-strip label to show before (or absent) a title fetched from content. */
export function defaultTitleForTab(kind: TabKind): string {
  return TAB_REGISTRY[kind].defaultTitle;
}
