/**
 * "Always knows my goals" — the block injected into every chat turn.
 *
 * Without it, the companion is an agent that *can* look things up. With it, the
 * agent already knows what the person is working towards before they finish
 * typing, which is the difference between a search box with a personality and
 * something worth talking to.
 *
 * ## The one rule that matters
 *
 * **`id` is a space and is never trusted; `request.userId` is the actor and
 * always is.** Until phase 47 this loader ignored `id` outright and read only
 * `request.userId`, which was the correct rule while a person had exactly one
 * brain: trusting a client-supplied `contextId` would have rendered one
 * person's goals into another person's prompt, and `buildContext` caches on
 * `type:id:userId`, so it would then have served that repeatedly.
 *
 * A group workspace makes ignoring `id` the wrong answer, because the context a
 * member needs in a group space is the GROUP's (§23.9) and the actor's id
 * cannot express it. So the loader now reads `id` and **resolves** it:
 * `resolveActiveSpaceScope` reads membership and returns nothing for a space
 * this person is not in, which becomes `''` here. The old guarantee is intact
 * and reached by a different road — a forged `contextId` yields no context
 * rather than somebody else's — and it no longer depends on the chat route
 * having pinned the field, which is what made the original rule necessary.
 *
 * The cache key needs no change: `type:id:userId` already carries the space in
 * `id`. Two members of one group get two entries for identical content, which
 * is a wasted cache slot rather than a leak, and collapsing it would mean
 * dropping the actor from a key whose whole job is keeping brains apart.
 *
 * The cost is one indexed membership read per turn in a group workspace, and
 * none at all in a personal one, where the resolver short-circuits.
 *
 * ## Why it has a hard cap
 *
 * This is injected on **every turn**, so its cost is per-message rather than
 * per-conversation, and it grows with the person's own data — the corpus that
 * only ever gets bigger. A user with sixty active projects would otherwise be
 * paying for sixty lines of context on every "thanks". `CONTEXT_CHAR_BUDGET`
 * bounds it; each section is capped first, so what survives truncation is a
 * balanced picture rather than the goals alone.
 *
 * ## What it deliberately does not carry
 *
 * No task notes, no thought bodies, no document text. Those are what
 * `resparkable_search` is for, and putting them here would spend the budget on
 * whatever happened to be recent rather than on what the person is trying to do.
 * The block is an orientation, not a corpus.
 */

import { resolveActiveSpaceScope } from '@/lib/framework/resparkable/services/membership';
import { buildSnapshot, type SnapshotPayload } from '@/lib/framework/resparkable/services/snapshot';
import { logger } from '@/lib/logging';

/**
 * ~1200 tokens (plan §5), measured in characters because that is what we can
 * count without a tokeniser on the hot path. Four characters per token is the
 * usual English approximation and errs on the side of a smaller block.
 */
const CONTEXT_CHAR_BUDGET = 4800;

/** Per-section caps, applied before the budget so truncation stays balanced. */
const MAX_GOALS = 8;
const MAX_PROJECTS = 8;
const MAX_TASKS = 5;
const MAX_AREAS = 6;

/**
 * Per-line cap, and it is the cap that actually keeps the block balanced.
 *
 * Titles are bounded at 500 characters by `titleSchema`, so the row caps alone
 * do not bound the block: eight goals and eight projects with long names is
 * already past the budget on their own, and the line loop below would then stop
 * before it ever reached `LOAD`, dropping the inbox count and the life areas,
 * which are the cheapest and most useful lines in the whole block.
 *
 * Truncating the line instead is safe here because **every id is rendered before
 * the prose on the line it belongs to** (`- <id> · <title> · <when>`), so a cut
 * tail never takes an id with it.
 */
const MAX_LINE_CHARS = 160;

/** Room reserved for the truncation notice, so the notice cannot breach the cap it announces. */
const TRUNCATION_NOTICE = '(Context truncated — use the tools for anything not shown above.)';

/** One rendered line, bounded. The ellipsis says the tail was cut rather than absent. */
function line(text: string): string {
  return text.length <= MAX_LINE_CHARS ? text : `${text.slice(0, MAX_LINE_CHARS - 1)}…`;
}

/**
 * The goal horizons worth carrying, longest first.
 *
 * Life and year goals are the "why" behind everything else and change rarely;
 * month and week goals are the current commitment. Quarter sits between and is
 * included — it is the horizon most people actually plan in.
 */
const HORIZON_ORDER = ['life', 'year', 'quarter', 'month', 'week'] as const;

function horizonRank(horizon: string): number {
  const index = HORIZON_ORDER.indexOf(horizon as (typeof HORIZON_ORDER)[number]);
  return index === -1 ? HORIZON_ORDER.length : index;
}

/** "in 4 days", "overdue by 2 days", "today" — never a bare date the model has to subtract. */
function relativeDays(days: number | null): string {
  if (days === null) return '';
  if (days === 0) return ' (today)';
  if (days < 0) return ` (overdue by ${Math.abs(days)}d)`;
  return ` (in ${days}d)`;
}

/**
 * Render the snapshot as the context block.
 *
 * Exported separately from the loader so it can be tested against a payload
 * without a database, and so the phase-7 briefing can reuse the same rendering
 * if it wants the same orientation.
 */
export function renderResparkableContext(snapshot: SnapshotPayload): string {
  const lines: string[] = [];

  // 1. Where and when they are. Every scheduling phrase the agent produces
  //    resolves in this zone, so stating it beats the model assuming UTC.
  lines.push(
    `Today is ${snapshot.today.weekday} ${snapshot.today.date} (ISO week ${snapshot.today.isoWeek}), timezone ${snapshot.timezone}.`
  );

  // 2. Goals, longest horizon first — the "why" before the "what".
  const goals = [...snapshot.goals.items]
    .sort((a, b) => horizonRank(a.horizon) - horizonRank(b.horizon))
    .slice(0, MAX_GOALS);
  if (goals.length > 0) {
    lines.push('', 'GOALS');
    for (const goal of goals) {
      lines.push(line(`- [${goal.horizon}] ${goal.title}${relativeDays(goal.daysUntilTarget)}`));
    }
    if (snapshot.goals.truncated || snapshot.goals.items.length > goals.length) {
      lines.push('- (more goals exist — search for them rather than assuming these are all)');
    }
  }

  // 3. Active projects with how long they have been quiet. `daysSinceActivity`
  //    is the input to `projectMomentum`, so it is the number that explains the
  //    ranking the agent is about to report.
  const projects = snapshot.projects.items.slice(0, MAX_PROJECTS);
  if (projects.length > 0) {
    lines.push('', 'ACTIVE PROJECTS (id · name · days since activity)');
    for (const project of projects) {
      const quiet =
        project.daysSinceActivity === null ? 'no activity yet' : `${project.daysSinceActivity}d`;
      lines.push(line(`- ${project.id} · ${project.name} · ${quiet}`));
    }
    if (snapshot.projects.truncated || snapshot.projects.items.length > projects.length) {
      lines.push('- (more projects exist)');
    }
  }

  // 4. The top of the ranking, with the scorer's own word for why. The agent
  //    reports this order; it does not produce it.
  const tasks = snapshot.topTasks.items.slice(0, MAX_TASKS);
  if (tasks.length > 0) {
    lines.push('', 'TOP TASKS (ranked by the scorer, not by you)');
    for (const task of tasks) {
      const why = task.dominantFactor ? ` · ${task.dominantFactor}` : '';
      const due = task.dueAt ? ` · due ${task.dueAt.slice(0, 10)}` : '';
      lines.push(line(`- ${task.id} · ${task.title}${due}${why}`));
    }
  }

  // 5. Load. What someone would want to know before agreeing to anything.
  lines.push(
    '',
    'LOAD',
    `- Inbox: ${snapshot.counts.inbox} un-triaged · open tasks: ${snapshot.counts.openTasks} · unreviewed connections: ${snapshot.counts.connections}`
  );

  // 6. The standing parts of their life: an orientation, not a scorecard. No
  //    hours, no targets: see design-principles.md.
  const areas = snapshot.areas.items.slice(0, MAX_AREAS);
  if (areas.length > 0) {
    lines.push('', 'LIFE', line(`- ${areas.map((area) => area.name).join(', ')}`));
  }

  if (snapshot.latestReview) {
    lines.push(
      '',
      // The id leads so a cut tail cannot take it: the agent can fetch the
      // review rather than paraphrase a half-title back at the person.
      line(
        `Last review: ${snapshot.latestReview.id} · ${snapshot.latestReview.horizon} (${snapshot.latestReview.generatedAt.slice(0, 10)}) — "${snapshot.latestReview.title}"`
      )
    );
  }

  const body = lines.join('\n');
  if (body.length <= CONTEXT_CHAR_BUDGET) return body;

  // The backstop, now that every line is individually bounded. Drop whole lines
  // from the end rather than cutting mid-line; the sections are ordered by how
  // much they orient, so what goes first is what matters least.
  //
  // The notice's own length is reserved up front — a cap that its own "you hit
  // the cap" message breaches is not a cap.
  const allowance = CONTEXT_CHAR_BUDGET - TRUNCATION_NOTICE.length - 2;
  const kept: string[] = [];
  let used = 0;
  for (const entry of lines) {
    if (used + entry.length + 1 > allowance) break;
    kept.push(entry);
    used += entry.length + 1;
  }
  kept.push('', TRUNCATION_NOTICE);
  return kept.join('\n');
}

/**
 * The registered loader.
 *
 * `id` is the workspace this turn is about, and it is a TARGET rather than an
 * authority: see the header for why that is now safe to read and was not
 * before.
 */
export async function loadResparkableContext(
  id: string,
  request: { userId?: string }
): Promise<string> {
  const userId = request.userId;
  // No actor, no context. Never a fallback to "some user" or to the id.
  if (!userId) return '';

  try {
    // Membership decides. A space this person is not in resolves to nothing,
    // and nothing renders as an empty block rather than as somebody else's
    // goals.
    const scope = await resolveActiveSpaceScope(userId, id || null);
    if (!scope) return '';

    return renderResparkableContext(await buildSnapshot(scope));
  } catch (error) {
    // `buildContext` already degrades a throwing contributor to a placeholder,
    // but it logs it as an unexplained failure. Logging here first names the
    // tier, and returning '' rather than rethrowing keeps a database blip from
    // being the reason someone's chat turn fails.
    logger.error('Resparkable context contributor failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return '';
  }
}
