/**
 * Resparkable's page paths — the UI counterpart to `api/endpoints.ts`.
 *
 * Same reasoning as that file: a `'use client'` component that hard-codes
 * `/resparkable/projects/${id}` is a rename waiting to break silently, and the whole
 * tier is meant to be relocatable by a host project. Nothing here imports
 * anything, so it is safe from any runtime including the proxy.
 *
 * `BASE` is the one string a fork would change to mount the brain somewhere else.
 * It must stay in step with `appProtectedRoutes` in `lib/app/protected-routes.ts`
 * — a mounted path that isn't listed there is a page that renders to signed-out
 * visitors before any handler gets a say.
 */

const BASE = '/resparkable';

export const RESPARKABLE_ROUTES = {
  BASE,

  TODAY: BASE,
  INBOX: `${BASE}/inbox`,
  SEARCH: `${BASE}/search`,
  CHAT: `${BASE}/chat`,
  SETTINGS: `${BASE}/settings`,

  PLAN: `${BASE}/plan`,
  /** One day of the planner. `day` is an ISO `YYYY-MM-DD`, resolved in the browser's zone. */
  planFor: (day: string): string => `${BASE}/plan?day=${encodeURIComponent(day)}`,

  /**
   * The PWA share-target landing page (phase 9, §8). Android's share sheet
   * opens `CAPTURE?title=…&text=…&url=…` (declared in `app/manifest.ts`);
   * nothing else links here — the capture drawer already covers every other
   * entry point, and a permanent nav link would be a second way to do what
   * `⌘/Ctrl+K` already does.
   */
  CAPTURE: `${BASE}/capture`,

  PROJECTS: `${BASE}/projects`,
  /** The project list narrowed to one status. No status means every project. */
  projectsWithStatus: (status: string): string =>
    `${BASE}/projects?status=${encodeURIComponent(status)}`,
  project: (id: string): string => `${BASE}/projects/${id}`,

  GOALS: `${BASE}/goals`,
  AREAS: `${BASE}/areas`,

  ENTITIES: `${BASE}/entities`,
  entity: (id: string): string => `${BASE}/entities/${id}`,

  DOCUMENTS: `${BASE}/documents`,
  CONNECTIONS: `${BASE}/connections`,

  GRAPH: `${BASE}/graph`,
  /** The graph opens focused on one node — never on the whole corpus (§9). */
  graphFocus: (type: string, id: string): string =>
    `${BASE}/graph?focusType=${encodeURIComponent(type)}&focus=${encodeURIComponent(id)}`,

  BOARDS: `${BASE}/boards`,
  board: (slug: string): string => `${BASE}/boards/${slug}`,

  /**
   * What other people have shared with me (§13, Release 2 phase 12).
   *
   * A section of its own rather than a filter on the existing lists, and that
   * is the design rather than a routing convenience: shared-in items must never
   * appear in Projects, Boards or Search, so that `WHERE userId = $1` stays an
   * unconditional invariant on every one of those. It is also the honest
   * product answer — a second brain's lists are a planning surface, and
   * somebody else's project sitting in "my projects" corrupts your own sense of
   * what you have committed to.
   */
  SHARED: `${BASE}/shared`,
  /** One shared item. `type` is the shareable type, not an arbitrary string. */
  sharedItem: (type: string, id: string): string =>
    `${BASE}/shared/${encodeURIComponent(type)}/${encodeURIComponent(id)}`,

  /**
   * The other direction: what this owner has shared out.
   *
   * `sharing` rather than `shared`, because the two words would be one typo
   * apart on a pair of routes that mean opposite things. The surface exists
   * because `ShareDialog` is only reachable through an item's own control, so
   * a share on an item that can no longer be opened had no way to be closed.
   */
  SHARING: `${BASE}/sharing`,

  /**
   * Where a share-invite email lands (§13, phase 13).
   *
   * Under `/resparkable`, so it is behind the session gate `proxy.ts` applies by
   * pathname prefix — a signed-out invitee is sent to sign in and returned here.
   * That is the whole authentication design of the accept flow: the token names
   * a grant, and the **session** proves the address, so there is nothing for an
   * unauthenticated visitor to do on this page.
   *
   * Deliberately NOT under `/s/`, which is the unauthenticated reader and must
   * stay the one path in the product that has no session at all.
   */
  invite: (token: string): string => `${BASE}/invite/${encodeURIComponent(token)}`,

  /**
   * Archived items, and what has gone quiet (§11, phase 8).
   *
   * **Deliberately not in the main nav.** §11 is explicit that the archived list
   * views and `?includeArchived=true` are the only two ways to reach archived
   * items — a permanent nav link to your own archive puts the things you decided
   * to stop thinking about back in front of you every day, which is the opposite
   * of what archiving is for. It is linked from Settings and from the monthly
   * review, both of which are places you go on purpose.
   */
  ARCHIVE: `${BASE}/archive`,

  /**
   * Obsidian import and export (§14, Release 3).
   *
   * In the nav rather than tucked behind Settings, unlike {@link ARCHIVE}. The
   * reasoning is the opposite one: "how do I get my data out" is a question
   * people ask *before* they commit to a tool, and an answer they have to go
   * looking for reads as an answer somebody would rather they did not find.
   */
  VAULT: `${BASE}/vault`,

  /**
   * Search prefilled from the layout's box. `includeArchived` is only ever
   * appended when true, so the common href stays exactly what it always was
   * and the flag reads as opt-in rather than as a default that got turned off.
   */
  searchFor: (query: string, includeArchived = false): string =>
    `${BASE}/search?q=${encodeURIComponent(query)}${includeArchived ? '&includeArchived=true' : ''}`,
} as const;
