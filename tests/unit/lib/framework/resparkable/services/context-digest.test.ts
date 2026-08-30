/**
 * Unit Tests: `buildContextDigest`.
 *
 * The deterministic gather step for the description-summariser workflow — same
 * shape as `services/briefing.ts`, zero LLM calls. What matters here is not the
 * happy path alone but the two things that would otherwise leak or crash
 * silently: a `sensitive`-classified note must never reach the corpus, and a
 * missing/foreign entity must resolve to `null` rather than throwing.
 *
 * Test Coverage:
 * - Returns `null` for an entity that doesn't exist or isn't the caller's
 * - Gathers only `accepted` thought-links, both link directions
 * - `findThoughtsByIds` is called with `excludeSensitive: true`
 * - A dangling link (thought since deleted or filtered out) is skipped, not thrown
 * - `sourceThoughtIds`/`sourceLinkIds` line up with the notes actually included
 *
 * @see lib/framework/resparkable/services/context-digest.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/framework/resparkable/repo/areas', () => ({ findArea: vi.fn() }));
vi.mock('@/lib/framework/resparkable/repo/goals', () => ({ findGoal: vi.fn() }));
vi.mock('@/lib/framework/resparkable/repo/projects', () => ({ findProject: vi.fn() }));
vi.mock('@/lib/framework/resparkable/repo/links', () => ({ listLinksForEntity: vi.fn() }));
vi.mock('@/lib/framework/resparkable/repo/thoughts', () => ({ findThoughtsByIds: vi.fn() }));

import { buildContextDigest } from '@/lib/framework/resparkable/services/context-digest';
import { findArea } from '@/lib/framework/resparkable/repo/areas';
import { listLinksForEntity } from '@/lib/framework/resparkable/repo/links';
import { findThoughtsByIds } from '@/lib/framework/resparkable/repo/thoughts';
import { spaceScope } from '@/lib/framework/resparkable/repo/space-scope';
import type { ResparkableArea, ResparkableLink, ResparkableThought } from '@prisma/client';

const mockedFindArea = vi.mocked(findArea);
const mockedListLinks = vi.mocked(listLinksForEntity);
const mockedFindThoughts = vi.mocked(findThoughtsByIds);

const SCOPE = spaceScope('user_a');

const AREA = {
  id: 'area_1',
  name: 'Health',
  description: 'Staying on top of it.',
} as ResparkableArea;

function link(overrides: Partial<ResparkableLink>): ResparkableLink {
  return {
    id: 'link_1',
    sourceType: 'thought',
    sourceId: 'thought_1',
    targetType: 'area',
    targetId: 'area_1',
    kind: 'relates_to',
    status: 'accepted',
    ...overrides,
  } as ResparkableLink;
}

function thought(overrides: Partial<ResparkableThought>): ResparkableThought {
  return {
    id: 'thought_1',
    content: 'Went for a run this morning',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  } as ResparkableThought;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedFindArea.mockResolvedValue(AREA);
  mockedListLinks.mockResolvedValue([]);
  mockedFindThoughts.mockResolvedValue([]);
});

describe('buildContextDigest', () => {
  it('returns null when the entity does not exist or is not the caller’s', async () => {
    mockedFindArea.mockResolvedValue(null);

    await expect(buildContextDigest(SCOPE, 'area', 'area_1')).resolves.toBeNull();
    expect(mockedListLinks).not.toHaveBeenCalled();
  });

  it('carries the entity’s own name and description through unchanged', async () => {
    const digest = await buildContextDigest(SCOPE, 'area', 'area_1');

    expect(digest).toMatchObject({
      entityType: 'area',
      entityId: 'area_1',
      entityName: 'Health',
      currentDescription: 'Staying on top of it.',
    });
  });

  it('requests only accepted links for the entity', async () => {
    await buildContextDigest(SCOPE, 'area', 'area_1');

    expect(mockedListLinks).toHaveBeenCalledWith(SCOPE, 'area', 'area_1', {
      statuses: ['accepted'],
    });
  });

  it('reads a thought whichever side of the link it is on', async () => {
    mockedListLinks.mockResolvedValue([
      link({ id: 'link_a', sourceType: 'thought', sourceId: 't_a', targetType: 'area' }),
      link({ id: 'link_b', sourceType: 'area', targetType: 'thought', targetId: 't_b' }),
    ]);
    mockedFindThoughts.mockResolvedValue([
      thought({ id: 't_a', content: 'First note' }),
      thought({ id: 't_b', content: 'Second note' }),
    ]);

    const digest = await buildContextDigest(SCOPE, 'area', 'area_1');

    expect(digest?.notes.map((n) => n.id).sort()).toEqual(['t_a', 't_b']);
    expect(digest?.sourceLinkIds.sort()).toEqual(['link_a', 'link_b']);
  });

  it('excludes sensitive thoughts at the repo layer, not just by filtering results', async () => {
    mockedListLinks.mockResolvedValue([link({})]);

    await buildContextDigest(SCOPE, 'area', 'area_1');

    expect(mockedFindThoughts).toHaveBeenCalledWith(SCOPE, ['thought_1'], {
      excludeSensitive: true,
    });
  });

  it('skips a link whose thought is missing, archived, or filtered out — never throws', async () => {
    mockedListLinks.mockResolvedValue([
      link({ id: 'link_a', sourceId: 't_a' }),
      link({ id: 'link_b', sourceId: 't_gone' }),
    ]);
    // Only t_a comes back — t_gone was excluded by the sensitivity filter or no longer exists.
    mockedFindThoughts.mockResolvedValue([thought({ id: 't_a' })]);

    const digest = await buildContextDigest(SCOPE, 'area', 'area_1');

    expect(digest?.notes).toHaveLength(1);
    expect(digest?.sourceThoughtIds).toEqual(['t_a']);
    expect(digest?.sourceLinkIds).toEqual(['link_a']);
  });

  it('ignores a link that does not touch a thought at all', async () => {
    mockedListLinks.mockResolvedValue([
      link({ sourceType: 'project', sourceId: 'project_1', targetType: 'area' }),
    ]);

    const digest = await buildContextDigest(SCOPE, 'area', 'area_1');

    expect(digest?.notes).toHaveLength(0);
    expect(mockedFindThoughts).toHaveBeenCalledWith(SCOPE, [], { excludeSensitive: true });
  });
});
