/**
 * The group digest: its deterministic gather step, and the guard every digest
 * passes before it is stored (§23.8, phase 50).
 *
 * ## The constraint lives here, not in the prompt
 *
 * A digest over a group is the most natural place in the product for
 * surveillance to arrive wearing a helpful face, so "it never ranks members and
 * never frames a person as behind" is enforced in two places a model cannot
 * talk its way past:
 *
 *   1. **The gather carries no authorship at all.** Every row it returns is a
 *      title, a type and a date. `createdByUserId` is never selected, so no
 *      per-member count, ranking or "X has not contributed" can be computed from
 *      what the writer is handed, however unhelpful the writer is. A model that
 *      pasted its whole input into the digest would still name nobody.
 *   2. **The write refuses a digest that names a member or compares people**
 *      ({@link findGroupDigestViolations}), whoever wrote it: the workflow's
 *      agent, or a member posting to `/reviews` with the horizon by hand.
 *
 * The agent's guardrails say the same thing, and are the third line rather than
 * the first. Test 13h stubs the model to be maximally unhelpful precisely so
 * that it proves the first two.
 *
 * ## Group totals are allowed
 *
 * "Eleven tasks were finished this week" is about the group. It is the
 * per-member split that the digest refuses, and the gather cannot produce one.
 */

import { listEvents } from '@/lib/framework/resparkable/repo/events';
import { EMBEDDED_TYPES, type EmbeddedType } from '@/lib/framework/resparkable/repo/embeddings';
import { findGroupBySpaceId, listMemberContacts } from '@/lib/framework/resparkable/repo/groups';
import { countUnreviewedLinks, listUnreviewedLinks } from '@/lib/framework/resparkable/repo/links';
import type { SpaceScope } from '@/lib/framework/resparkable/repo/space-scope';
import { findLatestReview } from '@/lib/framework/resparkable/repo/reviews';
import { findSummaries } from '@/lib/framework/resparkable/repo/summaries';
import { listTasks } from '@/lib/framework/resparkable/repo/tasks';
import { getRecentWins } from '@/lib/framework/resparkable/services/recent-wins';
import {
  buildStaleDigest,
  type StaleSection,
} from '@/lib/framework/resparkable/services/stale-digest';
import { ValidationError } from '@/lib/api/errors';

/** The window a digest covers: the week that has just ended. */
export const GROUP_DIGEST_WINDOW_DAYS = 7;

/** How long an open task sits untouched before the digest calls it unclaimed. */
export const UNCLAIMED_AFTER_DAYS = 14;

/** Titles per section. A digest lists highlights, not the whole week. */
const SECTION_CAP = 15;

/** Events read for "what arrived". Bounded for the same reason recent wins is. */
const MAX_ARRIVAL_EVENTS = 200;

const DAY_MS = 24 * 60 * 60_000;

type SummarisableType = EmbeddedType | 'task';

function isSummarisable(type: string): type is SummarisableType {
  return type === 'task' || (EMBEDDED_TYPES as readonly string[]).includes(type);
}

/** One item in a section. No author, by construction: see the file header. */
export interface GroupDigestItem {
  entityType: string;
  title: string;
}

export interface GroupDigestInputs {
  windowStart: string;
  windowEnd: string;
  /** Completed in the window. Counts are for the whole group. */
  moved: { total: number; countsByType: Record<string, number>; items: GroupDigestItem[] };
  /** Captured or created in the window. */
  arrived: { total: number; countsByType: Record<string, number>; items: GroupDigestItem[] };
  /** Connections the sweep proposed that nobody has reviewed yet. */
  connections: { unreviewed: number; items: Array<{ from: string; to: string }> };
  /** Projects, goals and people gone quiet, from the stale digest. */
  stalled: StaleSection[];
  /** Open tasks nobody has touched in {@link UNCLAIMED_AFTER_DAYS} days. */
  unclaimed: Array<{ title: string; untouchedDays: number }>;
}

/**
 * Refused because the scope is a person's own brain. The digest is a group
 * artefact; a personal space has the weekly review.
 */
export class NotAGroupSpaceError extends ValidationError {
  constructor() {
    super('A group digest can only be written in a group workspace.');
    this.name = 'NotAGroupSpaceError';
  }
}

/** Refused because the text names a member or compares people. */
export class GroupDigestViolationError extends ValidationError {
  constructor(readonly violations: string[]) {
    super(
      `A group digest must not name members or compare them (${violations.join('; ')}). Rewrite it about the work, not the people.`
    );
    this.name = 'GroupDigestViolationError';
  }
}

/**
 * Gather a week of the group's work for the digest writer.
 *
 * A fixed number of queries, not one per row: recent wins, one event read and
 * one hydration per type for arrivals, two for connections, the stale digest,
 * and one task list.
 */
export async function buildGroupDigestInputs(
  scope: SpaceScope,
  now: Date = new Date()
): Promise<GroupDigestInputs> {
  // By the space, not the role: a grantee's viewer scope on somebody's personal
  // space is not `owner` either, and must not get a digest of that brain.
  if (scope.role === 'owner' || !(await findGroupBySpaceId(scope.spaceId))) {
    throw new NotAGroupSpaceError();
  }

  const since = new Date(now.getTime() - GROUP_DIGEST_WINDOW_DAYS * DAY_MS);
  const untouchedSince = new Date(now.getTime() - UNCLAIMED_AFTER_DAYS * DAY_MS);

  const [wins, arrivalEvents, unreviewed, links, stale, untouched] = await Promise.all([
    getRecentWins(scope, GROUP_DIGEST_WINDOW_DAYS, now),
    // Filtered in the query, so the cap bounds arrivals and not a mix of
    // arrivals and the sweep's system rows, which would undercount a busy week.
    listEvents(
      scope,
      { since, source: 'user', kinds: ['captured', 'created'] },
      { take: MAX_ARRIVAL_EVENTS }
    ),
    countUnreviewedLinks(scope, now),
    listUnreviewedLinks(scope, 5, now),
    buildStaleDigest(scope, now),
    listTasks(
      scope,
      { excludeStatuses: ['done', 'dropped'], untouchedSince },
      { take: SECTION_CAP }
    ),
  ]);

  // Only what a person did, filtered in the query above and again here so the
  // rule holds whatever the repo returns. A sweep's suggestions are
  // `source: 'system'` and are reported under connections, not as arrivals.
  const arrivals = arrivalEvents.filter(
    (event) => event.source === 'user' && (event.kind === 'captured' || event.kind === 'created')
  );

  const titles = await hydrateTitles(scope, [
    ...arrivals.map((event) => ({ entityType: event.entityType, entityId: event.entityId })),
    ...links.flatMap((link) => [
      { entityType: link.sourceType, entityId: link.sourceId },
      { entityType: link.targetType, entityId: link.targetId },
    ]),
  ]);

  const arrivedCounts: Record<string, number> = {};
  for (const event of arrivals) {
    arrivedCounts[event.entityType] = (arrivedCounts[event.entityType] ?? 0) + 1;
  }

  return {
    windowStart: since.toISOString(),
    windowEnd: now.toISOString(),
    moved: {
      total: wins.total,
      countsByType: wins.countsByType,
      items: wins.items
        .filter((item) => item.title !== null)
        .slice(0, SECTION_CAP)
        .map((item) => ({ entityType: item.entityType, title: item.title ?? '' })),
    },
    arrived: {
      total: arrivals.length,
      countsByType: arrivedCounts,
      items: arrivals
        .map((event) => ({
          entityType: event.entityType,
          title: titles.get(`${event.entityType}:${event.entityId}`) ?? null,
        }))
        .filter((item): item is GroupDigestItem => item.title !== null)
        .slice(0, SECTION_CAP),
    },
    connections: {
      unreviewed,
      items: links
        .map((link) => ({
          from: titles.get(`${link.sourceType}:${link.sourceId}`) ?? null,
          to: titles.get(`${link.targetType}:${link.targetId}`) ?? null,
        }))
        .filter(
          (pair): pair is { from: string; to: string } => pair.from !== null && pair.to !== null
        ),
    },
    stalled: stale.sections.filter((section) => section.rows.length > 0),
    unclaimed: untouched.map((task) => ({
      title: task.title,
      untouchedDays: Math.max(0, Math.floor((now.getTime() - task.updatedAt.getTime()) / DAY_MS)),
    })),
  };
}

/**
 * Titles for a batch of references, one query per type. Sensitive thoughts are
 * left out: they resolve to nothing and drop from the digest, the same way a
 * deleted row does.
 */
async function hydrateTitles(
  scope: SpaceScope,
  refs: Array<{ entityType: string; entityId: string }>
): Promise<Map<string, string>> {
  const idsByType = new Map<SummarisableType, Set<string>>();
  for (const ref of refs) {
    if (!isSummarisable(ref.entityType)) continue;
    const bucket = idsByType.get(ref.entityType) ?? new Set<string>();
    bucket.add(ref.entityId);
    idsByType.set(ref.entityType, bucket);
  }

  const hydrated = await Promise.all(
    [...idsByType.entries()].map(async ([entityType, ids]) => ({
      entityType,
      summaries: await findSummaries(scope, entityType, [...ids], true, true),
    }))
  );

  const titles = new Map<string, string>();
  for (const { entityType, summaries } of hydrated) {
    for (const summary of summaries) titles.set(`${entityType}:${summary.id}`, summary.title);
  }
  return titles;
}

/**
 * Phrasing that ranks people or frames someone as behind (§23.8). Matched on
 * the whole text, case-insensitively. Deliberately about people rather than
 * work: "the launch is behind schedule" is a fact about a project and passes.
 */
const COMPARATIVE_PATTERNS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /\b(most|least) (active|productive|prolific|engaged)\b/i, label: 'ranks activity' },
  { pattern: /\btop (contributor|performer)s?\b/i, label: 'names a top contributor' },
  { pattern: /\bleader ?board\b/i, label: 'leaderboard' },
  {
    pattern: /\b(has|have)(n['’]t| not) (contributed|posted|written|added)\b/i,
    label: 'says someone has not contributed',
  },
  { pattern: /\b(fallen|falling|fell|lagging|lags) behind\b/i, label: 'frames someone as behind' },
  { pattern: /\bcontributed (the )?(most|least)\b/i, label: 'compares contributions' },
  {
    pattern: /\b(wrote|added|created|completed|finished|captured) the (most|least)\b/i,
    label: 'compares contributions',
  },
];

/**
 * What is wrong with a digest's text, or an empty list when nothing is.
 *
 * A member is matched by their address, and by their display name when it has
 * at least two words, as a whole word, case-insensitively. A one-word name is
 * not matched, whether it is a first name inside a longer name or the whole
 * display name: "Will", "May" and "Mark" are ordinary words, and a guard that
 * refused every digest in a group with a Will in it would fail the run every
 * Monday after the model call had already been billed.
 */
export function findGroupDigestViolations(
  text: string,
  members: ReadonlyArray<{ name: string | null; email: string }>
): string[] {
  const violations = new Set<string>();

  for (const member of members) {
    const name = member.name?.trim() ?? '';
    const multiWord = /\s/.test(name) && name.length >= 3;
    const labels = [multiWord ? name : null, member.email.trim() || null].filter(
      (value): value is string => value !== null
    );
    if (labels.some((label) => wholeWord(label).test(text))) {
      violations.add('names a member');
    }
  }

  for (const { pattern, label } of COMPARATIVE_PATTERNS) {
    if (pattern.test(text)) violations.add(label);
  }

  return [...violations];
}

function wholeWord(value: string): RegExp {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, 'iu');
}

/**
 * Refuse a digest that is in the wrong place or says the wrong thing. Called by
 * `writeReview` for every `group_digest`, so the HTTP path and the workflow's
 * capability are held to the same rule.
 */
export async function assertGroupDigestAcceptable(scope: SpaceScope, text: string): Promise<void> {
  if (scope.role === 'owner') throw new NotAGroupSpaceError();
  const group = await findGroupBySpaceId(scope.spaceId);
  if (!group) throw new NotAGroupSpaceError();

  const violations = findGroupDigestViolations(text, await listMemberContacts(group.id));
  if (violations.length > 0) throw new GroupDigestViolationError(violations);
}

/** The digest as the group page shows it. */
export interface LatestGroupDigest {
  id: string;
  title: string;
  body: string;
  generatedAt: string;
}

/**
 * The newest digest in a group space, for the group page. `null` before the
 * first one, which is every group's first week and every quiet one after it.
 */
export async function getLatestGroupDigest(scope: SpaceScope): Promise<LatestGroupDigest | null> {
  const review = await findLatestReview(scope, 'group_digest');
  if (!review) return null;
  return {
    id: review.id,
    title: review.title,
    body: review.body,
    generatedAt: review.generatedAt.toISOString(),
  };
}
