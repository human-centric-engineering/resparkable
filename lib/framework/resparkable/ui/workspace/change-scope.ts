/**
 * What changed, and which tabs care.
 *
 * ## The gap this fills
 *
 * `tab-refresh-context.tsx` answers "refresh the tab I am in". That is the
 * right answer for a control rendered inside a tab, and the wrong answer for
 * everything else in the shell. Sparkey and Activity are *panes*, not tabs:
 * they sit beside the pane tree with no `TabRefreshBoundary` above them, so
 * `useResparkableRefresh()` falls back to `router.refresh()` there, which
 * re-renders the one route-backed tab and leaves every launcher-opened tab
 * exactly as stale as it was. Capturing a thought in Sparkey did not put it
 * in an open Inbox tab. Telling Sparkey to change a goal did not change the
 * goal on screen.
 *
 * The missing piece is not a wider refresh. It is a way for a write to say
 * *what it touched*, so the panes showing that thing can catch up and no
 * others have to.
 *
 * ## The vocabulary
 *
 * A {@link ResparkableChange} is a resource type plus, when the writer knows
 * it, the id of the one record. Both halves matter and they are subscribed to
 * differently:
 *
 * - A **list** shows every record of a type, so it wants "any goal changed".
 * - A **detail** shows one record, so it wants "goal `X` changed", and must
 *   not refetch because some unrelated goal moved.
 *
 * `keysForChange` bumps the type key always (that is the list's signal) and,
 * alongside it, either the specific id key or the {@link UNKNOWN_ID} key.
 * `keysForTab` subscribes a detail tab to its own id key *and* the unknown-id
 * key, so a writer that genuinely cannot name the record still reaches it.
 * That is the only reason the unknown key exists: a chat turn knows the
 * companion called `resparkable_upsert_goal`, but the stream reports which
 * tool ran, not what it returned, so no id is available to it.
 *
 * ## Why the tab table is written out rather than derived
 *
 * The honest input would be the endpoints a tab actually fetches, since that
 * is literally what is on screen. Deriving it would mean every `useTabFetch`
 * registering its endpoint upward with the boundary, which is a subscription
 * protocol and a re-render ordering problem, in exchange for removing a table
 * that a coverage test can hold to the same standard `section-help.ts` and
 * `tab-registry.ts` already hold theirs to. `change-scope.test.ts` asserts
 * every `TabKind` has an entry, so a new kind cannot arrive without one.
 *
 * Pure and import-light on purpose: this is read on the client, and the
 * capability slugs below are string literals rather than an import of
 * `capabilities/catalogue.ts`, which would pull the whole of
 * `validations.ts` into the browser bundle for a lookup table of nine
 * strings. `change-scope.test.ts` cross-checks every literal here against
 * `RESPARKABLE_CAPABILITY_SLUGS`, so the two cannot drift apart silently.
 */

import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import type { TabKind, TabParams } from '@/lib/framework/resparkable/ui/workspace/tab-registry';

/**
 * The resource types a write can touch, named after the thing a person would
 * say changed rather than after the table or the endpoint.
 *
 * `space` is the settings singleton. There is no `review` member: nothing in
 * the shell renders reviews in a tab, so a write that produced one has
 * nothing to invalidate.
 */
export type ResparkableChangeType =
  | 'thought'
  | 'task'
  | 'project'
  | 'goal'
  | 'area'
  | 'entity'
  | 'document'
  | 'board'
  | 'tag'
  | 'link'
  | 'timeBlock'
  | 'space';

export interface ResparkableChange {
  type: ResparkableChangeType;
  /** Absent when the writer cannot name the record. See the header comment. */
  id?: string;
}

/** Stands in for "a record of this type, but the writer could not say which". */
export const UNKNOWN_ID = '?';

/**
 * The revision keys a change bumps: the bare type, for lists, plus one
 * id-scoped key, for details.
 */
export function keysForChange(change: ResparkableChange): string[] {
  return [change.type, `${change.type}:${change.id ?? UNKNOWN_ID}`];
}

interface TabChangeScope {
  /**
   * Types this tab lists. Any change to one refreshes it, which is what a
   * list wants: a row it is showing may have moved, been added or gone.
   */
  collections: ResparkableChangeType[];
  /**
   * The single record this tab is *about*, if it is a detail tab. Named by
   * which of `TabParams` carries its id.
   */
  record?: { type: ResparkableChangeType; param: 'id' };
}

/**
 * One entry per `TabKind`, derived from what that tab's adapter actually
 * fetches rather than from what its name suggests. A few are worth saying out
 * loud:
 *
 * - `today` subscribes to `link` because the Today payload carries the
 *   unreviewed-suggestion count, and to `timeBlock` because it renders the
 *   day's blocks and the "Nothing blocked out" empty state. Neither is
 *   guessable from the tab's name, which is exactly why this table is written
 *   from what the payload actually contains.
 * - `project` and `board` subscribe to `task` as a collection, so any task
 *   write anywhere refreshes them. That is deliberate rather than sloppy:
 *   both render a task list, and scoping it per project would mean the
 *   writer knowing which project a task belongs to, which a triage button
 *   pressed three panes away does not.
 * - `board` has no `record` despite being a detail tab. Its param is a slug
 *   and a board write names an id, so the two would never match. It already
 *   fetches the whole boards list, so the collection key is the honest
 *   subscription anyway.
 * - `search` and `vault` subscribe to nothing. A result set is an answer to a
 *   question asked at a moment, and Vault renders two upload cards with no
 *   fetch at all. Neither has anything a change could invalidate.
 * - `capture` never renders as a launcher tab (see `tab-content.tsx`), so its
 *   empty entry exists to satisfy the exhaustive record, nothing more.
 */
const TAB_CHANGE_SCOPES: Record<TabKind, TabChangeScope> = {
  today: { collections: ['task', 'thought', 'goal', 'link', 'timeBlock'] },
  inbox: { collections: ['thought', 'project'] },
  plan: { collections: ['timeBlock', 'project', 'area'] },
  projects: { collections: ['project', 'area'] },
  project: { collections: ['area', 'task', 'link'], record: { type: 'project', param: 'id' } },
  goals: { collections: ['goal', 'area'] },
  areas: { collections: ['area'] },
  boards: { collections: ['board', 'project', 'tag'] },
  board: { collections: ['board', 'task', 'tag'] },
  documents: { collections: ['document'] },
  entities: { collections: ['entity'] },
  entity: { collections: ['link'], record: { type: 'entity', param: 'id' } },
  connections: { collections: ['link'] },
  graph: { collections: ['link'] },
  vault: { collections: [] },
  settings: { collections: ['space'] },
  archive: { collections: ['project', 'goal', 'task', 'thought', 'entity'] },
  search: { collections: [] },
  capture: { collections: [] },
  note: { collections: [], record: { type: 'thought', param: 'id' } },
};

/**
 * The revision keys a tab of this kind and params is affected by. Read by
 * `TabRefreshBoundary`, which sums their counters into the same generation a
 * local refresh bumps, so a broadcast and an in-tab mutation reach
 * `useTabFetch` by the one path.
 */
export function keysForTab(kind: TabKind, params: TabParams): string[] {
  // Defaulted rather than asserted non-null. `kind` reaches here from a tab in
  // `WorkspaceProvider`'s state, which is rehydrated by `useLocalStorage`'s
  // bare `JSON.parse` with no schema check — so a blob saved before a future
  // `TabKind` rename still carries the old name. An unguarded lookup would
  // throw inside `TabRefreshBoundary`, above `renderTab`, taking the whole
  // shell down rather than the one tab that cannot be rendered.
  const scope = TAB_CHANGE_SCOPES[kind] ?? { collections: [] };
  const keys: string[] = [...scope.collections];
  if (scope.record) {
    const id = params[scope.record.param];
    if (id) keys.push(`${scope.record.type}:${id}`);
    keys.push(`${scope.record.type}:${UNKNOWN_ID}`);
  }
  return keys;
}

/** Exported for the coverage test, so a new `TabKind` cannot arrive unscoped. */
export const TAB_CHANGE_SCOPE_KINDS = Object.keys(TAB_CHANGE_SCOPES) as TabKind[];

/**
 * What an agent tool call wrote, by capability slug.
 *
 * Only the writers appear. A read capability (`resparkable_search`,
 * `resparkable_get_snapshot`, `resparkable_ideate` and the rest) invalidates
 * nothing, and listing it with an empty array would invite the reader to
 * think the omission was an oversight rather than the point.
 *
 * None of these carry an id: the SSE stream reports which capability ran, not
 * what it returned (see `resparkable-chat.tsx` on why), so every change here
 * lands on the {@link UNKNOWN_ID} key.
 */
const CHANGES_BY_CAPABILITY: Record<string, ResparkableChangeType[]> = {
  resparkable_capture: ['thought'],
  resparkable_capture_context: ['thought'],
  resparkable_capture_for_token: ['thought'],
  // Triage turns a thought into a task, and may file it under a new project.
  resparkable_promote_thought: ['thought', 'task', 'project'],
  resparkable_upsert_task: ['task'],
  resparkable_upsert_project: ['project'],
  resparkable_upsert_area: ['area'],
  resparkable_upsert_goal: ['goal'],
  resparkable_upsert_entity: ['entity'],
  resparkable_upsert_time_block: ['timeBlock'],
  resparkable_link_entities: ['link'],
  // Rewrites task ranking rather than task content, but a reordered list is a
  // changed list as far as anything showing one is concerned.
  resparkable_reprioritise: ['task'],
};

/**
 * The type a generic, collection-driven writer just wrote.
 *
 * For the components that are handed a `RESPARKABLE_API` collection constant
 * rather than a domain noun — `ArchiveControls` and `ResourceFormBody` are the
 * two — and so cannot name their own change without this. `undefined` for a
 * collection with no tab showing it, which is a legitimate answer rather than
 * a gap: the caller then falls back to refreshing its own tab only.
 */
export function changeTypeForCollection(collection: string): ResparkableChangeType | undefined {
  return COLLECTION_CHANGE_TYPES[collection];
}

const COLLECTION_CHANGE_TYPES: Record<string, ResparkableChangeType> = {
  [RESPARKABLE_API.THOUGHTS]: 'thought',
  [RESPARKABLE_API.TASKS]: 'task',
  [RESPARKABLE_API.PROJECTS]: 'project',
  [RESPARKABLE_API.GOALS]: 'goal',
  [RESPARKABLE_API.AREAS]: 'area',
  [RESPARKABLE_API.ENTITIES]: 'entity',
  [RESPARKABLE_API.DOCUMENTS]: 'document',
  [RESPARKABLE_API.BOARDS]: 'board',
  [RESPARKABLE_API.TAGS]: 'tag',
  [RESPARKABLE_API.LINKS]: 'link',
  [RESPARKABLE_API.TIME_BLOCKS]: 'timeBlock',
  [RESPARKABLE_API.SPACE]: 'space',
};

/** Exported for the test that cross-checks these literals against the catalogue. */
export const WRITING_CAPABILITY_SLUGS = Object.keys(CHANGES_BY_CAPABILITY);

/**
 * The changes a completed chat turn implies, from the capability slugs the
 * stream reported. Deduped, because a turn that called `upsert_task` twice
 * changed tasks once as far as anything watching is concerned.
 */
export function changesForCapabilities(slugs: readonly string[]): ResparkableChange[] {
  const types = new Set<ResparkableChangeType>();
  for (const slug of slugs) {
    for (const type of CHANGES_BY_CAPABILITY[slug] ?? []) types.add(type);
  }
  return [...types].map((type) => ({ type }));
}
