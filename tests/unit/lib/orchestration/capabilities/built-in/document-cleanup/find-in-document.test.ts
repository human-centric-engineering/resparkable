/**
 * Unit Tests: FindInDocumentCapability
 *
 * Lets the agent CHECK a pattern before handing it to a destructive tool.
 *
 * @see lib/orchestration/capabilities/built-in/document-cleanup/find-in-document.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { nestedQuantifierPattern } from '@/tests/helpers/redos-pattern';

const { mockResolveCleanupTarget } = vi.hoisted(() => ({ mockResolveCleanupTarget: vi.fn() }));

// compileSafeRegex is kept REAL — the backtracking guard is the point of
// routing user-supplied patterns through it.
vi.mock('@/lib/orchestration/capabilities/built-in/document-cleanup/context', async (orig) => {
  const actual =
    await orig<
      typeof import('@/lib/orchestration/capabilities/built-in/document-cleanup/context')
    >();
  return { ...actual, resolveCleanupTarget: mockResolveCleanupTarget };
});

import { FindInDocumentCapability } from '@/lib/orchestration/capabilities/built-in/document-cleanup/find-in-document';
import type { CapabilityContext } from '@/lib/orchestration/capabilities/types';

const context: CapabilityContext = {
  userId: 'user-1',
  agentId: 'agent-1',
  conversationId: 'conv-1',
};

function makeTarget(content: string) {
  return { documentId: 'doc-1', content, originalContent: content };
}

describe('FindInDocumentCapability', () => {
  let capability: FindInDocumentCapability;

  beforeEach(() => {
    vi.clearAllMocks();
    capability = new FindInDocumentCapability();
    mockResolveCleanupTarget.mockResolvedValue(makeTarget('alpha\nBETA\ngamma beta\ndelta'));
  });

  it('returns not_cleanup_session outside a cleanup conversation', async () => {
    mockResolveCleanupTarget.mockResolvedValue(null);

    const result = await capability.execute({ regex: 'x' }, context);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('not_cleanup_session');
  });

  it('returns the line number and text of each matching line', async () => {
    const result = await capability.execute({ regex: 'beta' }, context);

    expect(result.data?.matchCount).toBe(1);
    expect(result.data?.matches).toEqual([{ line: 3, text: 'gamma beta' }]);
  });

  it('honours case-insensitive flags', async () => {
    const result = await capability.execute({ regex: 'beta', flags: 'i' }, context);

    expect(result.data?.matches.map((m) => m.line)).toEqual([2, 3]);
  });

  it('strips g/y flags, which would make .test() skip lines', async () => {
    // A 'g' regex carries lastIndex between calls, so every other line would
    // silently fail to match — the bug this mirrors in strip_lines_matching.
    const result = await capability.execute({ regex: 'a', flags: 'g' }, context);

    // 'alpha', 'gamma beta', 'delta' — every line with a lowercase 'a'. With
    // the 'g' flag left on, lastIndex would carry over and skip some of them.
    expect(result.data?.matches.map((m) => m.line)).toEqual([1, 3, 4]);
  });

  it('never mutates — it is a read-only check', async () => {
    const result = await capability.execute({ regex: 'alpha' }, context);

    expect(result.success).toBe(true);
    // The capability has no write path at all; the contract is that a
    // caller can run any pattern through it safely.
    expect(result.data).not.toHaveProperty('charsRemoved');
  });

  it('caps returned matches but reports the true total', async () => {
    const many = Array.from({ length: 50 }, (_, i) => `hit ${i}`).join('\n');
    mockResolveCleanupTarget.mockResolvedValue(makeTarget(many));

    const result = await capability.execute({ regex: 'hit', maxMatches: 5 }, context);

    expect(result.data?.matches).toHaveLength(5);
    expect(result.data?.matchCount).toBe(50);
    expect(result.data?.truncated).toBe(true);
  });

  it('elides a very long matching line rather than returning the whole thing', async () => {
    mockResolveCleanupTarget.mockResolvedValue(makeTarget(`prefix ${'x'.repeat(1_000)}`));

    const result = await capability.execute({ regex: 'prefix' }, context);

    expect(result.data?.matches[0].text.length).toBeLessThanOrEqual(301);
    expect(result.data?.matches[0].text.endsWith('…')).toBe(true);
  });

  it('rejects a regex vulnerable to catastrophic backtracking', async () => {
    const result = await capability.execute({ regex: nestedQuantifierPattern('b') }, context);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('invalid_regex');
  });

  it('rejects a syntactically invalid regex', async () => {
    const result = await capability.execute({ regex: '([unclosed' }, context);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('invalid_regex');
  });
});
