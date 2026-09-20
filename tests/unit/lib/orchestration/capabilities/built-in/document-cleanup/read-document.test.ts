/**
 * Unit Tests: ReadDocumentCapability
 *
 * The only cleanup capability that returns document TEXT. Every other tool
 * reports counts, so without this the agent chooses transforms blind — which
 * is exactly how a cleanup session ended up running a regex that could never
 * match and reporting success.
 *
 * @see lib/orchestration/capabilities/built-in/document-cleanup/read-document.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockResolveCleanupTarget } = vi.hoisted(() => ({ mockResolveCleanupTarget: vi.fn() }));

vi.mock('@/lib/orchestration/capabilities/built-in/document-cleanup/context', () => ({
  resolveCleanupTarget: mockResolveCleanupTarget,
}));

import { ReadDocumentCapability } from '@/lib/orchestration/capabilities/built-in/document-cleanup/read-document';
import type { CapabilityContext } from '@/lib/orchestration/capabilities/types';

const context: CapabilityContext = {
  userId: 'user-1',
  agentId: 'agent-1',
  conversationId: 'conv-1',
};

function makeTarget(content: string, original = 'ORIGINAL LINE 1\nORIGINAL LINE 2') {
  return { documentId: 'doc-1', content, originalContent: original };
}

const TEN_LINES = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n');

describe('ReadDocumentCapability', () => {
  let capability: ReadDocumentCapability;

  beforeEach(() => {
    vi.clearAllMocks();
    capability = new ReadDocumentCapability();
    mockResolveCleanupTarget.mockResolvedValue(makeTarget(TEN_LINES));
  });

  it('returns not_cleanup_session outside a cleanup conversation', async () => {
    mockResolveCleanupTarget.mockResolvedValue(null);

    const result = await capability.execute({}, context);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('not_cleanup_session');
  });

  it('numbers each line with its real position, so the agent can cite it', async () => {
    const result = await capability.execute({ fromLine: 3, lineCount: 2 }, context);

    // Numbering is the whole point: "look at lines 83-85" has to be answerable.
    expect(result.data?.text).toBe('3: line 3\n4: line 4');
    expect(result.data?.fromLine).toBe(3);
    expect(result.data?.toLine).toBe(4);
    expect(result.data?.totalLines).toBe(10);
  });

  it('defaults to the start of the document', async () => {
    const result = await capability.execute({}, context);

    expect(result.data?.fromLine).toBe(1);
    expect(result.data?.text.startsWith('1: line 1')).toBe(true);
  });

  it('clamps a window that runs past the end instead of padding it', async () => {
    const result = await capability.execute({ fromLine: 9, lineCount: 50 }, context);

    expect(result.data?.toLine).toBe(10);
    expect(result.data?.text).toBe('9: line 9\n10: line 10');
    expect(result.data?.truncated).toBe(true);
  });

  it('caps the line count so one call cannot blow the model context', async () => {
    const thousand = Array.from({ length: 1_000 }, (_, i) => `l${i}`).join('\n');
    mockResolveCleanupTarget.mockResolvedValue(makeTarget(thousand));

    const result = await capability.execute({ fromLine: 1, lineCount: 1_000 }, context);

    // 400-line cap — a 1,000-line request returns 400 and says it truncated.
    expect(result.data?.toLine).toBe(400);
    expect(result.data?.truncated).toBe(true);
  });

  it('caps by characters when the lines themselves are enormous', async () => {
    const fatLines = Array.from({ length: 5 }, () => 'x'.repeat(10_000)).join('\n');
    mockResolveCleanupTarget.mockResolvedValue(makeTarget(fatLines));

    const result = await capability.execute({ lineCount: 5 }, context);

    expect(result.data?.text.length).toBeLessThanOrEqual(20_000);
    expect(result.data?.truncated).toBe(true);
  });

  it('reads the untouched original when asked, for comparison', async () => {
    const result = await capability.execute({ which: 'original' }, context);

    expect(result.data?.which).toBe('original');
    expect(result.data?.text).toBe('1: ORIGINAL LINE 1\n2: ORIGINAL LINE 2');
  });

  it('clamps a fromLine past the end of the document rather than erroring', async () => {
    const result = await capability.execute({ fromLine: 999 }, context);

    expect(result.success).toBe(true);
    expect(result.data?.fromLine).toBe(10);
  });
});
