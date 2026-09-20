/**
 * Unit Tests: JoinWrappedLinesCapability
 *
 * The reflow tool for PDF-extracted text. Tests target the pure
 * `joinWrappedLines` transform directly (the capability wrapper's
 * mutate/refusal plumbing is covered by context.test.ts and the other
 * deterministic capabilities' suites).
 *
 * @see lib/orchestration/capabilities/built-in/document-cleanup/join-wrapped-lines.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockResolveCleanupTarget, mockWriteCleanupContent, mockSummariseMutation } = vi.hoisted(
  () => ({
    mockResolveCleanupTarget: vi.fn(),
    mockWriteCleanupContent: vi.fn(),
    mockSummariseMutation: vi.fn(),
  })
);

const { mockRequireEditableTarget } = vi.hoisted(() => ({ mockRequireEditableTarget: vi.fn() }));

vi.mock('@/lib/orchestration/capabilities/built-in/document-cleanup/context', async (orig) => {
  const actual =
    await orig<
      typeof import('@/lib/orchestration/capabilities/built-in/document-cleanup/context')
    >();
  const { makeMutateCleanupContentDouble } = await import('@/tests/helpers/cleanup-mutation');
  return {
    ...actual,
    mutateCleanupContent: makeMutateCleanupContentDouble({
      resolveTarget: (context) => mockResolveCleanupTarget(context),
      requireEditable: (documentId, userId) => mockRequireEditableTarget(documentId, userId),
      recordWrite: (documentId, content, opts) =>
        mockWriteCleanupContent(documentId, content, opts),
      summarise: (before, after) => mockSummariseMutation(before, after),
    }),
  };
});

import {
  JoinWrappedLinesCapability,
  joinWrappedLines,
} from '@/lib/orchestration/capabilities/built-in/document-cleanup/join-wrapped-lines';
import type { CapabilityContext } from '@/lib/orchestration/capabilities/types';

const DEFAULTS = { dehyphenate: true, onlyLowercaseContinuations: true };

describe('joinWrappedLines', () => {
  it('joins a sentence wrapped across lines with a single space', () => {
    const result = joinWrappedLines('the quick brown\nfox jumps over', DEFAULTS);

    expect(result.next).toBe('the quick brown fox jumps over');
    expect(result.joined).toBe(1);
  });

  it('preserves a blank line as a paragraph break', () => {
    const input = 'first paragraph ends here.\n\nsecond paragraph starts';

    expect(joinWrappedLines(input, DEFAULTS).next).toBe(input);
  });

  it('does not join after sentence-final punctuation', () => {
    // A full stop means the next line starts a new thought, not a wrap.
    const input = 'This sentence is done.\nThis one is new.';

    expect(joinWrappedLines(input, DEFAULTS).next).toBe(input);
  });

  it('rejoins a hyphen-split word without leaving a space', () => {
    const result = joinWrappedLines('a compre-\nhensive report', DEFAULTS);

    expect(result.next).toBe('a comprehensive report');
    expect(result.dehyphenated).toBe(1);
    expect(result.joined).toBe(0);
  });

  it('leaves the hyphen alone when dehyphenate is off', () => {
    const result = joinWrappedLines('a compre-\nhensive report', {
      ...DEFAULTS,
      dehyphenate: false,
    });

    // Still joined as a wrap — but the hyphen survives, which is the point of
    // the flag for documents whose hyphens are the author's.
    expect(result.next).toBe('a compre- hensive report');
    expect(result.dehyphenated).toBe(0);
  });

  it('leaves headings and list items unjoined', () => {
    const input = '# A heading\nintro text\n- first bullet\n- second bullet';

    const result = joinWrappedLines(input, DEFAULTS);

    // 'intro text' must not be absorbed into the heading, and the bullets
    // must not collapse into one another.
    expect(result.next).toBe(input);
  });

  it('leaves a table row unjoined', () => {
    const input = '| a | b |\n| c | d |';

    expect(joinWrappedLines(input, DEFAULTS).next).toBe(input);
  });

  it('only joins lowercase continuations by default', () => {
    const input = 'ends without punctuation\nCapitalised next line';

    expect(joinWrappedLines(input, DEFAULTS).next).toBe(input);
  });

  it('joins capitalised continuations when the caller opts in', () => {
    const result = joinWrappedLines('ends without punctuation\nCapitalised next line', {
      ...DEFAULTS,
      onlyLowercaseContinuations: false,
    });

    expect(result.next).toBe('ends without punctuation Capitalised next line');
  });

  it('reports a split WORD instead of guessing at it', () => {
    // "SurveyMonke" / "y" from a narrow PDF table cell. Joining with a space
    // gives "SurveyMonke y"; joining without one is right here but wrong for
    // every ordinary wrap. Neither is safe to assume, so it is reported.
    const input = 'SurveyMonke\ny\nMass-market surveys';

    const result = joinWrappedLines(input, DEFAULTS);

    expect(result.suspectedSplitWords).toEqual([2]);
    expect(result.next.split('\n')[0]).toBe('SurveyMonke');
    expect(result.next.split('\n')[1]).toBe('y');
  });

  it('trims the whitespace it would otherwise bake into the join', () => {
    const result = joinWrappedLines('line one   \n   line two', DEFAULTS);

    expect(result.next).toBe('line one line two');
  });

  it('leaves an already-reflowed document unchanged (idempotent)', () => {
    const once = joinWrappedLines('the quick brown\nfox jumps over', DEFAULTS).next;
    const twice = joinWrappedLines(once, DEFAULTS);

    expect(twice.next).toBe(once);
    expect(twice.joined).toBe(0);
  });
});

describe('JoinWrappedLinesCapability', () => {
  let capability: JoinWrappedLinesCapability;
  const context: CapabilityContext = {
    userId: 'user-1',
    agentId: 'agent-1',
    conversationId: 'conv-1',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    capability = new JoinWrappedLinesCapability();
    mockRequireEditableTarget.mockResolvedValue({ ok: true });
    mockSummariseMutation.mockImplementation((before: string, after: string) => ({
      charsRemoved: before.length - after.length,
      charsAfter: after.length,
      linesRemoved: before.split('\n').length - after.split('\n').length,
      linesAfter: after.split('\n').length,
    }));
    mockResolveCleanupTarget.mockResolvedValue({
      documentId: 'doc-1',
      content: 'the quick brown\nfox jumps over',
      originalContent: 'the quick brown\nfox jumps over',
    });
  });

  it('writes the reflowed text and reports what it did', async () => {
    const result = await capability.execute({}, context);

    expect(result.success).toBe(true);
    expect(mockWriteCleanupContent).toHaveBeenCalledWith(
      'doc-1',
      'the quick brown fox jumps over',
      expect.objectContaining({ source: 'capability:join_wrapped_lines' })
    );
    expect(result.data?.joined).toBe(1);
    expect(result.data?.linesRemoved).toBe(1);
  });

  it('returns not_cleanup_session outside a cleanup conversation', async () => {
    mockResolveCleanupTarget.mockResolvedValue(null);

    const result = await capability.execute({}, context);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('not_cleanup_session');
    expect(mockWriteCleanupContent).not.toHaveBeenCalled();
  });

  it('refuses when another admin holds the edit lock', async () => {
    mockRequireEditableTarget.mockResolvedValue({ ok: false, heldBy: 'other-admin' });

    const result = await capability.execute({}, context);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('target_locked');
    expect(mockWriteCleanupContent).not.toHaveBeenCalled();
  });
});
