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

      const params =
        kind === 'project' || kind === 'entity'
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
