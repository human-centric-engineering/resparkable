/**
 * Unit Tests: the per-turn chat context block.
 *
 * This block is injected into **every** chat turn, which makes two of its
 * properties load-bearing in a way no other read in the tier is:
 *
 *   1. **It is per-user, and the user comes from `request.userId` alone.**
 *      `buildContext` caches on `type:id:userId`, and a loader that trusted `id`
 *      would render one person's goals into another person's prompt — then serve
 *      the cached answer for the rest of the TTL. The loader ignores `id`
 *      entirely; this asserts it by passing a *different* id and watching the
 *      scope that reaches the snapshot.
 *   2. **It is bounded.** Cost is per-message and grows with the person's own
 *      data, so an unbounded block is a bill that rises with use. The cap is
 *      asserted against a deliberately oversized brain.
 *
 * Test Coverage:
 * - The scope is minted from `request.userId`, never from the `id` argument
 * - An absent `userId` yields '' rather than anyone's context
 * - A throwing snapshot degrades to '' rather than failing the chat turn
 * - Goals are ordered longest-horizon first, whatever order they arrive in
 * - Life areas render as a single comma-joined line, capped
 * - Truncation is by whole lines and says so, so no id is ever cut in half
 * - The block stays under its character budget on an oversized brain
 *
 * @see lib/framework/resparkable/context/contributor.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/framework/resparkable/services/snapshot', () => ({ buildSnapshot: vi.fn() }));
// Only the membership READ. The resolver, the personal short-circuit and the
// scope mint are the real ones, because they are what decides whose brain the
// companion is talking about.
vi.mock('@/lib/framework/resparkable/repo/groups', () => ({ findMembershipBySpace: vi.fn() }));

import {
  loadResparkableContext,
  renderResparkableContext,
} from '@/lib/framework/resparkable/context/contributor';
import { findMembershipBySpace } from '@/lib/framework/resparkable/repo/groups';
import { buildSnapshot } from '@/lib/framework/resparkable/services/snapshot';
import type { SnapshotPayload } from '@/lib/framework/resparkable/services/snapshot';

const mocked = buildSnapshot as unknown as ReturnType<typeof vi.fn>;

function snapshot(overrides: Partial<SnapshotPayload> = {}): SnapshotPayload {
  return {
    generatedAt: '2026-08-04T09:00:00.000Z',
    timezone: 'Europe/London',
    workStyle: 'balanced',
    today: { date: '2026-08-04', weekday: 'Tuesday', isoWeek: 32 },
    counts: { inbox: 3, connections: 1, openTasks: 12 },
    goals: { items: [], truncated: false },
    projects: { items: [], truncated: false },
    topTasks: { items: [], truncated: false },
    areas: { items: [], truncated: false },
    latestReview: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('loadResparkableContext', () => {
  /**
   * The whole isolation story for this file, and it changed shape in phase 47
   * without changing what it guarantees.
   *
   * This loader used to ignore `id` outright, which was the right rule while a
   * person had one brain. A group workspace makes it the wrong one: the context
   * a member needs in a group space is the group's, and the actor's id cannot
   * express that. So `id` is now read and RESOLVED, and the guarantee is
   * reached by a different road: a `contextId` naming a space this person is
   * not in yields no context rather than somebody else's.
   */
  it("returns '' for a space the actor is not in, rather than that space's context", async () => {
    mocked.mockResolvedValue(snapshot());
    vi.mocked(findMembershipBySpace).mockResolvedValue(null);

    expect(await loadResparkableContext('spc_not_mine', { userId: 'user-a' })).toBe('');
    // Refused before the read, not filtered after it.
    expect(buildSnapshot).not.toHaveBeenCalled();
  });

  it("scopes to the actor's own space when the id names it", async () => {
    mocked.mockResolvedValue(snapshot());

    await loadResparkableContext('user-a', { userId: 'user-a' });

    expect(buildSnapshot).toHaveBeenCalledWith(expect.objectContaining({ spaceId: 'user-a' }));
    // A personal space costs no membership read, which is every turn for
    // everybody in no group.
    expect(findMembershipBySpace).not.toHaveBeenCalled();
  });

  it("scopes to the actor's own space when there is no id at all", async () => {
    mocked.mockResolvedValue(snapshot());

    await loadResparkableContext('', { userId: 'user-a' });

    expect(buildSnapshot).toHaveBeenCalledWith(expect.objectContaining({ spaceId: 'user-a' }));
  });

  it('scopes to the GROUP when the id names one the actor is in', async () => {
    mocked.mockResolvedValue(snapshot());
    const at = new Date('2026-09-01T10:00:00.000Z');
    vi.mocked(findMembershipBySpace).mockResolvedValue({
      id: 'mem_1',
      groupId: 'grp_1',
      userId: 'user-a',
      role: 'member',
      invitedByUserId: null,
      joinedAt: at,
      createdAt: at,
      updatedAt: at,
    } as never);

    await loadResparkableContext('spc_group_1', { userId: 'user-a' });

    // §23.9: the agent layer follows the space, not the actor. Sparkey is a
    // permanent pane, so the moment somebody opens a group workspace this is
    // live, and reading the actor's own goals there would be the companion
    // answering about the wrong brain.
    expect(buildSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ spaceId: 'spc_group_1', actorUserId: 'user-a' })
    );
  });

  it("returns '' when the run has no owner, rather than anyone's context", async () => {
    expect(await loadResparkableContext('user-a', {})).toBe('');
    expect(buildSnapshot).not.toHaveBeenCalled();
  });

  it('degrades to empty rather than failing the chat turn', async () => {
    mocked.mockRejectedValue(new Error('connection reset'));

    expect(await loadResparkableContext('ignored', { userId: 'user-a' })).toBe('');
  });

  it('degrades the same way when what was thrown is not an Error', async () => {
    // A rejected non-Error is what a driver-level failure looks like, and it is
    // the shape that turns a defensive `error.message` into a second throw.
    mocked.mockRejectedValue('a string, thrown');

    expect(await loadResparkableContext('ignored', { userId: 'user-a' })).toBe('');
  });
});

describe('renderResparkableContext', () => {
  it('leads with the date, week number and the timezone everything resolves in', () => {
    const block = renderResparkableContext(snapshot());

    expect(block).toContain('Tuesday 2026-08-04');
    expect(block).toContain('ISO week 32');
    expect(block).toContain('Europe/London');
  });

  it('orders goals longest horizon first, whatever order they arrive in', () => {
    const block = renderResparkableContext(
      snapshot({
        goals: {
          items: [
            {
              id: 'g1',
              title: 'Week goal',
              horizon: 'week',
              status: 'active',
              targetDate: null,
              daysUntilTarget: null,
            },
            {
              id: 'g2',
              title: 'Life goal',
              horizon: 'life',
              status: 'active',
              targetDate: null,
              daysUntilTarget: null,
            },
            {
              id: 'g3',
              title: 'Month goal',
              horizon: 'month',
              status: 'active',
              targetDate: null,
              daysUntilTarget: null,
            },
          ],
          truncated: false,
        },
      })
    );

    expect(block.indexOf('Life goal')).toBeLessThan(block.indexOf('Month goal'));
    expect(block.indexOf('Month goal')).toBeLessThan(block.indexOf('Week goal'));
  });

  it('renders a date as a distance, so the model never has to subtract', () => {
    const block = renderResparkableContext(
      snapshot({
        goals: {
          items: [
            {
              id: 'g1',
              title: 'Overdue',
              horizon: 'month',
              status: 'active',
              targetDate: '2026-07-01',
              daysUntilTarget: -4,
            },
            {
              id: 'g2',
              title: 'Soon',
              horizon: 'week',
              status: 'active',
              targetDate: '2026-08-08',
              daysUntilTarget: 4,
            },
          ],
          truncated: false,
        },
      })
    );

    expect(block).toContain('Overdue (overdue by 4d)');
    expect(block).toContain('Soon (in 4d)');
  });

  /**
   * The standing parts of someone's life, rendered as an orientation rather
   * than a scorecard: a single comma-joined line, not one line per area.
   */
  it('renders life areas as a single comma-joined line', () => {
    const block = renderResparkableContext(
      snapshot({
        areas: {
          items: [
            { id: 'a1', name: 'Health' },
            { id: 'a2', name: 'Family' },
            { id: 'a3', name: 'Work' },
          ],
          truncated: false,
        },
      })
    );

    expect(block).toContain('LIFE');
    expect(block).toContain('- Health, Family, Work');
  });

  it('omits the LIFE section entirely when there are no areas', () => {
    const block = renderResparkableContext(snapshot({ areas: { items: [], truncated: false } }));

    expect(block).not.toContain('LIFE');
  });

  it('caps the LIFE line to the first six areas', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ id: `a${i}`, name: `Area${i}` }));
    const block = renderResparkableContext(snapshot({ areas: { items: many, truncated: false } }));

    const lifeLine = block.split('\n').find((l) => l.startsWith('- Area0'));
    expect(lifeLine).toBeDefined();
    expect(lifeLine).not.toContain('Area6');
  });

  it('says "today" rather than "in 0d" for something due now', () => {
    const block = renderResparkableContext(
      snapshot({
        goals: {
          items: [
            {
              id: 'g1',
              title: 'Ship it',
              horizon: 'week',
              status: 'active',
              targetDate: '2026-08-04',
              daysUntilTarget: 0,
            },
          ],
          truncated: false,
        },
      })
    );

    expect(block).toContain('Ship it (today)');
  });

  it('sorts a horizon it does not recognise to the end rather than dropping it', () => {
    const block = renderResparkableContext(
      snapshot({
        goals: {
          items: [
            {
              id: 'g1',
              title: 'Made-up horizon',
              horizon: 'decade',
              status: 'active',
              targetDate: null,
              daysUntilTarget: null,
            },
            {
              id: 'g2',
              title: 'Life goal',
              horizon: 'life',
              status: 'active',
              targetDate: null,
              daysUntilTarget: null,
            },
          ],
          truncated: false,
        },
      })
    );

    // A goal the enum has grown past should still reach the agent — silently
    // dropping it is how someone's most important goal disappears after a
    // schema change nobody connected to this file.
    expect(block).toContain('Made-up horizon');
    expect(block.indexOf('Life goal')).toBeLessThan(block.indexOf('Made-up horizon'));
  });

  it('says a project has never been touched rather than reporting zero days', () => {
    const block = renderResparkableContext(
      snapshot({
        projects: {
          items: [
            {
              id: 'p1',
              name: 'Brand new',
              status: 'active',
              areaId: null,
              daysSinceActivity: null,
            },
          ],
          truncated: false,
        },
      })
    );

    // "0d" would read as "worked on today", which is the opposite of the truth.
    expect(block).toContain('Brand new · no activity yet');
  });

  it('renders a task with neither a due date nor a dominant factor', () => {
    const block = renderResparkableContext(
      snapshot({
        topTasks: {
          items: [
            {
              id: 't1',
              title: 'Something vague',
              status: 'todo',
              dueAt: null,
              estimateMinutes: null,
              projectId: null,
              priorityScore: 0.1,
              dominantFactor: null,
            },
          ],
          truncated: false,
        },
      })
    );

    expect(block).toContain('- t1 · Something vague');
    expect(block).not.toContain('due null');
  });

  it('names the last review, when there is one', () => {
    const block = renderResparkableContext(
      snapshot({
        latestReview: {
          id: 'rev_1',
          horizon: 'weekly',
          title: 'Week 31',
          generatedAt: '2026-07-28T09:00:00.000Z',
        },
      })
    );

    // The id leads the line so the agent can fetch the review rather than
    // paraphrasing a title back at the person — and so a cut tail cannot take
    // the id with it.
    expect(block).toContain('Last review: rev_1');
    expect(block).toContain('2026-07-28');
  });

  it('says the ranking is not the agent’s to produce', () => {
    const block = renderResparkableContext(
      snapshot({
        topTasks: {
          items: [
            {
              id: 't1',
              title: 'Email Priya',
              status: 'next',
              dueAt: '2026-08-05T00:00:00.000Z',
              estimateMinutes: 20,
              projectId: null,
              priorityScore: 0.8,
              dominantFactor: 'urgency',
            },
          ],
          truncated: false,
        },
      })
    );

    expect(block).toContain('ranked by the scorer, not by you');
    expect(block).toContain('t1 · Email Priya · due 2026-08-05 · urgency');
  });

  it('flags a truncated section so the agent searches rather than assuming', () => {
    const block = renderResparkableContext(
      snapshot({
        goals: {
          items: [
            {
              id: 'g1',
              title: 'One',
              horizon: 'year',
              status: 'active',
              targetDate: null,
              daysUntilTarget: null,
            },
          ],
          truncated: true,
        },
      })
    );

    expect(block).toContain('more goals exist');
  });

  /**
   * Two different bounds, and both matter.
   *
   * The per-section caps stop a corpus of four hundred projects becoming four
   * hundred lines. The character budget catches what they cannot: eight
   * projects is eight lines, and eight lines of pasted paragraph is still a
   * prompt nobody wants to pay for on every "thanks".
   */
  it('caps the number of rows per section however large the corpus', () => {
    const many = Array.from({ length: 400 }, (_, index) => ({
      id: `p${index}`,
      name: `Project ${index}`,
      status: 'active',
      areaId: null,
      daysSinceActivity: index,
    }));

    const block = renderResparkableContext(
      snapshot({ projects: { items: many, truncated: false } })
    );

    expect(block.split('\n').filter((line) => line.startsWith('- p'))).toHaveLength(8);
    // The section stopped at its cap, so say so — an agent that thinks it has
    // seen everything will answer "you have no project about X" with confidence.
    expect(block).toContain('more projects exist');
  });

  /**
   * The failure the per-line cap exists to prevent. Titles are bounded at 500
   * chars by `titleSchema`, so eight long goals plus eight long projects clears
   * the whole budget on their own — and without the line cap the loop would stop
   * before `LOAD`, dropping the inbox count, which is the cheapest and most
   * useful line in the block.
   */
  it('keeps the cheap high-value sections when the titles are long', () => {
    const long = (prefix: string) => `${prefix} ${'x'.repeat(480)}`;
    const block = renderResparkableContext(
      snapshot({
        goals: {
          items: Array.from({ length: 8 }, (_, i) => ({
            id: `g${i}`,
            title: long(`Goal ${i}`),
            horizon: 'year',
            status: 'active',
            targetDate: null,
            daysUntilTarget: null,
          })),
          truncated: false,
        },
        projects: {
          items: Array.from({ length: 8 }, (_, i) => ({
            id: `p${i}`,
            name: long(`Project ${i}`),
            status: 'active',
            areaId: null,
            daysSinceActivity: i,
          })),
          truncated: false,
        },
      })
    );

    expect(block.length).toBeLessThanOrEqual(4800);
    expect(block).toContain('LOAD');
    expect(block).toContain('Inbox:');
    // Every id still survives, because ids lead their line and only the tail
    // is cut.
    for (let i = 0; i < 8; i += 1) expect(block).toContain(`- p${i} · `);
  });

  it('cuts the tail of a long line, never the id at its head', () => {
    const block = renderResparkableContext(
      snapshot({
        topTasks: {
          items: [
            {
              id: 'task_abc',
              title: 'x'.repeat(500),
              status: 'todo',
              dueAt: null,
              estimateMinutes: null,
              projectId: null,
              priorityScore: 0.5,
              dominantFactor: 'urgency',
            },
          ],
          truncated: false,
        },
      })
    );

    const taskLine = block.split('\n').find((l) => l.startsWith('- task_abc'));
    expect(taskLine).toBeDefined();
    expect(taskLine).toContain('task_abc');
    expect(taskLine?.endsWith('…')).toBe(true);
    expect(taskLine?.length).toBeLessThanOrEqual(160);
  });

  it('reserves room for its own truncation notice inside the budget', () => {
    // A cap that its own "you hit the cap" message breaches is not a cap.
    const many = Array.from({ length: 8 }, (_, i) => ({
      id: `p${i}`,
      name: 'y'.repeat(150),
      status: 'active',
      areaId: null,
      daysSinceActivity: i,
    }));
    const block = renderResparkableContext(
      snapshot({
        projects: { items: many, truncated: false },
        goals: {
          items: Array.from({ length: 8 }, (_, i) => ({
            id: `g${i}`,
            title: 'z'.repeat(150),
            horizon: 'year',
            status: 'active',
            targetDate: null,
            daysUntilTarget: null,
          })),
          truncated: false,
        },
        areas: {
          items: Array.from({ length: 6 }, (_, i) => ({
            id: `a${i}`,
            name: 'w'.repeat(150),
          })),
          truncated: false,
        },
        topTasks: {
          items: Array.from({ length: 5 }, (_, i) => ({
            id: `t${i}`,
            title: 'v'.repeat(150),
            status: 'todo',
            dueAt: null,
            estimateMinutes: null,
            projectId: null,
            priorityScore: 0.5,
            dominantFactor: 'urgency',
          })),
          truncated: false,
        },
      })
    );

    expect(block.length).toBeLessThanOrEqual(4800);
  });
});
