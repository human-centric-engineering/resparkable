/**
 * Unit Tests: StripSpeakerLabelsCapability
 *
 * Tests for the strip_speaker_labels capability, which removes speaker labels
 * (e.g. "John:", "[Mary Smith]") from the start of transcript lines.
 *
 * Key rules tested:
 * - format: 'colon'     strips "Name:" but NOT "[Name]"
 * - format: 'bracketed' strips "[Name]" but NOT "Name:"
 * - format: 'both'      (default) strips either form
 * - Multi-word names (up to 4 words) are matched
 * - Non-capitalised speakers (e.g. "john:") are NOT matched
 *
 * @see lib/orchestration/capabilities/built-in/document-cleanup/strip-speaker-labels.ts
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

import { StripSpeakerLabelsCapability } from '@/lib/orchestration/capabilities/built-in/document-cleanup/strip-speaker-labels';
import type { CapabilityContext } from '@/lib/orchestration/capabilities/types';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const DOCUMENT_ID = 'doc-ssl-001';

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

describe('StripSpeakerLabelsCapability', () => {
  let capability: StripSpeakerLabelsCapability;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireEditableTarget.mockResolvedValue({ ok: true });
    capability = new StripSpeakerLabelsCapability();
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

  // ── format: 'colon' ─────────────────────────────────────────────────────

  it("format: 'colon' strips colon-form labels but NOT bracketed-form labels", async () => {
    // Arrange
    const content = 'John: Hello there\n[Mary Smith] How are you\nMary Smith: I am fine';
    mockResolveCleanupTarget.mockResolvedValue(makeTarget(content));

    // Act
    const result = await capability.execute({ format: 'colon' }, makeContext());

    // Assert: "John:" and "Mary Smith:" stripped; "[Mary Smith]" preserved
    expect(result.success).toBe(true);
    const written = vi.mocked(mockWriteCleanupContent).mock.calls[0]?.[1] as string;
    expect(written).not.toContain('John:');
    expect(written).not.toContain('Mary Smith:');
    expect(written).toContain('[Mary Smith]');
    expect(written).toContain('I am fine');
    expect(result.data?.format).toBe('colon');
  });

  // ── format: 'bracketed' ──────────────────────────────────────────────────

  it("format: 'bracketed' strips bracketed-form labels but NOT colon-form labels", async () => {
    // Arrange
    const content = '[John] Hello there\nMary: How are you\n[Bob Smith] Goodbye';
    mockResolveCleanupTarget.mockResolvedValue(makeTarget(content));

    // Act
    const result = await capability.execute({ format: 'bracketed' }, makeContext());

    // Assert: "[John]" and "[Bob Smith]" stripped; "Mary:" preserved
    expect(result.success).toBe(true);
    const written = vi.mocked(mockWriteCleanupContent).mock.calls[0]?.[1] as string;
    expect(written).not.toContain('[John]');
    expect(written).not.toContain('[Bob Smith]');
    expect(written).toContain('Mary:');
    expect(result.data?.format).toBe('bracketed');
  });

  // ── format: 'both' (default) ─────────────────────────────────────────────

  it("format: 'both' (default) strips both colon and bracketed forms", async () => {
    // Arrange
    const content = 'John: Hello\n[Mary] How are you\nContent without label';
    mockResolveCleanupTarget.mockResolvedValue(makeTarget(content));

    // Act: omit format → defaults to 'both'
    const result = await capability.execute({}, makeContext());

    // Assert: both label forms stripped
    expect(result.success).toBe(true);
    const written = vi.mocked(mockWriteCleanupContent).mock.calls[0]?.[1] as string;
    expect(written).not.toContain('John:');
    expect(written).not.toContain('[Mary]');
    expect(written).toContain('Content without label');
    expect(result.data?.format).toBe('both');
  });

  // ── multi-word names ─────────────────────────────────────────────────────

  it('matches multi-word names up to 4 capitalised words', async () => {
    // Arrange: two-word, three-word, and four-word speaker names
    const content =
      'Mary Smith: two words\nJohn Paul Jones: three words\nAnna Marie Du Bois: four words';
    mockResolveCleanupTarget.mockResolvedValue(makeTarget(content));

    // Act
    const result = await capability.execute({ format: 'colon' }, makeContext());

    // Assert: all three multi-word labels stripped
    expect(result.success).toBe(true);
    const written = vi.mocked(mockWriteCleanupContent).mock.calls[0]?.[1] as string;
    expect(written).not.toContain('Mary Smith:');
    expect(written).not.toContain('John Paul Jones:');
    expect(written).not.toContain('Anna Marie Du Bois:');
    expect(written).toContain('two words');
    expect(written).toContain('three words');
    expect(written).toContain('four words');
  });

  // ── non-capitalised speakers NOT matched ────────────────────────────────

  it('does NOT strip non-capitalised speaker labels (e.g. "john:")', async () => {
    // Arrange: lowercase speaker labels should be preserved
    const content = 'john: some text\nmary: other text\nCapitalized: this one stripped';
    mockResolveCleanupTarget.mockResolvedValue(makeTarget(content));

    // Act
    const result = await capability.execute({ format: 'colon' }, makeContext());

    // Assert: lowercase labels preserved, capitalised label stripped
    expect(result.success).toBe(true);
    const written = vi.mocked(mockWriteCleanupContent).mock.calls[0]?.[1] as string;
    expect(written).toContain('john:');
    expect(written).toContain('mary:');
    expect(written).not.toContain('Capitalized:');
  });

  // ── no-op on already-clean input ────────────────────────────────────────

  it('returns charsRemoved === 0 when no speaker labels are present', async () => {
    // Arrange
    const content = 'plain paragraph\nanother paragraph\nno labels here';
    mockResolveCleanupTarget.mockResolvedValue(makeTarget(content));

    // Act
    const result = await capability.execute({ format: 'both' }, makeContext());

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

  // ── removed count ────────────────────────────────────────────────────────

  it('removed count reflects total label occurrences across both forms', async () => {
    // Arrange: two colon labels + two bracketed labels
    const content = 'John: text\n[Mary] text\nBob: text\n[Alice] text';
    mockResolveCleanupTarget.mockResolvedValue(makeTarget(content));

    // Act
    const result = await capability.execute({ format: 'both' }, makeContext());

    // Assert: removed = 4 (one per label)
    expect(result.success).toBe(true);
    expect(result.data?.removed).toBe(4);
  });

  // ── writeCleanupContent called with doc id ───────────────────────────────

  it('calls writeCleanupContent with the correct document id and transformed content', async () => {
    // Arrange
    const content = 'John: Hello world';
    mockResolveCleanupTarget.mockResolvedValue(makeTarget(content));

    // Act
    await capability.execute({ format: 'colon' }, makeContext());

    // Assert: write called with correct doc id and stripped content
    expect(mockWriteCleanupContent).toHaveBeenCalledWith(
      DOCUMENT_ID,
      'Hello world',
      expect.objectContaining({
        source: expect.stringMatching(/^capability:/),
        actorId: expect.anything(),
      })
    );
  });

  // ── MutationSummary shape ────────────────────────────────────────────────

  it('returns the full MutationSummary shape plus format and removed', async () => {
    // Arrange
    const content = 'John: some text';
    mockResolveCleanupTarget.mockResolvedValue(makeTarget(content));

    // Act
    const result = await capability.execute({ format: 'colon' }, makeContext());

    // Assert
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      charsRemoved: expect.any(Number),
      charsAfter: expect.any(Number),
      linesRemoved: expect.any(Number),
      linesAfter: expect.any(Number),
      format: 'colon',
      removed: expect.any(Number),
    });
  });

  // ── regression: horizontal whitespace only ───────────────────────────────

  it('leaves the preceding line alone when a speaker turn follows a capitalised line', async () => {
    // Arrange: `\s` also matches `\n`, so under the `m` flag the old pattern
    // started matching on "Introduction", ran through the newline and finished
    // at "Bob:" — deleting the heading and joining the two lines.
    const content = 'Introduction\nBob: hello there';
    mockResolveCleanupTarget.mockResolvedValue(makeTarget(content));

    // Act
    await capability.execute({ format: 'colon' }, makeContext());

    // Assert
    const written = vi.mocked(mockWriteCleanupContent).mock.calls[0]?.[1] as string;
    expect(written).toBe('Introduction\nhello there');
  });

  it('does not join lines when a bracketed label sits alone on its own line', async () => {
    // Arrange: the trailing `\s?` used to swallow the newline after "[Bob]".
    const content = '[Bob]\nhello there';
    mockResolveCleanupTarget.mockResolvedValue(makeTarget(content));

    // Act
    await capability.execute({ format: 'bracketed' }, makeContext());

    // Assert
    const written = vi.mocked(mockWriteCleanupContent).mock.calls[0]?.[1] as string;
    expect(written).toBe('\nhello there');
  });

  it('still strips multi-word labels separated by spaces', async () => {
    // Arrange: the fix narrowed `\s` to `[ \t]` — multi-word labels on one
    // line must keep working.
    const content = 'Mary Smith: hi\nJohn: yes';
    mockResolveCleanupTarget.mockResolvedValue(makeTarget(content));

    // Act
    const result = await capability.execute({ format: 'colon' }, makeContext());

    // Assert
    const written = vi.mocked(mockWriteCleanupContent).mock.calls[0]?.[1] as string;
    expect(written).toBe('hi\nyes');
    expect(result.data?.removed).toBe(2);
  });
});
