/**
 * Unit Tests: StripTimestampsCapability
 *
 * Tests for the strip_timestamps capability, which removes timestamp markers
 * in four formats. Bracketed/parenthesised formats are stripped before plain
 * so that [12:34] doesn't leave dangling brackets.
 *
 * @see lib/orchestration/capabilities/built-in/document-cleanup/strip-timestamps.ts
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

import { StripTimestampsCapability } from '@/lib/orchestration/capabilities/built-in/document-cleanup/strip-timestamps';
import type { CapabilityContext } from '@/lib/orchestration/capabilities/types';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const DOCUMENT_ID = 'doc-ts-001';

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

describe('StripTimestampsCapability', () => {
  let capability: StripTimestampsCapability;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireEditableTarget.mockResolvedValue({ ok: true });
    capability = new StripTimestampsCapability();
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

  // ── default removes all four formats ────────────────────────────────────

  it('removes all four timestamp formats when formats is omitted (default)', async () => {
    // Arrange: one of each format on separate lines
    const content =
      'Text 12:34 more\n[01:23:45] bracketed\n(00:00) parenthesised\nEnd 9:59:59 done';
    mockResolveCleanupTarget.mockResolvedValue(makeTarget(content));

    // Act: no formats specified → default removes all
    const result = await capability.execute({}, makeContext());

    // Assert: all timestamps stripped — writeCleanupContent called with cleaned content
    expect(result.success).toBe(true);
    const writtenContent = vi.mocked(mockWriteCleanupContent).mock.calls[0]?.[1] as string;
    // All timestamp forms removed
    expect(writtenContent).not.toMatch(/\d{1,2}:\d{2}/);
    expect(writtenContent).not.toMatch(/\[\d/);
    expect(writtenContent).not.toMatch(/\(\d/);
    // removed count reflects matches across all formats
    expect(result.data?.removed).toBe(4);
    // formats echoed back
    expect(result.data?.formats).toEqual(['hh_mm', 'hh_mm_ss', 'bracketed', 'parenthesised']);
  });

  // ── explicit subset ──────────────────────────────────────────────────────

  it('removes only bracketed timestamps when formats: [bracketed] is specified', async () => {
    // Arrange: bracketed and plain timestamps present
    const content = 'Hello [12:34] world 00:42 end';
    mockResolveCleanupTarget.mockResolvedValue(makeTarget(content));

    // Act: only bracketed format requested
    const result = await capability.execute({ formats: ['bracketed'] }, makeContext());

    // Assert: [12:34] stripped; 00:42 preserved
    expect(result.success).toBe(true);
    const writtenContent = vi.mocked(mockWriteCleanupContent).mock.calls[0]?.[1] as string;
    expect(writtenContent).toContain('00:42');
    expect(writtenContent).not.toContain('[12:34]');
    expect(result.data?.formats).toEqual(['bracketed']);
    expect(result.data?.removed).toBe(1);
  });

  it('removes only hh_mm timestamps when formats: [hh_mm] is specified', async () => {
    // Arrange: content where timestamps are NOT embedded inside brackets/parens
    // Note: when only hh_mm is selected, the bracketed/parenthesised runners don't fire first,
    // so the hh_mm regex can match the inner digits of [12:34] too. Use non-bracketed content
    // to test the subset-format path cleanly.
    const content = 'plain 12:34 here and standalone 56:78 end';
    mockResolveCleanupTarget.mockResolvedValue(makeTarget(content));

    // Act: only hh_mm requested
    const result = await capability.execute({ formats: ['hh_mm'] }, makeContext());

    // Assert: both plain hh_mm timestamps stripped; formats echoed back
    expect(result.success).toBe(true);
    const writtenContent = vi.mocked(mockWriteCleanupContent).mock.calls[0]?.[1] as string;
    expect(writtenContent).not.toMatch(/\d{1,2}:\d{2}/);
    expect(result.data?.formats).toEqual(['hh_mm']);
    expect(result.data?.removed).toBe(2);
  });

  // ── bracketed/parenthesised before plain to avoid dangling brackets ──────

  it('strips [12:34] without leaving dangling brackets (bracketed before plain)', async () => {
    // Arrange: if hh_mm ran first, it would turn [12:34] into []-style dangling brackets
    const content = 'Before [12:34] after';
    mockResolveCleanupTarget.mockResolvedValue(makeTarget(content));

    // Act: default (all formats)
    const result = await capability.execute({}, makeContext());

    // Assert: no dangling brackets remain
    expect(result.success).toBe(true);
    const writtenContent = vi.mocked(mockWriteCleanupContent).mock.calls[0]?.[1] as string;
    expect(writtenContent).not.toContain('[]');
    expect(writtenContent).toBe('Before  after');
  });

  it('strips (12:34) without leaving dangling parens (parenthesised before plain)', async () => {
    // Arrange
    const content = 'Text (00:59) more text';
    mockResolveCleanupTarget.mockResolvedValue(makeTarget(content));

    // Act
    const result = await capability.execute({}, makeContext());

    // Assert: no dangling parentheses
    expect(result.success).toBe(true);
    const writtenContent = vi.mocked(mockWriteCleanupContent).mock.calls[0]?.[1] as string;
    expect(writtenContent).not.toContain('()');
    expect(writtenContent).toBe('Text  more text');
  });

  // ── removed count across formats ─────────────────────────────────────────

  it('removed count reflects matches across all selected formats', async () => {
    // Arrange: two bracketed + one parenthesised + one plain
    const content = '[00:01] [00:02] (00:03) 00:04 clean text';
    mockResolveCleanupTarget.mockResolvedValue(makeTarget(content));

    // Act
    const result = await capability.execute({}, makeContext());

    // Assert: removed == 4 (one per format occurrence)
    expect(result.success).toBe(true);
    expect(result.data?.removed).toBe(4);
  });

  // ── no-op on already-clean input ────────────────────────────────────────

  it('returns charsRemoved === 0 when content has no timestamps', async () => {
    // Arrange
    const content = 'Clean transcript with no timestamps at all.';
    mockResolveCleanupTarget.mockResolvedValue(makeTarget(content));

    // Act
    const result = await capability.execute({}, makeContext());

    // Assert
    expect(result.success).toBe(true);
    expect(result.data?.charsRemoved).toBe(0);
    expect(result.data?.removed).toBe(0);
    expect(mockWriteCleanupContent).toHaveBeenCalledWith(
      DOCUMENT_ID,
      content,
      expect.objectContaining({
        source: expect.stringMatching(/^capability:/),
        actorId: expect.anything(),
      })
    );
  });

  // ── MutationSummary shape ────────────────────────────────────────────────

  it('returns the full MutationSummary shape plus formats and removed', async () => {
    // Arrange
    const content = '12:34 some text';
    mockResolveCleanupTarget.mockResolvedValue(makeTarget(content));

    // Act
    const result = await capability.execute({ formats: ['hh_mm'] }, makeContext());

    // Assert: all expected data fields present
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      charsRemoved: expect.any(Number),
      charsAfter: expect.any(Number),
      linesRemoved: expect.any(Number),
      linesAfter: expect.any(Number),
      formats: ['hh_mm'],
      removed: expect.any(Number),
    });
  });

  // ── writeCleanupContent called with doc id ───────────────────────────────

  it('calls writeCleanupContent with the correct document id', async () => {
    // Arrange
    const content = '[12:34] some text';
    mockResolveCleanupTarget.mockResolvedValue(makeTarget(content));

    // Act
    await capability.execute({}, makeContext());

    // Assert: the correct doc id is passed to the write helper
    expect(mockWriteCleanupContent).toHaveBeenCalledWith(
      DOCUMENT_ID,
      expect.any(String),
      expect.objectContaining({
        source: expect.stringMatching(/^capability:/),
        actorId: expect.anything(),
      })
    );
  });
});
