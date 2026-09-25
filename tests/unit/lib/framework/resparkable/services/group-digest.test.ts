/**
 * Test 13h: the digest is non-comparative (§23.8, phase 50).
 *
 * Given a group where one member wrote thirty items and another wrote one, the
 * digest that reaches the page contains no per-member count, no ranking, no
 * superlative about a member, and no phrasing that frames a member as behind.
 *
 * **The writer is stubbed to be maximally unhelpful**, and that is the point.
 * A test that used a well-behaved model would prove only that the prompt has
 * good manners. Two stubs stand in for the worst model we could be handed:
 *
 *   - one pastes its entire input into the digest verbatim, which proves the
 *     gather carries nothing a ranking could be built from;
 *   - one writes the ranking outright, which proves the write refuses it.
 *
 * Everything below the service is mocked at the repo boundary, with every event
 * row carrying a real `createdByUserId`: the authorship is there in the data,
 * and the assertion is that none of it comes out the other side.
 *
 * A group of thirty produces one digest run, not thirty: asserted on the job
 * vocabulary and on the handler, which queues exactly one execution per group.
 *
 * @see lib/framework/resparkable/services/group-digest.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/framework/resparkable/repo/events', () => ({ listEvents: vi.fn() }));
vi.mock('@/lib/framework/resparkable/repo/summaries', () => ({ findSummaries: vi.fn() }));
vi.mock('@/lib/framework/resparkable/repo/links', () => ({
  countUnreviewedLinks: vi.fn(),
  listUnreviewedLinks: vi.fn(),
}));
vi.mock('@/lib/framework/resparkable/repo/tasks', () => ({ listTasks: vi.fn() }));
vi.mock('@/lib/framework/resparkable/services/stale-digest', () => ({
  buildStaleDigest: vi.fn(),
}));
vi.mock('@/lib/framework/resparkable/repo/groups', () => ({
  findGroupBySpaceId: vi.fn(),
  listMemberContacts: vi.fn(),
}));
vi.mock('@/lib/framework/resparkable/repo/reviews', () => ({
  createReview: vi.fn(),
  findLatestReview: vi.fn(),
}));
vi.mock('@/lib/framework/resparkable/services/events', () => ({ recordResparkableEvent: vi.fn() }));
vi.mock('@/lib/framework/resparkable/services/space', () => ({ ensureResparkableSpace: vi.fn() }));
vi.mock('@/lib/framework/resparkable/repo/workflow-runs', () => ({
  queueResparkableWorkflowRun: vi.fn(),
}));

import { listEvents } from '@/lib/framework/resparkable/repo/events';
import { findGroupBySpaceId, listMemberContacts } from '@/lib/framework/resparkable/repo/groups';
import { countUnreviewedLinks, listUnreviewedLinks } from '@/lib/framework/resparkable/repo/links';
import { createReview, findLatestReview } from '@/lib/framework/resparkable/repo/reviews';
import { spaceScope, spaceScopeFor } from '@/lib/framework/resparkable/repo/space-scope';
import { findSummaries, type EntitySummary } from '@/lib/framework/resparkable/repo/summaries';
import { listTasks } from '@/lib/framework/resparkable/repo/tasks';
import { queueResparkableWorkflowRun } from '@/lib/framework/resparkable/repo/workflow-runs';
import { jobKindsForSpace } from '@/lib/framework/resparkable/queue/kinds';
import { runResparkableJob } from '@/lib/framework/resparkable/queue/handlers';
import {
  assertGroupDigestAcceptable,
  buildGroupDigestInputs,
  findGroupDigestViolations,
  getLatestGroupDigest,
  GroupDigestViolationError,
  NotAGroupSpaceError,
  type GroupDigestInputs,
} from '@/lib/framework/resparkable/services/group-digest';
import {
  buildStaleDigest,
  type StaleSection,
} from '@/lib/framework/resparkable/services/stale-digest';
import { writeReview } from '@/lib/framework/resparkable/services/reviews';
import type {
  ResparkableEvent,
  ResparkableGroup,
  ResparkableReview,
  ResparkableTask,
} from '@prisma/client';

const NOW = new Date('2026-09-21T08:00:00.000Z');
const SPACE = 'spc_study';
const GROUP_ID = 'grp_study';

/** The digest runs under the group's background scope: no actor, `member`. */
const GROUP_SCOPE = spaceScopeFor({ spaceId: SPACE, actorUserId: null, role: 'member' });

const ALICE = { userId: 'user_alice', name: 'Alice Smith', email: 'alice@example.com' };
const BOB = { userId: 'user_bob', name: 'Bob Jones', email: 'bob@example.com' };
const MEMBERS = [ALICE, BOB];

/** Everything that identifies a member, in any form a leak could take. */
const MEMBER_MARKERS = MEMBERS.flatMap((member) => [
  member.userId,
  member.name,
  member.name.split(' ')[0],
  member.email,
]);

let eventSeq = 0;

function event(
  author: string,
  kind: string,
  entityType: string,
  entityId: string
): ResparkableEvent {
  eventSeq += 1;
  return {
    id: `ev_${eventSeq}`,
    spaceId: SPACE,
    createdByUserId: author,
    kind,
    entityType,
    entityId,
    metadata: null,
    source: 'user',
    createdAt: new Date(NOW.getTime() - 2 * 24 * 60 * 60_000),
  };
}

/**
 * Alice captured thirty thoughts and finished twelve tasks; Bob captured one.
 * The lopsided week 13h names, with authorship on every row.
 */
function lopsidedWeek(): { arrivals: ResparkableEvent[]; completions: ResparkableEvent[] } {
  const arrivals = [
    ...Array.from({ length: 30 }, (_, i) => event(ALICE.userId, 'captured', 'thought', `th_a${i}`)),
    event(BOB.userId, 'captured', 'thought', 'th_b0'),
  ];
  const completions = Array.from({ length: 12 }, (_, i) =>
    event(ALICE.userId, 'completed', 'task', `task_a${i}`)
  );
  return { arrivals, completions };
}

function summary(entityType: string, id: string, title: string): EntitySummary {
  return {
    id,
    entityType: entityType as EntitySummary['entityType'],
    title,
    subtitle: null,
    archivedAt: null,
    updatedAt: NOW,
  };
}

function untouchedTask(id: string, title: string): ResparkableTask {
  return {
    id,
    title,
    updatedAt: new Date(NOW.getTime() - 20 * 24 * 60 * 60_000),
  } as ResparkableTask;
}

beforeEach(() => {
  vi.clearAllMocks();
  eventSeq = 0;

  const { arrivals, completions } = lopsidedWeek();
  vi.mocked(listEvents).mockImplementation(async (_scope, filters) =>
    filters?.kind === 'completed' ? completions : [...arrivals, ...completions]
  );
  vi.mocked(findSummaries).mockImplementation(async (_scope, entityType, ids) =>
    ids.map((id, i) => summary(entityType, id, `${entityType} note ${i + 1}`))
  );
  vi.mocked(countUnreviewedLinks).mockResolvedValue(0);
  vi.mocked(listUnreviewedLinks).mockResolvedValue([]);
  vi.mocked(listTasks).mockResolvedValue([untouchedTask('task_open', 'Book the venue')]);
  vi.mocked(buildStaleDigest).mockResolvedValue({
    generatedAt: NOW.toISOString(),
    sections: [],
    total: 0,
  });
  vi.mocked(findGroupBySpaceId).mockResolvedValue({ id: GROUP_ID } as ResparkableGroup);
  vi.mocked(listMemberContacts).mockResolvedValue(MEMBERS);
  vi.mocked(createReview).mockImplementation(
    async (_scope, data) =>
      ({
        id: 'review_1',
        horizon: data.horizon,
        title: data.title,
        body: data.body,
        generatedAt: NOW,
      }) as ResparkableReview
  );
});

/** Every key anywhere in a JSON-shaped value. */
function allKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(allKeys);
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, inner]) => [key, ...allKeys(inner)]);
  }
  return [];
}

/** The worst writer: pastes everything it was handed straight into the digest. */
function pasteEverything(inputs: GroupDigestInputs): { title: string; body: string } {
  return { title: 'Week of 14 September', body: JSON.stringify(inputs, null, 2) };
}

describe('test 13h: the gather carries nothing a ranking could be built from', () => {
  it('has no author field anywhere in it, though every source row had one', async () => {
    const inputs = await buildGroupDigestInputs(GROUP_SCOPE, NOW);

    const keys = allKeys(inputs);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(key).not.toMatch(/user|author|actor|createdBy|member|who|^by$/i);
    }
  });

  it('names no member, in any form, even though the data knows who wrote what', async () => {
    const serialised = JSON.stringify(await buildGroupDigestInputs(GROUP_SCOPE, NOW));

    for (const marker of MEMBER_MARKERS) {
      expect(serialised).not.toContain(marker);
    }
  });

  it('reports the week as the group’s totals, never split by person', async () => {
    const inputs = await buildGroupDigestInputs(GROUP_SCOPE, NOW);

    // 30 + 1: the group's week. Alice's 30 and Bob's 1 exist only in the rows
    // this function was handed, and nowhere in what it returns.
    expect(inputs.arrived.total).toBe(31);
    expect(inputs.arrived.countsByType).toEqual({ thought: 31 });
    expect(inputs.moved.total).toBe(12);
    expect(JSON.stringify(inputs)).not.toMatch(/"30"|: 30\b|\b30 /);
  });

  it('asks the event log for a person’s arrivals only, so the cap bounds arrivals', async () => {
    // Third review pass: capping before filtering let a busy sweep crowd real
    // arrivals out of the read and undercount the week.
    await buildGroupDigestInputs(GROUP_SCOPE, NOW);

    const filters = vi
      .mocked(listEvents)
      .mock.calls.map((call) => call[1])
      .find((f) => f?.kind !== 'completed');
    expect(filters).toMatchObject({ source: 'user', kinds: ['captured', 'created'] });
  });

  it('counts only what a person did as arrivals, not the sweep', async () => {
    vi.mocked(listEvents).mockImplementation(async (_scope, filters) =>
      filters?.kind === 'completed'
        ? []
        : [{ ...event(ALICE.userId, 'created', 'link', 'link_1'), source: 'system' }]
    );

    const inputs = await buildGroupDigestInputs(GROUP_SCOPE, NOW);

    expect(inputs.arrived.total).toBe(0);
  });

  it('refuses a personal brain, which has the weekly review instead', async () => {
    await expect(buildGroupDigestInputs(spaceScope('user_alice'), NOW)).rejects.toBeInstanceOf(
      NotAGroupSpaceError
    );
    expect(listEvents).not.toHaveBeenCalled();
  });

  it('refuses a grantee viewer scope on somebody else’s personal space, not just an owner role', async () => {
    // A grantee's viewer scope is not `owner` either, so the role check alone
    // would let it through. `findGroupBySpaceId` resolving null on the space is
    // what catches it: nobody's personal brain is a group.
    vi.mocked(findGroupBySpaceId).mockResolvedValue(null);
    const granteeScope = spaceScopeFor({
      spaceId: 'user_alice',
      actorUserId: 'user_grantee',
      role: 'viewer',
    });

    await expect(buildGroupDigestInputs(granteeScope, NOW)).rejects.toBeInstanceOf(
      NotAGroupSpaceError
    );
    expect(listEvents).not.toHaveBeenCalled();
  });
});

describe('test 13h: the rendered digest, from a maximally unhelpful writer', () => {
  it('a writer that pastes its whole input still produces a digest that names and ranks nobody', async () => {
    const inputs = await buildGroupDigestInputs(GROUP_SCOPE, NOW);
    const written = pasteEverything(inputs);

    await writeReview(GROUP_SCOPE, { horizon: 'group_digest', ...written });

    // What was stored is what the page renders.
    const stored = vi.mocked(createReview).mock.calls[0]?.[1];
    expect(stored?.horizon).toBe('group_digest');
    const rendered = `${stored?.title}\n${stored?.body}`;
    for (const marker of MEMBER_MARKERS) {
      expect(rendered).not.toContain(marker);
    }
    expect(findGroupDigestViolations(rendered, MEMBERS)).toEqual([]);
  });

  it('a writer that ranks the members outright is refused, and nothing is stored', async () => {
    const ranking = {
      title: 'Week of 14 September',
      body: 'Alice Smith was the most active this week with 30 notes. Bob Jones has not contributed since Tuesday.',
    };

    const refused = writeReview(GROUP_SCOPE, { horizon: 'group_digest', ...ranking });

    await expect(refused).rejects.toBeInstanceOf(GroupDigestViolationError);
    expect(createReview).not.toHaveBeenCalled();
  });

  it('refuses a ranking even when it names nobody', async () => {
    const refused = writeReview(GROUP_SCOPE, {
      horizon: 'group_digest',
      title: 'Week of 14 September',
      body: 'One of you is falling behind. The top contributor wrote the most.',
    });

    await expect(refused).rejects.toBeInstanceOf(GroupDigestViolationError);
    expect(createReview).not.toHaveBeenCalled();
  });

  it('holds a member posting a digest by hand to the same rule', async () => {
    const memberScope = spaceScopeFor({ spaceId: SPACE, actorUserId: BOB.userId, role: 'member' });

    await expect(
      writeReview(memberScope, {
        horizon: 'group_digest',
        title: 'Week',
        body: 'alice@example.com did everything.',
      })
    ).rejects.toBeInstanceOf(GroupDigestViolationError);
  });

  it('refuses a group digest written into a personal brain', async () => {
    await expect(
      writeReview(spaceScope('user_alice'), { horizon: 'group_digest', title: 'Week', body: 'x' })
    ).rejects.toBeInstanceOf(NotAGroupSpaceError);
    expect(createReview).not.toHaveBeenCalled();
  });

  it('leaves every other horizon alone, names and all', async () => {
    await writeReview(spaceScope('user_alice'), {
      horizon: 'weekly',
      title: 'Week',
      body: 'Call Bob Jones about the venue.',
    });

    expect(createReview).toHaveBeenCalledTimes(1);
    expect(listMemberContacts).not.toHaveBeenCalled();
  });
});

describe('findGroupDigestViolations', () => {
  it('accepts a digest about the work, group totals included', () => {
    expect(
      findGroupDigestViolations(
        'Eleven tasks were finished this week. The launch is behind schedule. Nobody has picked up "Book the venue" yet.',
        MEMBERS
      )
    ).toEqual([]);
  });

  it('matches a full name or an address case-insensitively, as a whole word', () => {
    expect(findGroupDigestViolations('thanks to ALICE SMITH', MEMBERS)).toEqual(['names a member']);
    expect(findGroupDigestViolations('Bob@Example.com', MEMBERS)).toEqual(['names a member']);
    // Part of a longer word is not the name.
    expect(findGroupDigestViolations('the Alice Smithson account', MEMBERS)).toEqual([]);
  });

  it('does not match a first name alone, which is too often an ordinary word', () => {
    const will = [{ name: 'Will Turner', email: 'will@example.com' }];

    expect(findGroupDigestViolations('We will ship the draft on Friday.', will)).toEqual([]);
  });

  it('does not match a one-word display name either, though it still matches the address', () => {
    // The code review's case: a member whose whole display name is "Will"
    // would otherwise refuse every digest that uses the word, every Monday.
    const will = [{ name: 'Will', email: 'will@example.com' }];

    expect(findGroupDigestViolations('This will need a look.', will)).toEqual([]);
    expect(findGroupDigestViolations('Ask will@example.com.', will)).toEqual(['names a member']);
  });

  it.each([
    'Priya was the most active member',
    'our top contributor this week',
    'here is the leaderboard',
    "Sam hasn't contributed",
    'Sam has not posted since May',
    'he has fallen behind',
    'she wrote the most',
    'Kim contributed the least',
  ])('refuses comparative phrasing about people: %s', (text) => {
    expect(findGroupDigestViolations(text, [])).not.toEqual([]);
  });
});

describe('a group of thirty produces one digest run, not thirty', () => {
  it('owes a group space exactly one group_digest job, and a person none', () => {
    expect(jobKindsForSpace('group').filter((kind) => kind === 'group_digest')).toHaveLength(1);
    expect(jobKindsForSpace('personal')).not.toContain('group_digest');
  });

  it('queues exactly one execution for the group, under the group’s scope', async () => {
    vi.mocked(queueResparkableWorkflowRun).mockResolvedValue('exec_1');

    const outcome = await runResparkableJob('group_digest', GROUP_SCOPE, NOW);

    expect(outcome.executionsQueued).toBe(1);
    expect(queueResparkableWorkflowRun).toHaveBeenCalledTimes(1);
    expect(queueResparkableWorkflowRun).toHaveBeenCalledWith(
      'resparkable-group-digest',
      GROUP_SCOPE,
      {}
    );
  });
});

describe('getLatestGroupDigest', () => {
  it('returns the newest digest in the group’s space, shaped for the page', async () => {
    vi.mocked(findLatestReview).mockResolvedValue({
      id: 'review_9',
      title: 'Week of 14 September',
      body: 'Eleven tasks were finished.',
      generatedAt: NOW,
    } as ResparkableReview);

    await expect(getLatestGroupDigest(GROUP_SCOPE)).resolves.toEqual({
      id: 'review_9',
      title: 'Week of 14 September',
      body: 'Eleven tasks were finished.',
      generatedAt: NOW.toISOString(),
    });
    expect(findLatestReview).toHaveBeenCalledWith(GROUP_SCOPE, 'group_digest');
  });

  it('returns null before the first digest', async () => {
    vi.mocked(findLatestReview).mockResolvedValue(null);

    await expect(getLatestGroupDigest(GROUP_SCOPE)).resolves.toBeNull();
  });
});

describe('buildGroupDigestInputs: connections hydrated from links', () => {
  it('drops a pair when one endpoint no longer resolves to a title', async () => {
    vi.mocked(listUnreviewedLinks).mockResolvedValue([
      { sourceType: 'thought', sourceId: 'th_1', targetType: 'project', targetId: 'proj_missing' },
      { sourceType: 'thought', sourceId: 'th_2', targetType: 'project', targetId: 'proj_1' },
    ] as never);
    // The default beforeEach mock resolves every id; override it here so one
    // endpoint (a deleted project) resolves to nothing.
    vi.mocked(findSummaries).mockImplementation(async (_scope, entityType, ids) =>
      ids
        .filter((id) => id !== 'proj_missing')
        .map((id) => summary(entityType, id, `${entityType}:${id}`))
    );

    const inputs = await buildGroupDigestInputs(GROUP_SCOPE, NOW);

    // th_1 -> proj_missing is dropped because "to" never resolves; th_2 -> proj_1
    // survives because both ends do.
    expect(inputs.connections.items).toEqual([{ from: 'thought:th_2', to: 'project:proj_1' }]);
  });
});

describe('buildGroupDigestInputs: moved items keep only a resolved title', () => {
  it('counts a completion whose entity is gone, but drops it from the listed items', async () => {
    const resolved = event(ALICE.userId, 'completed', 'task', 'task_live');
    const ghost = event(ALICE.userId, 'completed', 'task', 'task_ghost');
    vi.mocked(listEvents).mockImplementation(async (_scope, filters) =>
      filters?.kind === 'completed' ? [resolved, ghost] : []
    );
    vi.mocked(findSummaries).mockImplementation(async (_scope, entityType, ids) =>
      ids
        .filter((id) => id !== 'task_ghost')
        .map((id) => summary(entityType, id, `${entityType}:${id}`))
    );

    const inputs = await buildGroupDigestInputs(GROUP_SCOPE, NOW);

    // The count is the whole truth (both completions happened); the item list
    // only carries what still resolves to something the digest can name.
    expect(inputs.moved.total).toBe(2);
    expect(inputs.moved.items).toEqual([{ entityType: 'task', title: 'task:task_live' }]);
  });
});

describe('hydrateTitles, through buildGroupDigestInputs', () => {
  it('never asks for a type search cannot embed, and always asks with excludeSensitive on', async () => {
    const reviewArrival = event(ALICE.userId, 'captured', 'review', 'rev_1');
    const thoughtArrival = event(ALICE.userId, 'captured', 'thought', 'th_only');
    vi.mocked(listEvents).mockImplementation(async (_scope, filters) =>
      filters?.kind === 'completed' ? [] : [reviewArrival, thoughtArrival]
    );

    const inputs = await buildGroupDigestInputs(GROUP_SCOPE, NOW);

    // Both arrivals are counted...
    expect(inputs.arrived.total).toBe(2);
    // ...but only the summarisable one is named. 'review' is not a type search
    // embeds, so hydrateTitles never asks for it and it drops from the items.
    expect(inputs.arrived.items).toEqual([
      { entityType: 'thought', title: expect.stringContaining('thought') },
    ]);
    expect(findSummaries).not.toHaveBeenCalledWith(
      expect.anything(),
      'review',
      expect.anything(),
      expect.anything(),
      expect.anything()
    );
    expect(findSummaries).toHaveBeenCalledWith(
      expect.anything(),
      'thought',
      expect.arrayContaining(['th_only']),
      true,
      true
    );
  });
});

describe('assertGroupDigestAcceptable', () => {
  it('refuses a space with no group row at all, the same as a personal brain', async () => {
    vi.mocked(findGroupBySpaceId).mockResolvedValue(null);

    await expect(
      assertGroupDigestAcceptable(GROUP_SCOPE, 'Eleven tasks were finished this week.')
    ).rejects.toBeInstanceOf(NotAGroupSpaceError);
  });
});

describe('findGroupDigestViolations: the three-character floor on a name', () => {
  it('does not match a member name shorter than three characters', () => {
    const ed = [{ name: 'Ed', email: 'ed@example.com' }];

    expect(findGroupDigestViolations('Ed said the launch is on track.', ed)).toEqual([]);
  });

  it('matches a short two-word name, as a whole word', () => {
    const al = [{ name: 'Al Li', email: 'al@example.com' }];

    expect(findGroupDigestViolations('Thanks to Al Li for finishing early.', al)).toEqual([
      'names a member',
    ]);
  });

  it('matches by email alone when the member has no name on file', () => {
    const noName = [{ name: null, email: 'ghost@example.com' }];

    expect(findGroupDigestViolations('ghost@example.com sent this over.', noName)).toEqual([
      'names a member',
    ]);
  });
});

describe('buildGroupDigestInputs: stalled sections', () => {
  it('keeps only the stale sections that actually have rows', async () => {
    const projects: StaleSection = {
      type: 'project',
      windowDays: 21,
      rows: [{ id: 'proj_1', title: 'Rebrand', lastSignalAt: null, quietDays: 20 }],
    };
    const goals: StaleSection = { type: 'goal', windowDays: 30, rows: [] };
    vi.mocked(buildStaleDigest).mockResolvedValue({
      generatedAt: NOW.toISOString(),
      sections: [projects, goals],
      total: 1,
    });

    const inputs = await buildGroupDigestInputs(GROUP_SCOPE, NOW);

    expect(inputs.stalled).toEqual([projects]);
  });
});

describe('buildGroupDigestInputs: unclaimed tasks', () => {
  it('computes untouchedDays from the task’s updatedAt, floored to whole days', async () => {
    const updatedAt = new Date(NOW.getTime() - 16.5 * 24 * 60 * 60_000);
    vi.mocked(listTasks).mockResolvedValue([
      { id: 'task_x', title: 'Confirm catering', updatedAt } as ResparkableTask,
    ]);

    const inputs = await buildGroupDigestInputs(GROUP_SCOPE, NOW);

    expect(inputs.unclaimed).toEqual([{ title: 'Confirm catering', untouchedDays: 16 }]);
  });
});
