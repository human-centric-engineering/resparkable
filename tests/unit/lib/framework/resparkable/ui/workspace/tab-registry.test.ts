/**
 * Unit Tests: the tab-kind registry.
 *
 * The "coverage" block mirrors `section-help.test.ts`'s: every route in
 * `RESPARKABLE_ROUTES` must resolve to exactly one tab kind, and every
 * route-backed kind must round-trip back to its own route. The rest defends
 * the specific claim the header comment makes — that matchers are mutually
 * exclusive, so an index route never also matches its own detail kind.
 *
 * @see lib/framework/resparkable/ui/workspace/tab-registry.ts
 */

import { describe, expect, it } from 'vitest';

import { RESPARKABLE_ROUTES } from '@/lib/framework/resparkable/ui/routes';
import {
  buildRouteForTab,
  defaultTitleForTab,
  iconForTab,
  mergeQueryParamsForTab,
  resolveTabForHref,
  resolveTabForPathname,
  TAB_KINDS,
  TAB_REGISTRY,
} from '@/lib/framework/resparkable/ui/workspace/tab-registry';

/**
 * Every static (non-function) route in `RESPARKABLE_ROUTES` that the new shell
 * still renders as a tab. `BASE` isn't a page. `CHAT` is deliberately
 * excluded: per the build plan, `/resparkable/chat` is retired with a
 * one-line redirect in Phase 8 rather than migrated forward — Sparkey
 * absorbs chat, so it never becomes a tab kind.
 */
const STATIC_ROUTES = (Object.entries(RESPARKABLE_ROUTES) as Array<[string, unknown]>).filter(
  (entry): entry is [string, string] =>
    typeof entry[1] === 'string' && entry[0] !== 'BASE' && entry[0] !== 'CHAT'
);

describe('coverage', () => {
  it.each(STATIC_ROUTES)('%s resolves to a tab kind', (_name, href) => {
    expect(resolveTabForPathname(href)).not.toBeNull();
  });

  it('accounts for every declared tab kind in TAB_REGISTRY', () => {
    for (const kind of TAB_KINDS) {
      expect(TAB_REGISTRY[kind].defaultTitle.length).toBeGreaterThan(0);
    }
  });

  it('every route-backed kind round-trips: buildRoute → matchRoute → the same kind', () => {
    for (const kind of TAB_KINDS) {
      const entry = TAB_REGISTRY[kind];
      if (!entry.routeBacked) continue;

      // A two-part address, unlike every other detail kind: a shared item is
      // addressed by `(entityType, entityId)` because the six shareable tables
      // have separate id spaces.
      const params =
        kind === 'sharedItem'
          ? { entityType: 'project', id: 'clx123' }
          : kind === 'project' || kind === 'entity' || kind === 'group'
            ? { id: 'clx123' }
            : kind === 'board'
              ? { slug: 'my-board' }
              : {};

      const href = buildRouteForTab(kind, params);
      expect(href).not.toBeNull();
      expect(resolveTabForPathname(href as string)?.kind).toBe(kind);
    }
  });
});

describe('resolveTabForPathname', () => {
  it('matches the index exactly, not a detail page', () => {
    expect(resolveTabForPathname(RESPARKABLE_ROUTES.PROJECTS)).toEqual({
      kind: 'projects',
      params: {},
    });
  });

  it('matches a detail page and captures its id', () => {
    expect(resolveTabForPathname(RESPARKABLE_ROUTES.project('clx123'))).toEqual({
      kind: 'project',
      params: { id: 'clx123' },
    });
  });

  it('captures a board slug', () => {
    expect(resolveTabForPathname(RESPARKABLE_ROUTES.board('my-board'))).toEqual({
      kind: 'board',
      params: { slug: 'my-board' },
    });
  });

  it('does not match a sibling route that merely shares a prefix', () => {
    expect(resolveTabForPathname('/resparkable/projects-archive')).toBeNull();
  });

  it('does not half-match a route nested deeper than a detail page', () => {
    expect(resolveTabForPathname('/resparkable/projects/clx123/subtask/1')).toBeNull();
  });

  it('matches Today exactly, not as a prefix of every route', () => {
    expect(resolveTabForPathname(RESPARKABLE_ROUTES.TODAY)).toEqual({ kind: 'today', params: {} });
    expect(resolveTabForPathname(RESPARKABLE_ROUTES.INBOX)?.kind).toBe('inbox');
  });

  it('returns null for a path outside Resparkable', () => {
    expect(resolveTabForPathname('/dashboard')).toBeNull();
  });

  it('has no route for note — the one launcher-only kind', () => {
    expect(TAB_REGISTRY.note.routeBacked).toBe(false);
    expect(buildRouteForTab('note')).toBeNull();
  });
});

describe('buildRouteForTab', () => {
  it('throws for a detail kind built without its required param', () => {
    expect(() => buildRouteForTab('project', {})).toThrow();
  });

  it('builds a graph focus URL only when both focus params are given', () => {
    expect(buildRouteForTab('graph', {})).toBe(RESPARKABLE_ROUTES.GRAPH);
    expect(buildRouteForTab('graph', { focusType: 'project', focus: 'clx1' })).toBe(
      RESPARKABLE_ROUTES.graphFocus('project', 'clx1')
    );
  });
});

describe('defaultTitleForTab', () => {
  it('gives every kind a non-empty default title', () => {
    for (const kind of TAB_KINDS) {
      expect(defaultTitleForTab(kind).length).toBeGreaterThan(0);
    }
  });
});

describe('iconForTab', () => {
  it('gives every kind an icon component', () => {
    for (const kind of TAB_KINDS) {
      expect(iconForTab(kind)).toBeTruthy();
    }
  });

  it('gives every detail kind the same icon as its index kind', () => {
    expect(iconForTab('project')).toBe(iconForTab('projects'));
    expect(iconForTab('board')).toBe(iconForTab('boards'));
    expect(iconForTab('entity')).toBe(iconForTab('entities'));
  });
});

describe('the filter params — mergeQueryParamsForTab and buildRouteForTab', () => {
  it('reads Plan\u2019s day off the query string', () => {
    expect(mergeQueryParamsForTab('plan', {}, new URLSearchParams('day=2026-01-05'))).toEqual({
      day: '2026-01-05',
    });
  });

  it('leaves Plan\u2019s params alone when there is no day, rather than writing undefined', () => {
    const params = {};

    // Identity: `syncRouteTab` runs on every searchParams change, and a fresh
    // object every time would replace the route tab's params with an equal
    // but different one on each render.
    expect(mergeQueryParamsForTab('plan', params, new URLSearchParams())).toBe(params);
  });

  it('reads Projects\u2019 status off the query string', () => {
    expect(mergeQueryParamsForTab('projects', {}, new URLSearchParams('status=paused'))).toEqual({
      status: 'paused',
    });
  });

  it('reads Search\u2019s includeArchived independently of the query, so the box survives a round trip', () => {
    expect(
      mergeQueryParamsForTab('search', {}, new URLSearchParams('includeArchived=true'))
    ).toEqual({ includeArchived: true });
  });

  it('reads both of Search\u2019s keys together', () => {
    expect(
      mergeQueryParamsForTab('search', {}, new URLSearchParams('q=roadmap&includeArchived=true'))
    ).toEqual({ query: 'roadmap', includeArchived: true });
  });

  it('treats any includeArchived value other than the literal "true" as off', () => {
    expect(mergeQueryParamsForTab('search', {}, new URLSearchParams('includeArchived=1'))).toEqual(
      {}
    );
  });

  it('builds Plan and Projects hrefs that carry the filter, and bare ones when it is absent', () => {
    expect(buildRouteForTab('plan', {})).toBe(RESPARKABLE_ROUTES.PLAN);
    expect(buildRouteForTab('plan', { day: '2026-01-05' })).toBe(
      RESPARKABLE_ROUTES.planFor('2026-01-05')
    );
    expect(buildRouteForTab('projects', {})).toBe(RESPARKABLE_ROUTES.PROJECTS);
    expect(buildRouteForTab('projects', { status: 'paused' })).toBe(
      RESPARKABLE_ROUTES.projectsWithStatus('paused')
    );
  });

  it('appends includeArchived to a Search href only when it is on', () => {
    expect(buildRouteForTab('search', { query: 'roadmap' })).toBe(
      RESPARKABLE_ROUTES.searchFor('roadmap')
    );
    expect(buildRouteForTab('search', { query: 'roadmap', includeArchived: true })).toBe(
      `${RESPARKABLE_ROUTES.searchFor('roadmap')}&includeArchived=true`
    );
  });

  it('still round-trips a filtered href back to its own kind', () => {
    for (const href of [
      buildRouteForTab('plan', { day: '2026-01-05' }),
      buildRouteForTab('projects', { status: 'paused' }),
    ]) {
      // `resolveTabForPathname` is pathname-only by design, so strip the
      // query the same way `route-tab-bridge.tsx` hands it over separately.
      const pathname = (href as string).split('?')[0];
      expect(resolveTabForPathname(pathname)).not.toBeNull();
    }
  });
});

/**
 * `resolveTabForHref` is what `workspace-link.tsx` calls, and it exists
 * because a link arrives as one string with its query attached where
 * `route-tab-bridge.tsx` gets the two separately. Dropping the query is the
 * failure mode worth guarding: it does not throw, it opens a Search tab with
 * no search in it.
 */
describe('resolveTabForHref', () => {
  it('resolves a plain pathname exactly as the pathname matcher does', () => {
    expect(resolveTabForHref(RESPARKABLE_ROUTES.INBOX)).toEqual({ kind: 'inbox', params: {} });
    expect(resolveTabForHref(RESPARKABLE_ROUTES.project('clx1'))).toEqual({
      kind: 'project',
      params: { id: 'clx1' },
    });
  });

  it("carries a kind's own query keys into its params", () => {
    expect(resolveTabForHref(RESPARKABLE_ROUTES.searchFor('roadmap'))).toEqual({
      kind: 'search',
      params: { query: 'roadmap' },
    });
    expect(resolveTabForHref(RESPARKABLE_ROUTES.searchFor('roadmap', true))).toEqual({
      kind: 'search',
      params: { query: 'roadmap', includeArchived: true },
    });
    expect(resolveTabForHref(RESPARKABLE_ROUTES.graphFocus('project', 'clx1'))).toEqual({
      kind: 'graph',
      params: { focusType: 'project', focus: 'clx1' },
    });
    expect(resolveTabForHref(RESPARKABLE_ROUTES.planFor('2026-01-05'))).toEqual({
      kind: 'plan',
      params: { day: '2026-01-05' },
    });
  });

  it('ignores a fragment rather than folding it into the last param', () => {
    expect(resolveTabForHref(`${RESPARKABLE_ROUTES.project('clx1')}#tasks`)).toEqual({
      kind: 'project',
      params: { id: 'clx1' },
    });
  });

  it('returns null for an href no tab kind owns, so the caller navigates for real', () => {
    expect(resolveTabForHref(RESPARKABLE_ROUTES.CHAT)).toBeNull();
    expect(resolveTabForHref('/admin')).toBeNull();
    expect(resolveTabForHref('https://example.com/resparkable/inbox')).toBeNull();
  });
});
