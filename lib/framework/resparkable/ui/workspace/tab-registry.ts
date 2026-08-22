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

import {
  Archive,
  CalendarRange,
  Compass,
  FileText,
  FolderKanban,
  FolderSync,
  Inbox,
  LayoutGrid,
  Link2,
  PenLine,
  Search,
  Settings,
  Share2,
  StickyNote,
  Sun,
  Target,
  Users,
  type LucideIcon,
} from 'lucide-react';

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
  /**
   * `plan` — the ISO `YYYY-MM-DD` day on screen. Absent means "today",
   * resolved at render time rather than pinned here, so a tab left open
   * overnight still shows the current day rather than yesterday's.
   */
  day?: string;
  /** `projects` — the status filter. Absent means every project. */
  status?: string;
  /** `search` — whether the (keyword-only) archived corpus is included. */
  includeArchived?: boolean;
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
   * `project` tab starting as "Project" and becoming "Q3 Roadmap" once its
   * fetch resolves. Written by the four detail adapters
   * (`project`/`entity`/`board`/`note`) through `useWorkspace().setTabTitle`,
   * which resolves a tab by id alone so a *floating* detail tab names itself
   * too. Absent until that fetch lands, and absent for every index kind,
   * whose `defaultTitle` is already the real name.
   */
  title?: string;
}

export interface TabRegistryEntry {
  kind: TabKind;
  /** Shown in the tab strip until/unless `TabState.title` overrides it. */
  defaultTitle: string;
  /** Shown in the tab strip to the left of the label — see `iconForTab()`. */
  icon: LucideIcon;
  /** False only for `note` — the one kind with no URL of its own. */
  routeBacked: boolean;
  /** Route-backed only: does `pathname` belong to this kind, and with what params. */
  matchRoute?: (pathname: string) => TabParams | null;
  /** Route-backed only: the href for a tab of this kind with the given params. */
  buildRoute?: (params: TabParams) => string;
  /**
   * Route-backed only, and only for the kinds that read extra state out of
   * the query string rather than the pathname (`graph`'s `focusType`/
   * `focus`, `search`'s `q`) — `route-tab-bridge.tsx` is the one place with
   * access to `useSearchParams()`, but the per-kind keys live here, next to
   * each entry's own `buildRoute`, which already encodes the same keys.
   */
  mergeQueryParams?: (params: TabParams, searchParams: URLSearchParams) => TabParams;
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
    icon: Sun,
    routeBacked: true,
    matchRoute: exact(RESPARKABLE_ROUTES.TODAY),
    buildRoute: () => RESPARKABLE_ROUTES.TODAY,
  },
  inbox: {
    kind: 'inbox',
    defaultTitle: 'Inbox',
    icon: Inbox,
    routeBacked: true,
    matchRoute: exact(RESPARKABLE_ROUTES.INBOX),
    buildRoute: () => RESPARKABLE_ROUTES.INBOX,
  },
  plan: {
    kind: 'plan',
    defaultTitle: 'Plan',
    icon: CalendarRange,
    routeBacked: true,
    // `day` travels as `?day=`, same story as `graph`'s focus below: the
    // pathname matcher can't see it, so `route-tab-bridge.tsx` merges it in.
    matchRoute: exact(RESPARKABLE_ROUTES.PLAN),
    buildRoute: (params) =>
      params.day ? RESPARKABLE_ROUTES.planFor(params.day) : RESPARKABLE_ROUTES.PLAN,
    mergeQueryParams: (params, searchParams) => {
      const day = searchParams.get('day');
      return day ? { ...params, day } : params;
    },
  },
  projects: {
    kind: 'projects',
    defaultTitle: 'Projects',
    icon: FolderKanban,
    routeBacked: true,
    matchRoute: exact(RESPARKABLE_ROUTES.PROJECTS),
    buildRoute: (params) =>
      params.status
        ? RESPARKABLE_ROUTES.projectsWithStatus(params.status)
        : RESPARKABLE_ROUTES.PROJECTS,
    mergeQueryParams: (params, searchParams) => {
      const status = searchParams.get('status');
      return status ? { ...params, status } : params;
    },
  },
  project: {
    kind: 'project',
    defaultTitle: 'Project',
    icon: FolderKanban,
    routeBacked: true,
    matchRoute: detail(RESPARKABLE_ROUTES.PROJECTS, 'id'),
    buildRoute: (params) => RESPARKABLE_ROUTES.project(requireParam(params, 'id', 'project')),
  },
  goals: {
    kind: 'goals',
    defaultTitle: 'Goals',
    icon: Target,
    routeBacked: true,
    matchRoute: exact(RESPARKABLE_ROUTES.GOALS),
    buildRoute: () => RESPARKABLE_ROUTES.GOALS,
  },
  areas: {
    kind: 'areas',
    defaultTitle: 'Life',
    icon: Compass,
    routeBacked: true,
    matchRoute: exact(RESPARKABLE_ROUTES.AREAS),
    buildRoute: () => RESPARKABLE_ROUTES.AREAS,
  },
  boards: {
    kind: 'boards',
    defaultTitle: 'Boards',
    icon: LayoutGrid,
    routeBacked: true,
    matchRoute: exact(RESPARKABLE_ROUTES.BOARDS),
    buildRoute: () => RESPARKABLE_ROUTES.BOARDS,
  },
  board: {
    kind: 'board',
    defaultTitle: 'Board',
    icon: LayoutGrid,
    routeBacked: true,
    matchRoute: detail(RESPARKABLE_ROUTES.BOARDS, 'slug'),
    buildRoute: (params) => RESPARKABLE_ROUTES.board(requireParam(params, 'slug', 'board')),
  },
  documents: {
    kind: 'documents',
    defaultTitle: 'Documents',
    icon: FileText,
    routeBacked: true,
    matchRoute: exact(RESPARKABLE_ROUTES.DOCUMENTS),
    buildRoute: () => RESPARKABLE_ROUTES.DOCUMENTS,
  },
  entities: {
    kind: 'entities',
    defaultTitle: 'People',
    icon: Users,
    routeBacked: true,
    matchRoute: exact(RESPARKABLE_ROUTES.ENTITIES),
    buildRoute: () => RESPARKABLE_ROUTES.ENTITIES,
  },
  entity: {
    kind: 'entity',
    defaultTitle: 'Person',
    icon: Users,
    routeBacked: true,
    matchRoute: detail(RESPARKABLE_ROUTES.ENTITIES, 'id'),
    buildRoute: (params) => RESPARKABLE_ROUTES.entity(requireParam(params, 'id', 'entity')),
  },
  connections: {
    kind: 'connections',
    defaultTitle: 'Connections',
    icon: Link2,
    routeBacked: true,
    matchRoute: exact(RESPARKABLE_ROUTES.CONNECTIONS),
    buildRoute: () => RESPARKABLE_ROUTES.CONNECTIONS,
  },
  graph: {
    kind: 'graph',
    defaultTitle: 'Graph',
    icon: Share2,
    routeBacked: true,
    // Focus (`focusType`/`focus`) travels as a query string, which this
    // pathname-only matcher can't see — `route-tab-bridge.tsx` (Phase 8)
    // reads `useSearchParams()` itself and merges it in via `mergeQueryParams`.
    matchRoute: exact(RESPARKABLE_ROUTES.GRAPH),
    buildRoute: (params) =>
      params.focusType && params.focus
        ? RESPARKABLE_ROUTES.graphFocus(params.focusType, params.focus)
        : RESPARKABLE_ROUTES.GRAPH,
    mergeQueryParams: (params, searchParams) => {
      const focusType = searchParams.get('focusType');
      const focus = searchParams.get('focus');
      return focusType && focus ? { ...params, focusType, focus } : params;
    },
  },
  vault: {
    kind: 'vault',
    defaultTitle: 'Vault',
    icon: FolderSync,
    routeBacked: true,
    matchRoute: exact(RESPARKABLE_ROUTES.VAULT),
    buildRoute: () => RESPARKABLE_ROUTES.VAULT,
  },
  settings: {
    kind: 'settings',
    defaultTitle: 'Settings',
    icon: Settings,
    routeBacked: true,
    matchRoute: exact(RESPARKABLE_ROUTES.SETTINGS),
    buildRoute: () => RESPARKABLE_ROUTES.SETTINGS,
  },
  archive: {
    kind: 'archive',
    defaultTitle: 'Archive',
    icon: Archive,
    routeBacked: true,
    matchRoute: exact(RESPARKABLE_ROUTES.ARCHIVE),
    buildRoute: () => RESPARKABLE_ROUTES.ARCHIVE,
  },
  search: {
    kind: 'search',
    defaultTitle: 'Search',
    icon: Search,
    routeBacked: true,
    // Same story as `graph`: `q` is a query param, merged in via `mergeQueryParams`.
    matchRoute: exact(RESPARKABLE_ROUTES.SEARCH),
    buildRoute: (params) =>
      params.query
        ? RESPARKABLE_ROUTES.searchFor(params.query, params.includeArchived === true)
        : RESPARKABLE_ROUTES.SEARCH,
    mergeQueryParams: (params, searchParams) => {
      const query = searchParams.get('q');
      // Merged independently of `q`: `?includeArchived=true` with no query is
      // a legitimate (if empty) state, and dropping the flag whenever the
      // query is missing would silently untick the box on the way back.
      const includeArchived = searchParams.get('includeArchived') === 'true';
      const next = query ? { ...params, query } : params;
      return includeArchived ? { ...next, includeArchived } : next;
    },
  },
  capture: {
    kind: 'capture',
    defaultTitle: 'Capture',
    icon: PenLine,
    routeBacked: true,
    matchRoute: exact(RESPARKABLE_ROUTES.CAPTURE),
    buildRoute: () => RESPARKABLE_ROUTES.CAPTURE,
  },
  note: {
    kind: 'note',
    defaultTitle: 'Note',
    icon: StickyNote,
    routeBacked: false,
  },
};

/** Every kind, in registry-declaration order — for exhaustive coverage tests. */
export const TAB_KINDS: TabKind[] = Object.keys(TAB_REGISTRY) as TabKind[];

/**
 * Narrowed to the string-valued keys rather than `keyof TabParams`: the shape
 * now carries a `boolean` (`includeArchived`), and a route segment built from
 * one would be the string "true" sitting in a URL path.
 */
type StringTabParam = {
  [K in keyof TabParams]-?: TabParams[K] extends string | undefined ? K : never;
}[keyof TabParams];

function requireParam(params: TabParams, field: StringTabParam, kind: string): string {
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

/**
 * The kind and params a full `href` resolves to, query string included.
 *
 * `resolveTabForPathname` matches pathnames only, which is all
 * `route-tab-bridge.tsx` needs because it reads `useSearchParams()`
 * separately. A link, though, arrives as one string with everything in it
 * (`/resparkable/search?q=roadmap`), and dropping the query would open a
 * Search tab with no query in it. This is that resolver: split, match, then
 * merge the query keys the kind declares, so `WorkspaceLink` opens the tab
 * the href actually names.
 *
 * `null` for an href that belongs to no tab kind. Callers treat that as "this
 * is real navigation, leave it alone" rather than as an error: `/resparkable/chat`
 * is a redirect and external hrefs pass through here too.
 */
export function resolveTabForHref(href: string): { kind: TabKind; params: TabParams } | null {
  // Deliberately not `new URL(href)`: these are same-origin app paths, and
  // constructing a URL would need a base and would happily accept an absolute
  // href pointing somewhere else entirely.
  const [pathname, query = ''] = href.split('#')[0].split('?');
  const resolved = resolveTabForPathname(pathname);
  if (!resolved) return null;
  return {
    kind: resolved.kind,
    params: mergeQueryParamsForTab(resolved.kind, resolved.params, new URLSearchParams(query)),
  };
}

/** The href for a tab of this kind, or `null` for a kind with no route (`note`). */
export function buildRouteForTab(kind: TabKind, params: TabParams = EMPTY_PARAMS): string | null {
  return TAB_REGISTRY[kind].buildRoute?.(params) ?? null;
}

/**
 * Merges any extra query-string keys `kind` reads (`graph`'s `focusType`/
 * `focus`, `search`'s `q`) into `params`. A no-op for every other kind.
 */
export function mergeQueryParamsForTab(
  kind: TabKind,
  params: TabParams,
  searchParams: URLSearchParams
): TabParams {
  return TAB_REGISTRY[kind].mergeQueryParams?.(params, searchParams) ?? params;
}

/** The tab-strip label to show before (or absent) a title fetched from content. */
export function defaultTitleForTab(kind: TabKind): string {
  return TAB_REGISTRY[kind].defaultTitle;
}

/** The icon `TabStrip` shows to the left of a tab's label. */
export function iconForTab(kind: TabKind): LucideIcon {
  return TAB_REGISTRY[kind].icon;
}
