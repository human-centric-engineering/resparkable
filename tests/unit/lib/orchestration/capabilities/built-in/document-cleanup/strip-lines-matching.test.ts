/**
 * Unit Tests: StripLinesMatchingCapability
 *
 * Tests for the strip_lines_matching capability, which removes whole lines
 * matching a given regex from the document being cleaned.
 *
 * @see lib/orchestration/capabilities/built-in/document-cleanup/strip-lines-matching.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { nestedQuantifierPattern } from '@/tests/helpers/redos-pattern';

// ─── Mocks ──────────────────────────────────────────────────────────────────

// vi.mock is hoisted — use vi.hoisted() so mock fn refs exist before the factory runs
const { mockResolveCleanupTarget, mockWriteCleanupContent, mockSummariseMutation } = vi.hoisted(
  () => ({
    mockResolveCleanupTarget: vi.fn(),
    mockWriteCleanupContent: vi.fn(),
    mockSummariseMutation: vi.fn(),
  })
);

const { mockRequireEditableTarget } = vi.hoisted(() => ({
  mockRequireEditableTarget: vi.fn(),
}));

// `compileSafeRegex` is kept real (it's pure — no DB) so regex-safety
// behaviour is actually exercised, not just assumed.
vi.mock(
  '@/lib/orchestration/capabilities/built-in/document-cleanup/context',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('@/lib/orchestration/capabilities/built-in/document-cleanup/context')
      >();
    // `mutateCleanupContent` owns the row-locked transaction; these tests
    // exercise the transform passed into it, so it is replaced by a double
    // that runs that transform against mockResolveCleanupTarget's content.
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
  }
);

// ─── Imports ────────────────────────────────────────────────────────────────

import { StripLinesMatchingCapability } from '@/lib/orchestration/capabilities/built-in/document-cleanup/strip-lines-matching';
import type { CapabilityContext } from '@/lib/orchestration/capabilities/types';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const DOCUMENT_ID = 'doc-slm-001';

function makeContext(overrides: Partial<CapabilityContext> = {}): CapabilityContext {
  return {
    userId: 'user-1',
    agentId: 'agent-1',
    conversationId: 'conv-1',
    ...overrides,
  };
}

function makeTarget(content: string) {
  return {
    documentId: DOCUMENT_ID,
    content,
    originalContent: content,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('StripLinesMatchingCapability', () => {
  let capability: StripLinesMatchingCapability;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireEditableTarget.mockResolvedValue({ ok: true });
    capability = new StripLinesMatchingCapability();
    // Default: summariseMutation returns a realistic shape so we can assert on it
    mockSummariseMutation.mockImplementation((before: string, after: string) => ({
      charsRemoved: before.length - after.length,
      charsAfter: after.length,
      linesRemoved: before.split('\n').length - after.split('\n').length,
      linesAfter: after.split('\n').length,
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── not_cleanup_session ──────────────────────────────────────────────────

  it('returns not_cleanup_session error when resolveCleanupTarget returns null', async () => {
    // Arrange
    mockResolveCleanupTarget.mockResolvedValue(null);

    // Act
    const result = await capability.execute({ regex: 'foo' }, makeContext());

    // Assert: capability surfaces the correct error code — not a generic failure
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('not_cleanup_session');
    expect(mockWriteCleanupContent).not.toHaveBeenCalled();
  });

  it('returns target_locked when the edit lock is held by another admin', async () => {
    mockResolveCleanupTarget.mockResolvedValue({
      documentId: DOCUMENT_ID,
      content: 'a\nb',
      originalContent: 'a\nb',
    });
    mockRequireEditableTarget.mockResolvedValueOnce({ ok: false, heldBy: 'other-admin' });

    const result = await capability.execute({ regex: 'foo' }, makeContext());

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('target_locked');
    expect(mockWriteCleanupContent).not.toHaveBeenCalled();
  });

  // ── invalid regex ────────────────────────────────────────────────────────

  it('returns invalid_regex error when the regex string is not a valid pattern', async () => {
    // Arrange
    mockResolveCleanupTarget.mockResolvedValue(makeTarget('some content'));

    // Act
    const result = await capability.execute({ regex: '[invalid' }, makeContext());

    // Assert: invalid regex is flagged before any write
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('invalid_regex');
    expect(result.error?.message).toMatch(/invalid regex/i);
    expect(mockWriteCleanupContent).not.toHaveBeenCalled();
  });

  it('returns invalid_regex error for a pattern vulnerable to catastrophic backtracking', async () => {
    // Arrange — classic nested-quantifier ReDoS shape; must never reach .test()/.replace()
    mockResolveCleanupTarget.mockResolvedValue(makeTarget('some content'));

    // Act
    const result = await capability.execute({ regex: nestedQuantifierPattern('$') }, makeContext());

    // Assert: rejected before execution, not left to hang the process
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('invalid_regex');
    expect(result.error?.message).toMatch(/backtracking/i);
    expect(mockWriteCleanupContent).not.toHaveBeenCalled();
  });

  // ── no-op on already-clean input ────────────────────────────────────────

  it('returns success with charsRemoved === 0 when no lines match the pattern', async () => {
    // Arrange
    const content = 'Clean line one\nClean line two\nClean line three';
    mockResolveCleanupTarget.mockResolvedValue(makeTarget(content));

    // Act
    const result = await capability.execute({ regex: 'NOMATCH_PATTERN_XYZ' }, makeContext());

    // Assert: no lines removed → charsRemoved is 0 (transformation produced identical content)
    expect(result.success).toBe(true);
    expect(result.data?.charsRemoved).toBe(0);
    expect(result.data?.linesRemoved).toBe(0);
    // Content is unchanged, so writeCleanupContent was still called with the same content
    expect(mockWriteCleanupContent).toHaveBeenCalledWith(
      DOCUMENT_ID,
      content,
      expect.objectContaining({
        source: expect.stringMatching(/^capability:/),
        actorId: expect.anything(),
      })
    );
  });

  // ── common case: strips matching lines ──────────────────────────────────

  it('strips lines matching the pattern and writes the result', async () => {
    // Arrange
    const content = '[Music]\nHello world\n[Music]\nGoodbye world';
    const expectedNext = 'Hello world\nGoodbye world';
    mockResolveCleanupTarget.mockResolvedValue(makeTarget(content));

    // Act
    const result = await capability.execute({ regex: '^\\[Music\\]' }, makeContext());

    // Assert: two [Music] lines removed — writeCleanupContent was called with the stripped content
    expect(result.success).toBe(true);
    expect(mockWriteCleanupContent).toHaveBeenCalledWith(
      DOCUMENT_ID,
      expectedNext,
      expect.objectContaining({
        source: expect.stringMatching(/^capability:/),
        actorId: expect.anything(),
      })
    );
    // MutationSummary reflects the removal
    expect(result.data?.linesRemoved).toBe(2);
    expect(result.data?.charsAfter).toBe(expectedNext.length);
    // Pattern is echoed back to the caller
    expect(result.data?.pattern).toBe('^\\[Music\\]');
  });

  // ── flags are honoured ───────────────────────────────────────────────────

  it('honours the i flag for case-insensitive matching', async () => {
    // Arrange
    const content = '[music]\n[MUSIC]\nActual content\n[Music]';
    const expectedNext = 'Actual content';
    mockResolveCleanupTarget.mockResolvedValue(makeTarget(content));

    // Act
    const result = await capability.execute({ regex: '^\\[music\\]', flags: 'i' }, makeContext());

    // Assert: all three casing variants were stripped thanks to the i flag
    expect(result.success).toBe(true);
    expect(mockWriteCleanupContent).toHaveBeenCalledWith(
      DOCUMENT_ID,
      expectedNext,
      expect.objectContaining({
        source: expect.stringMatching(/^capability:/),
        actorId: expect.anything(),
      })
    );
    expect(result.data?.linesRemoved).toBe(3);
  });

  // ── MutationSummary shape ────────────────────────────────────────────────

  it('returns the full MutationSummary shape in result.data', async () => {
    // Arrange
    const content = 'keep\nremove this line\nkeep also';
    mockResolveCleanupTarget.mockResolvedValue(makeTarget(content));

    // Act
    const result = await capability.execute({ regex: 'remove' }, makeContext());

    // Assert: result.data contains all MutationSummary fields
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      charsRemoved: expect.any(Number),
      charsAfter: expect.any(Number),
      linesRemoved: expect.any(Number),
      linesAfter: expect.any(Number),
      pattern: 'remove',
    });
  });
});
