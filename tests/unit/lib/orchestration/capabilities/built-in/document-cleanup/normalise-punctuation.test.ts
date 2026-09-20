/**
 * Unit Tests: NormalisePunctuationCapability
 *
 * Tests for the normalise_punctuation capability, which converts typographic
 * punctuation to ASCII equivalents:
 * - Smart quotes -> straight quotes
 * - En/em dashes -> hyphens
 * - Ellipsis character -> "..."
 * - Non-breaking space -> space
 *
 * @see lib/orchestration/capabilities/built-in/document-cleanup/normalise-punctuation.ts
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

import { NormalisePunctuationCapability } from '@/lib/orchestration/capabilities/built-in/document-cleanup/normalise-punctuation';
import type { CapabilityContext } from '@/lib/orchestration/capabilities/types';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const DOCUMENT_ID = 'doc-np-001';

// Unicode escapes for typographic characters — avoids embedding invisible/irregular chars in source
const LSQUO = '‘'; // left single curly quote
const RSQUO = '’'; // right single curly quote
const SBQUO = '‚'; // single low-9 quote
const SBQUO2 = '‛'; // single reversed low-9 quote
const LDQUO = '“'; // left double curly quote
const RDQUO = '”'; // right double curly quote
const BDQUO = '„'; // double low-9 quote
const BDQUO2 = '‟'; // double reversed low-9 quote
const ENDASH = '–'; // en-dash
const EMDASH = '—'; // em-dash
const ELLIPSIS = '…'; // ellipsis character
const NBSP = ' '; // non-breaking space

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

describe('NormalisePunctuationCapability', () => {
  let capability: NormalisePunctuationCapability;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireEditableTarget.mockResolvedValue({ ok: true });
    capability = new NormalisePunctuationCapability();
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

  // ── smart quotes -> straight quotes ─────────────────────────────────────

  it('converts smart single quotes to straight single quotes', async () => {
    // Arrange: left/right single curly quotes and their low-9 variants
    const content = `${LSQUO}Hello${RSQUO} and ${SBQUO}world${SBQUO2}`;
    mockResolveCleanupTarget.mockResolvedValue(makeTarget(content));

    // Act
    const result = await capability.execute({}, makeContext());

    // Assert: all single curly quotes replaced with straight apostrophe
    expect(result.success).toBe(true);
    const written = vi.mocked(mockWriteCleanupContent).mock.calls[0]?.[1] as string;
    expect(written).toBe("'Hello' and 'world'");
  });

  it('converts smart double quotes to straight double quotes', async () => {
    // Arrange: left/right double curly quotes and their low-9 variants
    const content = `${LDQUO}Hello${RDQUO} and ${BDQUO}world${BDQUO2}`;
    mockResolveCleanupTarget.mockResolvedValue(makeTarget(content));

    // Act
    const result = await capability.execute({}, makeContext());

    // Assert: all double curly quotes replaced with straight double quote
    expect(result.success).toBe(true);
    const written = vi.mocked(mockWriteCleanupContent).mock.calls[0]?.[1] as string;
    expect(written).toBe('"Hello" and "world"');
  });

  // ── en/em dashes ────────────────────────────────────────────────────────

  it('converts en-dash to a single hyphen', async () => {
    // Arrange
    const content = `pages 10${ENDASH}15`;
    mockResolveCleanupTarget.mockResolvedValue(makeTarget(content));

    // Act
    const result = await capability.execute({}, makeContext());

    // Assert: en-dash -> '-'
    expect(result.success).toBe(true);
    const written = vi.mocked(mockWriteCleanupContent).mock.calls[0]?.[1] as string;
    expect(written).toBe('pages 10-15');
  });

  it('converts em-dash to double hyphen', async () => {
    // Arrange
    const content = `word${EMDASH}another`;
    mockResolveCleanupTarget.mockResolvedValue(makeTarget(content));

    // Act
    const result = await capability.execute({}, makeContext());

    // Assert: em-dash -> '--'
    expect(result.success).toBe(true);
    const written = vi.mocked(mockWriteCleanupContent).mock.calls[0]?.[1] as string;
    expect(written).toBe('word--another');
  });

  // ── ellipsis character ───────────────────────────────────────────────────

  it('converts the ellipsis character to three dots', async () => {
    // Arrange
    const content = `And so${ELLIPSIS} it goes${ELLIPSIS} on`;
    mockResolveCleanupTarget.mockResolvedValue(makeTarget(content));

    // Act
    const result = await capability.execute({}, makeContext());

    // Assert: ellipsis (U+2026) -> '...'
    expect(result.success).toBe(true);
    const written = vi.mocked(mockWriteCleanupContent).mock.calls[0]?.[1] as string;
    expect(written).toBe('And so... it goes... on');
  });

  // ── non-breaking space ───────────────────────────────────────────────────

  it('converts non-breaking spaces to regular spaces', async () => {
    // Arrange: non-breaking space (U+00A0) between words — use escape to avoid lint rule
    const content = `Hello${NBSP}world${NBSP}again`;
    mockResolveCleanupTarget.mockResolvedValue(makeTarget(content));

    // Act
    const result = await capability.execute({}, makeContext());

    // Assert: NBSP -> regular space
    expect(result.success).toBe(true);
    const written = vi.mocked(mockWriteCleanupContent).mock.calls[0]?.[1] as string;
    expect(written).toBe('Hello world again');
  });

  // ── substitutions count reflects all replacements ────────────────────────

  it('substitutions count reflects total replacements across all categories', async () => {
    // Arrange: 2 smart single + 2 smart double + en-dash + em-dash + ellipsis + NBSP = 8 substitutions
    const content = [
      `${LSQUO}single${RSQUO}`,
      `${LDQUO}double${RDQUO}`,
      `end${ENDASH}dash`,
      `em${EMDASH}dash`,
      `ellip${ELLIPSIS}`,
      `${NBSP}nbsp end`,
    ].join(' ');
    mockResolveCleanupTarget.mockResolvedValue(makeTarget(content));

    // Act
    const result = await capability.execute({}, makeContext());

    // Assert: 8 substitutions (2 singles + 2 doubles + 1 en-dash + 1 em-dash + 1 ellipsis + 1 NBSP)
    expect(result.success).toBe(true);
    expect(result.data?.substitutions).toBe(8);
  });

  // ── no-op on already-clean input ────────────────────────────────────────

  it('returns substitutions === 0 when content uses only ASCII punctuation', async () => {
    // Arrange: already-normalised text
    const content = 'Hello \'world\' and "goodbye" -- done...';
    mockResolveCleanupTarget.mockResolvedValue(makeTarget(content));

    // Act
    const result = await capability.execute({}, makeContext());

    // Assert: nothing to substitute
    expect(result.success).toBe(true);
    expect(result.data?.substitutions).toBe(0);
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
    const content = `Hello${ELLIPSIS}world`;
    mockResolveCleanupTarget.mockResolvedValue(makeTarget(content));

    // Act
    await capability.execute({}, makeContext());

    // Assert: write called with the correct doc id
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

  it('returns the full MutationSummary shape plus substitutions', async () => {
    // Arrange
    const content = `${LDQUO}Hello${RDQUO} world`;
    mockResolveCleanupTarget.mockResolvedValue(makeTarget(content));

    // Act
    const result = await capability.execute({}, makeContext());

    // Assert
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      charsRemoved: expect.any(Number),
      charsAfter: expect.any(Number),
      linesRemoved: expect.any(Number),
      linesAfter: expect.any(Number),
      substitutions: expect.any(Number),
    });
  });
});
