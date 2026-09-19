/**
 * Unit Tests: DedupeLinesCapability
 *
 * Tests for the dedupe_lines capability, which removes duplicate lines.
 * Two modes:
 * - consecutiveOnly: true (default) — removes only adjacent duplicates
 * - consecutiveOnly: false — removes all duplicates across the document
 *
 * @see lib/orchestration/capabilities/built-in/document-cleanup/dedupe-lines.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────────────

// vi.mock is hoisted — use vi.hoisted() so mock fn refs exist before the factory runs
const { mockResolveCleanupTarget, mockWriteCleanupContent, mockSummariseMutation } = vi.hoisted(
  () => ({
    mockResolveCleanupTarget: vi.fn(),
    mockWriteCleanupContent: vi.fn(),
    mockSummariseMutation: vi.fn(),
  })
);

// The capability now mutates through `mutateCleanupContent`, which owns the
// row-locked transaction. These tests exercise the transform it passes in, so
// the transaction is replaced by a double that runs that transform against
// `mockResolveCleanupTarget`'s content and records the write. Every existing
// arrange/assert below keeps its original meaning.
vi.mock('@/lib/orchestration/capabilities/built-in/document-cleanup/context', async () => {
  const { makeMutateCleanupContentDouble, describeRefusalDouble } =
    await import('@/tests/helpers/cleanup-mutation');
  return {
    mutateCleanupContent: makeMutateCleanupContentDouble({
      resolveTarget: (context) => mockResolveCleanupTarget(context),
      requireEditable: (documentId, userId) => mockRequireEditableTarget(documentId, userId),
      recordWrite: (documentId, content, opts) =>
        mockWriteCleanupContent(documentId, content, opts),
      summarise: (before, after) => mockSummariseMutation(before, after),
    }),
    describeRefusal: describeRefusalDouble,
  };
});

const { mockRequireEditableTarget } = vi.hoisted(() => ({
  mockRequireEditableTarget: vi.fn(),
}));

// ─── Imports ────────────────────────────────────────────────────────────────

import { DedupeLinesCapability } from '@/lib/orchestration/capabilities/built-in/document-cleanup/dedupe-lines';
import type { CapabilityContext } from '@/lib/orchestration/capabilities/types';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const DOCUMENT_ID = 'doc-dl-001';

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

describe('DedupeLinesCapability', () => {
  let capability: DedupeLinesCapability;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireEditableTarget.mockResolvedValue({ ok: true });
    capability = new DedupeLinesCapability();
    // Real summariseMutation logic for accurate assertions
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
    const result = await capability.execute({}, makeContext());

    // Assert
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('not_cleanup_session');
    expect(mockWriteCleanupContent).not.toHaveBeenCalled();
  });

  // ── consecutiveOnly: true (default) ─────────────────────────────────────

  it('consecutiveOnly: true (default) removes only adjacent duplicate lines', async () => {
    // Arrange: "Line A" appears twice consecutively, then again non-consecutively
    const content = 'Line A\nLine A\nLine B\nLine A';
    mockResolveCleanupTarget.mockResolvedValue(makeTarget(content));

    // Act: omit consecutiveOnly → defaults to true
    const result = await capability.execute({}, makeContext());

    // Assert: only the consecutive pair is deduped; the non-consecutive repeat kept
    expect(result.success).toBe(true);
    const written = vi.mocked(mockWriteCleanupContent).mock.calls[0]?.[1] as string;
    // After deduping adjacent: ['Line A', 'Line B', 'Line A'] — the third 'Line A' stays
    expect(written).toBe('Line A\nLine B\nLine A');
    expect(result.data?.consecutiveOnly).toBe(true);
    expect(result.data?.removed).toBe(1);
  });

  it('consecutiveOnly: true collapses a run of 3 consecutive duplicates to 1', async () => {
    // Arrange: stutter — three identical lines in a row
    const content = 'Stutter\nStutter\nStutter\nNormal line';
    mockResolveCleanupTarget.mockResolvedValue(makeTarget(content));

    // Act
    const result = await capability.execute({ consecutiveOnly: true }, makeContext());

    // Assert: three-run collapses to one; normal line preserved
    expect(result.success).toBe(true);
    const written = vi.mocked(mockWriteCleanupContent).mock.calls[0]?.[1] as string;
    expect(written).toBe('Stutter\nNormal line');
    expect(result.data?.removed).toBe(2);
  });

  // ── consecutiveOnly: false ───────────────────────────────────────────────

  it('consecutiveOnly: false removes all duplicate lines across the document', async () => {
    // Arrange: "Line A" appears at positions 1, 3, and 5 (non-consecutive)
    const content = 'Line A\nLine B\nLine A\nLine C\nLine A';
    mockResolveCleanupTarget.mockResolvedValue(makeTarget(content));

    // Act
    const result = await capability.execute({ consecutiveOnly: false }, makeContext());

    // Assert: only the first occurrence of each line is kept
    expect(result.success).toBe(true);
    const written = vi.mocked(mockWriteCleanupContent).mock.calls[0]?.[1] as string;
    expect(written).toBe('Line A\nLine B\nLine C');
    expect(result.data?.consecutiveOnly).toBe(false);
    expect(result.data?.removed).toBe(2);
  });

  // ── removed reflects line count delta ────────────────────────────────────

  it('removed equals the number of lines eliminated', async () => {
    // Arrange: 5 lines input, 3 lines output → removed = 2
    const content = 'alpha\nbeta\nalpha\ngamma\nbeta';
    mockResolveCleanupTarget.mockResolvedValue(makeTarget(content));

    // Act
    const result = await capability.execute({ consecutiveOnly: false }, makeContext());

    // Assert: removed == input.lines - output.lines
    expect(result.success).toBe(true);
    expect(result.data?.removed).toBe(2);
    expect(result.data?.linesRemoved).toBe(2);
  });

  // ── no-op on already-clean input ────────────────────────────────────────

  it('returns removed === 0 when all lines are already unique', async () => {
    // Arrange
    const content = 'alpha\nbeta\ngamma\ndelta';
    mockResolveCleanupTarget.mockResolvedValue(makeTarget(content));

    // Act
    const result = await capability.execute({}, makeContext());

    // Assert: no lines removed
    expect(result.success).toBe(true);
    expect(result.data?.removed).toBe(0);
    expect(result.data?.charsRemoved).toBe(0);
    expect(mockWriteCleanupContent).toHaveBeenCalledWith(
      DOCUMENT_ID,
      content,
      expect.objectContaining({
        source: expect.stringMatching(/^capability:/),
        actorId: expect.anything(),
      })
    );
  });

  // ── writeCleanupContent called with doc id ───────────────────────────────

  it('calls writeCleanupContent with the correct document id and deduped content', async () => {
    // Arrange
    const content = 'dup\ndup\nunique';
    mockResolveCleanupTarget.mockResolvedValue(makeTarget(content));

    // Act
    await capability.execute({}, makeContext());

    // Assert
    expect(mockWriteCleanupContent).toHaveBeenCalledWith(
      DOCUMENT_ID,
      'dup\nunique',
      expect.objectContaining({
        source: expect.stringMatching(/^capability:/),
        actorId: expect.anything(),
      })
    );
  });

  // ── MutationSummary shape ────────────────────────────────────────────────

  it('returns the full MutationSummary shape plus consecutiveOnly and removed', async () => {
    // Arrange
    const content = 'dup\ndup\nunique';
    mockResolveCleanupTarget.mockResolvedValue(makeTarget(content));

    // Act
    const result = await capability.execute({ consecutiveOnly: false }, makeContext());

    // Assert
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      charsRemoved: expect.any(Number),
      charsAfter: expect.any(Number),
      linesRemoved: expect.any(Number),
      linesAfter: expect.any(Number),
      consecutiveOnly: false,
      removed: expect.any(Number),
    });
  });
});
