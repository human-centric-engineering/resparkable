/**
 * Unit Tests: CollapseWhitespaceCapability
 *
 * Tests for the collapse_whitespace capability, which collapses tabs/spaces,
 * trims trailing whitespace per line, and optionally removes blank lines.
 *
 * Key rules tested:
 * - Collapses tabs and multiple spaces to a single space
 * - Trims trailing whitespace per line
 * - keepBlankLines: true (default) → collapses \n\n\n+ to \n\n
 * - keepBlankLines: false → removes all blank lines
 *
 * @see lib/orchestration/capabilities/built-in/document-cleanup/collapse-whitespace.ts
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

import { CollapseWhitespaceCapability } from '@/lib/orchestration/capabilities/built-in/document-cleanup/collapse-whitespace';
import type { CapabilityContext } from '@/lib/orchestration/capabilities/types';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const DOCUMENT_ID = 'doc-cw-001';

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

describe('CollapseWhitespaceCapability', () => {
  let capability: CollapseWhitespaceCapability;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireEditableTarget.mockResolvedValue({ ok: true });
    capability = new CollapseWhitespaceCapability();
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

  // ── collapses multiple spaces ────────────────────────────────────────────

  it('collapses multiple spaces to a single space within a line', async () => {
    // Arrange: multiple spaces between words
    const content = 'Hello   world  how    are you';
    mockResolveCleanupTarget.mockResolvedValue(makeTarget(content));

    // Act
    const result = await capability.execute({}, makeContext());

    // Assert: all multi-space runs collapsed
    expect(result.success).toBe(true);
    const written = vi.mocked(mockWriteCleanupContent).mock.calls[0]?.[1] as string;
    expect(written).toBe('Hello world how are you');
  });

  // ── collapses tabs ────────────────────────────────────────────────────────

  it('collapses tabs to a single space', async () => {
    // Arrange: tabs between words
    const content = 'Word\t\there\t\t\tand there';
    mockResolveCleanupTarget.mockResolvedValue(makeTarget(content));

    // Act
    const result = await capability.execute({}, makeContext());

    // Assert: tabs collapsed to single spaces
    expect(result.success).toBe(true);
    const written = vi.mocked(mockWriteCleanupContent).mock.calls[0]?.[1] as string;
    expect(written).toBe('Word here and there');
  });

  // ── trims trailing whitespace per line ───────────────────────────────────

  it('trims trailing whitespace from each line', async () => {
    // Arrange: lines with trailing spaces/tabs
    const content = 'Line one   \nLine two\t\t\nLine three ';
    mockResolveCleanupTarget.mockResolvedValue(makeTarget(content));

    // Act
    const result = await capability.execute({}, makeContext());

    // Assert: each line has no trailing whitespace
    expect(result.success).toBe(true);
    const written = vi.mocked(mockWriteCleanupContent).mock.calls[0]?.[1] as string;
    const lines = written.split('\n');
    for (const line of lines) {
      expect(line).toBe(line.trimEnd());
    }
  });

  // ── keepBlankLines: true (default) collapses blank runs to one blank ─────

  it('keepBlankLines: true (default) collapses 3+ consecutive blank lines to 2', async () => {
    // Arrange: three consecutive blank lines between paragraphs
    const content = 'Para one\n\n\n\nPara two';
    mockResolveCleanupTarget.mockResolvedValue(makeTarget(content));

    // Act: omit keepBlankLines → defaults to true
    const result = await capability.execute({}, makeContext());

    // Assert: run of 4 newlines collapsed to \n\n (one blank line between paragraphs)
    expect(result.success).toBe(true);
    const written = vi.mocked(mockWriteCleanupContent).mock.calls[0]?.[1] as string;
    expect(written).toBe('Para one\n\nPara two');
    expect(result.data?.keepBlankLines).toBe(true);
  });

  // ── keepBlankLines: false removes all blank lines ────────────────────────

  it('keepBlankLines: false removes all blank lines from the document', async () => {
    // Arrange: blank lines between content lines
    const content = 'Line one\n\nLine two\n\n\nLine three';
    mockResolveCleanupTarget.mockResolvedValue(makeTarget(content));

    // Act
    const result = await capability.execute({ keepBlankLines: false }, makeContext());

    // Assert: no blank lines remain
    expect(result.success).toBe(true);
    const written = vi.mocked(mockWriteCleanupContent).mock.calls[0]?.[1] as string;
    expect(written).toBe('Line one\nLine two\nLine three');
    expect(result.data?.keepBlankLines).toBe(false);
  });

  // ── no-op on already-clean input ────────────────────────────────────────

  it('returns charsRemoved === 0 when content is already clean', async () => {
    // Arrange: content already has single spaces, no trailing whitespace, single blank lines
    const content = 'Clean line one\n\nClean line two\nClean line three';
    mockResolveCleanupTarget.mockResolvedValue(makeTarget(content));

    // Act
    const result = await capability.execute({ keepBlankLines: true }, makeContext());

    // Assert: no changes needed
    expect(result.success).toBe(true);
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

  it('calls writeCleanupContent with the correct document id', async () => {
    // Arrange
    const content = 'Hello   world';
    mockResolveCleanupTarget.mockResolvedValue(makeTarget(content));

    // Act
    await capability.execute({}, makeContext());

    // Assert
    expect(mockWriteCleanupContent).toHaveBeenCalledWith(
      DOCUMENT_ID,
      expect.any(String),
      expect.objectContaining({
        source: expect.stringMatching(/^capability:/),
        actorId: expect.anything(),
      })
    );
  });

  // ── MutationSummary shape ────────────────────────────────────────────────

  it('returns the full MutationSummary shape plus keepBlankLines', async () => {
    // Arrange
    const content = 'Hello   world\n\n\nNew para';
    mockResolveCleanupTarget.mockResolvedValue(makeTarget(content));

    // Act
    const result = await capability.execute({ keepBlankLines: false }, makeContext());

    // Assert
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      charsRemoved: expect.any(Number),
      charsAfter: expect.any(Number),
      linesRemoved: expect.any(Number),
      linesAfter: expect.any(Number),
      keepBlankLines: false,
    });
  });
});
