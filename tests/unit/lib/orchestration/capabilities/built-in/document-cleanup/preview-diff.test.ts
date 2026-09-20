/**
 * Unit Tests: PreviewDiffCapability
 *
 * Tests for the preview_diff capability, which is READ-ONLY — it summarises
 * the diff between originalContent and current processedContent without
 * mutating the document.
 *
 * Key contract:
 * - Does NOT call writeCleanupContent under any circumstances
 * - Returns charsOriginal, charsCurrent, charsRemoved, linesOriginal,
 *   linesCurrent, linesRemoved, reductionPct
 * - reductionPct is 0 when originalContent is empty (avoids divide-by-zero)
 * - linesRemoved can be negative if cleanup added lines
 *
 * @see lib/orchestration/capabilities/built-in/document-cleanup/preview-diff.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────────────

// vi.mock is hoisted — use vi.hoisted() so mock fn refs exist before the factory runs
const { mockResolveCleanupTarget, mockWriteCleanupContent } = vi.hoisted(() => ({
  mockResolveCleanupTarget: vi.fn(),
  // writeCleanupContent is mocked so we can assert it is NEVER called
  mockWriteCleanupContent: vi.fn(),
}));

vi.mock('@/lib/orchestration/capabilities/built-in/document-cleanup/context', () => ({
  resolveCleanupTarget: mockResolveCleanupTarget,
  writeCleanupContent: mockWriteCleanupContent,
  // summariseMutation is not imported by preview-diff, but included for completeness
  summariseMutation: vi.fn(),
}));

// ─── Imports ────────────────────────────────────────────────────────────────

import { PreviewDiffCapability } from '@/lib/orchestration/capabilities/built-in/document-cleanup/preview-diff';
import type { CapabilityContext } from '@/lib/orchestration/capabilities/types';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const DOCUMENT_ID = 'doc-pd-001';

function makeContext(overrides: Partial<CapabilityContext> = {}): CapabilityContext {
  return {
    userId: 'user-1',
    agentId: 'agent-1',
    conversationId: 'conv-1',
    ...overrides,
  };
}

function makeTarget(originalContent: string, processedContent?: string) {
  return {
    documentId: DOCUMENT_ID,
    // content = processedContent if set, otherwise originalContent (mirrors context.ts logic)
    content: processedContent ?? originalContent,
    originalContent,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('PreviewDiffCapability', () => {
  let capability: PreviewDiffCapability;

  beforeEach(() => {
    vi.clearAllMocks();
    capability = new PreviewDiffCapability();
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
    // Read-only — write must never be called
    expect(mockWriteCleanupContent).not.toHaveBeenCalled();
  });

  // ── read-only — does NOT call writeCleanupContent ────────────────────────

  it('does NOT call writeCleanupContent even on a successful diff', async () => {
    // Arrange: target with original and processed content
    const original = 'Line one\nLine two\nLine three';
    const current = 'Line one\nLine three';
    mockResolveCleanupTarget.mockResolvedValue(makeTarget(original, current));

    // Act
    const result = await capability.execute({}, makeContext());

    // Assert: success but ZERO write calls — this is the key read-only contract
    expect(result.success).toBe(true);
    expect(mockWriteCleanupContent).not.toHaveBeenCalled();
  });

  // ── returns charsOriginal, charsCurrent ──────────────────────────────────

  it('returns charsOriginal and charsCurrent based on actual string lengths', async () => {
    // Arrange
    const original = 'abcde'; // 5 chars
    const current = 'abc'; // 3 chars
    mockResolveCleanupTarget.mockResolvedValue(makeTarget(original, current));

    // Act
    const result = await capability.execute({}, makeContext());

    // Assert: char counts are computed from the strings, not from a mock
    expect(result.success).toBe(true);
    expect(result.data?.charsOriginal).toBe(5);
    expect(result.data?.charsCurrent).toBe(3);
    expect(result.data?.charsRemoved).toBe(2);
  });

  // ── returns linesOriginal, linesCurrent ──────────────────────────────────

  it('returns linesOriginal and linesCurrent based on newline splits', async () => {
    // Arrange: original has 3 lines, current has 2
    const original = 'line1\nline2\nline3';
    const current = 'line1\nline3';
    mockResolveCleanupTarget.mockResolvedValue(makeTarget(original, current));

    // Act
    const result = await capability.execute({}, makeContext());

    // Assert
    expect(result.success).toBe(true);
    expect(result.data?.linesOriginal).toBe(3);
    expect(result.data?.linesCurrent).toBe(2);
    expect(result.data?.linesRemoved).toBe(1);
  });

  // ── reductionPct is 0 when original is empty ─────────────────────────────

  it('returns reductionPct === 0 when originalContent is empty (avoids divide-by-zero)', async () => {
    // Arrange: empty original content
    mockResolveCleanupTarget.mockResolvedValue(makeTarget('', ''));

    // Act
    const result = await capability.execute({}, makeContext());

    // Assert: no division by zero — reductionPct stays at 0
    expect(result.success).toBe(true);
    expect(result.data?.reductionPct).toBe(0);
  });

  // ── reductionPct calculation ─────────────────────────────────────────────

  it('calculates reductionPct as percentage of chars removed from original', async () => {
    // Arrange: original 100 chars, current 75 chars → 25% reduction
    const original = 'a'.repeat(100);
    const current = 'a'.repeat(75);
    mockResolveCleanupTarget.mockResolvedValue(makeTarget(original, current));

    // Act
    const result = await capability.execute({}, makeContext());

    // Assert: 25% reduction
    expect(result.success).toBe(true);
    expect(result.data?.reductionPct).toBe(25);
  });

  // ── linesRemoved can be negative ─────────────────────────────────────────

  it('returns negative linesRemoved when cleanup added more lines than it removed', async () => {
    // Arrange: original 2 lines, current 4 lines (e.g. an expansion capability ran)
    const original = 'line1\nline2';
    const current = 'line1\nexpanded1\nexpanded2\nline2';
    mockResolveCleanupTarget.mockResolvedValue(makeTarget(original, current));

    // Act
    const result = await capability.execute({}, makeContext());

    // Assert: linesRemoved is negative — original(2) - current(4) = -2
    expect(result.success).toBe(true);
    expect(result.data?.linesRemoved).toBe(-2);
    expect(result.data?.linesOriginal).toBe(2);
    expect(result.data?.linesCurrent).toBe(4);
  });

  // ── full data shape ──────────────────────────────────────────────────────

  it('returns the full expected data shape with all seven fields', async () => {
    // Arrange
    const original = 'Hello world\nGoodbye world';
    const current = 'Hello world';
    mockResolveCleanupTarget.mockResolvedValue(makeTarget(original, current));

    // Act
    const result = await capability.execute({}, makeContext());

    // Assert: all seven fields present
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      charsOriginal: expect.any(Number),
      charsCurrent: expect.any(Number),
      charsRemoved: expect.any(Number),
      linesOriginal: expect.any(Number),
      linesCurrent: expect.any(Number),
      linesRemoved: expect.any(Number),
      reductionPct: expect.any(Number),
    });
  });

  // ── uses originalContent for orig metrics, content for current ───────────

  it('uses target.originalContent for original metrics and target.content for current metrics', async () => {
    // Arrange: original has more content than current (processed)
    const original = 'This is the original content with many words.';
    const processed = 'Short.';
    mockResolveCleanupTarget.mockResolvedValue(makeTarget(original, processed));

    // Act
    const result = await capability.execute({}, makeContext());

    // Assert: metrics correctly reference the two separate strings
    expect(result.success).toBe(true);
    expect(result.data?.charsOriginal).toBe(original.length);
    expect(result.data?.charsCurrent).toBe(processed.length);
    expect(result.data?.charsRemoved).toBe(original.length - processed.length);
    expect(result.data?.reductionPct).toBeCloseTo(
      ((original.length - processed.length) / original.length) * 100,
      5
    );
  });
});
