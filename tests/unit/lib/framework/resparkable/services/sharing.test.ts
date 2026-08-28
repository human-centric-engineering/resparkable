/**
 * Unit Tests: the sharing service (Release 2, phase 11).
 *
 * Three properties, each of which fails silently if it breaks:
 *
 *   1. **The token exists for one function call.** It is generated, hashed and
 *      returned once; nothing else in the system can produce it again. A
 *      regression that stored the plaintext would look identical from outside —
 *      links would keep working — right up until a database dump.
 *   2. **Redaction is decided by the access layer and applied here.** The two
 *      meet in exactly one function, so the rules hold in one place rather than
 *      in as many places as there are routes.
 *   3. **Every failure to read is the same failure.** Unknown token, revoked
 *      link, expired link, deleted item: one `null`, no distinguishing detail.
 *
 * Only the repo and the access store are mocked — the service, the token
 * minting and the payload assembly all run for real, because that is where the
 * decisions are.
 *
 * @see lib/framework/resparkable/services/sharing.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const createShareLink = vi.fn();
const listShareLinks = vi.fn();
const ownsEntity = vi.fn();
const revokeShareLinkRow = vi.fn();
const countShareLinkView = vi.fn();

vi.mock('@/lib/framework/resparkable/repo/share-links', () => ({
  createShareLink: (...args: unknown[]) => createShareLink(...args),
  listShareLinks: (...args: unknown[]) => listShareLinks(...args),
  ownsEntity: (...args: unknown[]) => ownsEntity(...args),
  revokeShareLink: (...args: unknown[]) => revokeShareLinkRow(...args),
  countShareLinkView: (...args: unknown[]) => countShareLinkView(...args),
}));

const findSharedItem = vi.fn();
const findSharedItems = vi.fn();
const findSharedChildIds = vi.fn();

vi.mock('@/lib/framework/resparkable/repo/shared-view', () => ({
  findSharedItem: (...args: unknown[]) => findSharedItem(...args),
  findSharedItems: (...args: unknown[]) => findSharedItems(...args),
  findSharedChildIds: (...args: unknown[]) => findSharedChildIds(...args),
  SHARED_CHILD_LIMIT: 200,
}));

const findLiveShareLinkByTokenHash = vi.fn();

vi.mock('@/lib/framework/resparkable/access/store', () => ({
  findLiveShareLinkByTokenHash: (...args: unknown[]) => findLiveShareLinkByTokenHash(...args),
}));

const buildBoardView = vi.fn();

vi.mock('@/lib/framework/resparkable/services/board-view', () => ({
  buildBoardView: (...args: unknown[]) => buildBoardView(...args),
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { hashShareToken } from '@/lib/framework/resparkable/access/resolve';
import { ownerScope } from '@/lib/framework/resparkable/repo/owner-scope';
// The mocked value above, read back rather than retyped, so the two cannot drift.
import { SHARED_CHILD_LIMIT } from '@/lib/framework/resparkable/repo/shared-view';
import {
  mintShareLink,
  readPublicShare,
  revokeShareLink,
} from '@/lib/framework/resparkable/services/sharing';
import { logger } from '@/lib/logging';

const SCOPE = ownerScope('user_a');
const PROJECT_ID = 'clh0000000000000000000001';

function linkRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'link_1',
    userId: 'user_a',
    entityType: 'project',
    entityId: PROJECT_ID,
    tokenHash: 'digest',
    tokenPrefix: 'AAAABBBB',
    includeChildren: false,
    includeTaskDetail: false,
    expiresAt: null,
    revokedAt: null,
    viewCount: 0,
    lastViewedAt: null,
    createdAt: new Date('2026-08-26T00:00:00Z'),
    updatedAt: new Date('2026-08-26T00:00:00Z'),
    ...overrides,
  };
}

function liveLink(overrides: Record<string, unknown> = {}) {
  return {
    id: 'link_1',
    ownerId: 'user_a',
    entityType: 'project',
    entityId: PROJECT_ID,
    includeChildren: false,
    includeTaskDetail: false,
    expiresAt: null,
    revokedAt: null,
    ...overrides,
  };
}

function itemView(overrides: Record<string, unknown> = {}) {
  return {
    entityType: 'project',
    id: PROJECT_ID,
    title: 'Acme Redesign',
    body: 'The plan.',
    status: 'active',
    dueAt: null,
    horizon: null,
    archived: false,
    updatedAt: new Date('2026-08-01T00:00:00Z'),
    tags: [],
    checklist: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  ownsEntity.mockResolvedValue(true);
  createShareLink.mockImplementation(async (_scope, data) => linkRow(data));
  findSharedItem.mockResolvedValue(itemView());
  findSharedItems.mockResolvedValue([]);
  findSharedChildIds.mockResolvedValue(null);
  findLiveShareLinkByTokenHash.mockResolvedValue(null);
  buildBoardView.mockResolvedValue(null);
});

describe('minting', () => {
  it('stores only the digest, and returns the plaintext once', async () => {
    const minted = await mintShareLink(SCOPE, {
      entityType: 'project',
      entityId: PROJECT_ID,
      includeChildren: false,
      includeTaskDetail: false,
      expiry: { kind: 'days', days: 30 },
    });

    const stored = createShareLink.mock.calls[0][1] as { tokenHash: string; tokenPrefix: string };

    expect(stored.tokenHash).toBe(hashShareToken(minted!.token));
    expect(stored.tokenHash).not.toBe(minted!.token);
    // The prefix is what lets an owner tell two of their own links apart. Eight
    // characters of 32 leaves 192 bits minus 48 — still hopeless to guess, and
    // useless without the digest.
    expect(stored.tokenPrefix).toBe(minted!.token.slice(0, 8));
  });

  it('mints a 32-character base64url token, not a cuid', async () => {
    // Cuids are timestamp-prefixed and monotonic: excellent for a primary key,
    // precisely wrong for a value whose only defence is unguessability.
    const minted = await mintShareLink(SCOPE, {
      entityType: 'project',
      entityId: PROJECT_ID,
      includeChildren: false,
      includeTaskDetail: false,
      expiry: { kind: 'days', days: 30 },
    });

    expect(minted!.token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    // 24 bytes base64-encoded is exactly 32 characters with no padding — so a
    // token that is 25 or 36 characters is not this generator's output, and a
    // cuid (25 chars, `c`-prefixed, lowercase base36) fails both checks.
    expect(minted!.token).toHaveLength(32);
    expect(/^c[a-z0-9]{24}$/.test(minted!.token)).toBe(false);
  });

  it('produces a different token every time', async () => {
    const input = {
      entityType: 'project' as const,
      entityId: PROJECT_ID,
      includeChildren: false,
      includeTaskDetail: false,
      expiry: { kind: 'days' as const, days: 30 },
    };

    const first = await mintShareLink(SCOPE, input);
    const second = await mintShareLink(SCOPE, input);

    expect(first!.token).not.toBe(second!.token);
  });

  it('resolves the expiry from the choice, and null only for "never"', async () => {
    const now = new Date('2026-08-26T00:00:00Z');

    await mintShareLink(
      SCOPE,
      {
        entityType: 'project',
        entityId: PROJECT_ID,
        includeChildren: false,
        includeTaskDetail: false,
        expiry: { kind: 'days', days: 30 },
      },
      now
    );
    expect((createShareLink.mock.calls[0][1] as { expiresAt: Date }).expiresAt).toEqual(
      new Date('2026-09-25T00:00:00Z')
    );

    await mintShareLink(
      SCOPE,
      {
        entityType: 'project',
        entityId: PROJECT_ID,
        includeChildren: false,
        includeTaskDetail: false,
        expiry: { kind: 'never' },
      },
      now
    );
    expect((createShareLink.mock.calls[1][1] as { expiresAt: Date | null }).expiresAt).toBeNull();
  });

  it('refuses an item that is not the caller’s, without writing a row', async () => {
    // Otherwise a token would be minted that 404s for its own creator.
    ownsEntity.mockResolvedValue(false);

    const minted = await mintShareLink(SCOPE, {
      entityType: 'project',
      entityId: PROJECT_ID,
      includeChildren: false,
      includeTaskDetail: false,
      expiry: { kind: 'days', days: 30 },
    });

    expect(minted).toBeNull();
    expect(createShareLink).not.toHaveBeenCalled();
  });

  it('logs the shape of the link and never the token or the item id', async () => {
    const minted = await mintShareLink(SCOPE, {
      entityType: 'project',
      entityId: PROJECT_ID,
      includeChildren: false,
      includeTaskDetail: false,
      expiry: { kind: 'days', days: 30 },
    });

    const logged = JSON.stringify(vi.mocked(logger.info).mock.calls);
    expect(logged).not.toContain(minted!.token);
    expect(logged).not.toContain(PROJECT_ID);
    expect(logged).toContain('project');
  });
});

describe('reading a public share', () => {
  it('returns the item for a live token', async () => {
    findLiveShareLinkByTokenHash.mockResolvedValue(liveLink());

    const payload = await readPublicShare('AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH');

    expect(payload?.item.title).toBe('Acme Redesign');
    expect(payload?.children).toEqual([]);
  });

  it('hashes the token before looking it up', async () => {
    const token = 'AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH';
    findLiveShareLinkByTokenHash.mockResolvedValue(liveLink());

    await readPublicShare(token);

    expect(findLiveShareLinkByTokenHash).toHaveBeenCalledWith(
      hashShareToken(token),
      expect.any(Date)
    );
  });

  it('returns null when the link resolves but its item is gone', async () => {
    // The link outlived what it pointed at. Same answer as a bad token, on
    // purpose: the reader learns nothing about whether the item ever existed.
    findLiveShareLinkByTokenHash.mockResolvedValue(liveLink());
    findSharedItem.mockResolvedValue(null);

    await expect(readPublicShare('AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH')).resolves.toBeNull();
  });

  it('counts a view only after the payload rendered', async () => {
    // A view of something that could not be rendered is not a view. Counting it
    // would make the owner's "is anyone opening this?" answer include failures.
    findLiveShareLinkByTokenHash.mockResolvedValue(liveLink());
    findSharedItem.mockResolvedValue(null);

    await readPublicShare('AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH');
    expect(countShareLinkView).not.toHaveBeenCalled();

    findSharedItem.mockResolvedValue(itemView());
    await readPublicShare('AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH');
    expect(countShareLinkView).toHaveBeenCalledWith('link_1', expect.any(Date));
  });

  it('withholds task prose unless the link says otherwise', async () => {
    // A link is a document handed to strangers. `notes` is the private working
    // commentary beside a one-line title, and the bar for it is higher here
    // than for a named grant, not lower.
    findLiveShareLinkByTokenHash.mockResolvedValue(liveLink({ includeTaskDetail: false }));
    await readPublicShare('AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH');
    expect(findSharedItem.mock.calls[0][3]).toBe(false);

    findLiveShareLinkByTokenHash.mockResolvedValue(liveLink({ includeTaskDetail: true }));
    await readPublicShare('AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH');
    expect(findSharedItem.mock.calls[1][3]).toBe(true);
  });

  it('loads no children when includeChildren is off', async () => {
    findLiveShareLinkByTokenHash.mockResolvedValue(liveLink({ includeChildren: false }));

    const payload = await readPublicShare('AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH');

    expect(payload?.children).toEqual([]);
    expect(findSharedChildIds).not.toHaveBeenCalled();
  });

  it('preserves the child order the id query chose', async () => {
    // `findMany` with an `in` makes no ordering promise, and the due-date
    // sequence is the whole point of it. Never `priorityScore`: ordering by it
    // leaks the ranking through the sequence even with the number withheld.
    findLiveShareLinkByTokenHash.mockResolvedValue(liveLink({ includeChildren: true }));
    findSharedChildIds.mockResolvedValue({ childType: 'task', ids: ['t_3', 't_1', 't_2'] });
    findSharedItems.mockResolvedValue([
      itemView({ entityType: 'task', id: 't_1', title: 'One' }),
      itemView({ entityType: 'task', id: 't_2', title: 'Two' }),
      itemView({ entityType: 'task', id: 't_3', title: 'Three' }),
    ]);

    const payload = await readPublicShare('AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH');

    expect(payload?.children.map((child) => child.id)).toEqual(['t_3', 't_1', 't_2']);
  });

  it('asks board-view for a board’s children, not the repo', async () => {
    // A filter-backed board is a live query. Resolving its membership anywhere
    // but the module that renders it would be a second copy of the filter
    // predicate — and the disagreement would show as a shared board displaying
    // different cards from the owner's.
    findLiveShareLinkByTokenHash.mockResolvedValue(
      liveLink({ entityType: 'board', entityId: 'b_1', includeChildren: true })
    );
    findSharedItem.mockResolvedValue(itemView({ entityType: 'board', id: 'b_1', title: 'Now' }));
    buildBoardView.mockResolvedValue({
      columns: [{ cards: [{ task: { id: 't_1' } }, { task: { id: 't_2' } }] }],
      unplaced: [{ task: { id: 't_9' } }],
    });
    findSharedItems.mockResolvedValue([
      itemView({ entityType: 'task', id: 't_1' }),
      itemView({ entityType: 'task', id: 't_2' }),
      itemView({ entityType: 'task', id: 't_9' }),
    ]);

    const payload = await readPublicShare('AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH');

    expect(findSharedChildIds).not.toHaveBeenCalled();
    // Unplaced last: a card with no column is still a card, and dropping it
    // would make the shared board disagree with the owner's.
    expect(payload?.children.map((child) => child.id)).toEqual(['t_1', 't_2', 't_9']);
  });

  describe('childrenTruncated', () => {
    // The repo asks for one more child than it renders, so the service can tell
    // "exactly at the limit" from "cut at the limit". Comparing a rendered page
    // against the limit cannot, and the two failures point opposite ways: claim
    // more when there is none, or stop without saying so.
    const ids = (count: number) => Array.from({ length: count }, (_, i) => `t_${i}`);

    beforeEach(() => {
      findLiveShareLinkByTokenHash.mockResolvedValue(liveLink({ includeChildren: true }));
      findSharedItems.mockImplementation(async (_s: unknown, _t: unknown, wanted: string[]) =>
        wanted.map((id) => itemView({ entityType: 'task', id }))
      );
    });

    it('is false for a project with exactly the limit, and renders them all', async () => {
      findSharedChildIds.mockResolvedValue({
        childType: 'task',
        ids: ids(SHARED_CHILD_LIMIT),
      });

      const payload = await readPublicShare('AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH');

      expect(payload?.children).toHaveLength(SHARED_CHILD_LIMIT);
      expect(payload?.childrenTruncated).toBe(false);
    });

    it('is true, and drops the probe row, when there is one more', async () => {
      findSharedChildIds.mockResolvedValue({
        childType: 'task',
        ids: ids(SHARED_CHILD_LIMIT + 1),
      });

      const payload = await readPublicShare('AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH');

      // The extra row exists to be counted, never to be rendered.
      expect(payload?.children).toHaveLength(SHARED_CHILD_LIMIT);
      expect(payload?.childrenTruncated).toBe(true);
    });

    it('is false for a board whose cards fit', async () => {
      findLiveShareLinkByTokenHash.mockResolvedValue(
        liveLink({ entityType: 'board', entityId: 'b_1', includeChildren: true })
      );
      findSharedItem.mockResolvedValue(itemView({ entityType: 'board', id: 'b_1' }));
      buildBoardView.mockResolvedValue({
        columns: [{ cards: ids(SHARED_CHILD_LIMIT).map((id) => ({ task: { id } })) }],
        unplaced: [],
      });

      const payload = await readPublicShare('AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH');

      expect(payload?.childrenTruncated).toBe(false);
    });

    it('is true for a board with more cards than it renders', async () => {
      findLiveShareLinkByTokenHash.mockResolvedValue(
        liveLink({ entityType: 'board', entityId: 'b_1', includeChildren: true })
      );
      findSharedItem.mockResolvedValue(itemView({ entityType: 'board', id: 'b_1' }));
      buildBoardView.mockResolvedValue({
        columns: [{ cards: ids(SHARED_CHILD_LIMIT).map((id) => ({ task: { id } })) }],
        unplaced: [{ task: { id: 't_extra' } }],
      });

      const payload = await readPublicShare('AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH');

      expect(payload?.children).toHaveLength(SHARED_CHILD_LIMIT);
      expect(payload?.childrenTruncated).toBe(true);
    });
  });
});

describe('revoking', () => {
  it('delegates to the repo, which flips visibility in the same transaction', async () => {
    revokeShareLinkRow.mockResolvedValue(linkRow({ revokedAt: new Date('2026-08-26T12:00:00Z') }));

    const revoked = await revokeShareLink(SCOPE, 'link_1');

    expect(revoked?.revokedAt).toEqual(new Date('2026-08-26T12:00:00Z'));
  });

  it('returns null for a link that is not the caller’s', async () => {
    revokeShareLinkRow.mockResolvedValue(null);

    await expect(revokeShareLink(SCOPE, 'link_x')).resolves.toBeNull();
  });
});
