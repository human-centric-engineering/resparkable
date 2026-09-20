/**
 * getDocumentSizeReport — unit tests
 *
 * Tests that the function:
 *   1. Delegates token estimation to `estimateTokens` (with the correct args)
 *   2. Classifies the returned count into the right sizeClass bucket
 *   3. Derives `llmRewriteAllowed` correctly from the class
 *
 * We mock `@/lib/orchestration/chat/token-estimator` so we can return
 * synthetic token counts without building giant strings. Every test then
 * asserts on the TRANSFORMATION the function performs on that count —
 * not on the count itself — to avoid green-bar tests that only prove
 * the mock works.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getDocumentSizeReport } from '@/lib/orchestration/knowledge/size-report';

// Mock the token estimator so we can inject synthetic counts.
// The module path must match the exact import used in size-report.ts.
vi.mock('@/lib/orchestration/chat/token-estimator', () => ({
  estimateTokens: vi.fn(),
}));

// Import AFTER vi.mock so we get the mocked version.
import { estimateTokens } from '@/lib/orchestration/chat/token-estimator';

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Boundary constants (mirrors size-report.ts for readability; NOT re-imported
//   to avoid coupling tests to internal exports that may change) ────────────────
const SMALL_MAX = 8_000;
const MEDIUM_MAX = 32_000;
const LARGE_MAX = 100_000;

describe('getDocumentSizeReport', () => {
  describe('empty string', () => {
    it('returns tokenCount near 0, sizeClass small, and llmRewriteAllowed true', () => {
      // Arrange: estimateTokens returns 0 for an empty string
      vi.mocked(estimateTokens).mockReturnValue(0);

      // Act
      const report = getDocumentSizeReport('');

      // Assert: verify the FUNCTION's classification logic, not just the mock return
      expect(report.tokenCount).toBe(0);
      expect(report.sizeClass).toBe('small');
      expect(report.llmRewriteAllowed).toBe(true);
    });
  });

  describe('sizeClass: small', () => {
    it('classifies a short text (~1k tokens) as small', () => {
      // Arrange: 1k tokens is well below the 8k boundary
      vi.mocked(estimateTokens).mockReturnValue(1_000);

      // Act
      const report = getDocumentSizeReport('some short text');

      // Assert: the function must bucket 1k correctly; llmRewriteAllowed follows
      expect(report.sizeClass).toBe('small');
      expect(report.llmRewriteAllowed).toBe(true);
    });

    it('classifies a token count exactly at the small ceiling (8k) as small', () => {
      // Arrange: boundary value — equal to SMALL_MAX should still be 'small'
      vi.mocked(estimateTokens).mockReturnValue(SMALL_MAX);

      // Act
      const report = getDocumentSizeReport('text at boundary');

      // Assert
      expect(report.sizeClass).toBe('small');
      expect(report.llmRewriteAllowed).toBe(true);
    });
  });

  describe('sizeClass: medium', () => {
    it('classifies a token count just above the small ceiling as medium', () => {
      // Arrange: one token over the 8k threshold tips into medium
      vi.mocked(estimateTokens).mockReturnValue(SMALL_MAX + 1);

      // Act
      const report = getDocumentSizeReport('medium-sized document');

      // Assert: bucket changed, but LLM rewrites are still allowed
      expect(report.sizeClass).toBe('medium');
      expect(report.llmRewriteAllowed).toBe(true);
    });

    it('classifies a token count exactly at the medium ceiling (32k) as medium', () => {
      // Arrange: boundary value — equal to MEDIUM_MAX should still be 'medium'
      vi.mocked(estimateTokens).mockReturnValue(MEDIUM_MAX);

      // Act
      const report = getDocumentSizeReport('medium ceiling text');

      // Assert
      expect(report.sizeClass).toBe('medium');
      expect(report.llmRewriteAllowed).toBe(true);
    });
  });

  describe('sizeClass: large', () => {
    it('classifies a token count just above the medium ceiling as large', () => {
      // Arrange: one token over the 32k threshold tips into large
      vi.mocked(estimateTokens).mockReturnValue(MEDIUM_MAX + 1);

      // Act
      const report = getDocumentSizeReport('large document');

      // Assert: still below 100k so LLM rewrites remain allowed
      expect(report.sizeClass).toBe('large');
      expect(report.llmRewriteAllowed).toBe(true);
    });

    it('classifies a token count exactly at the large ceiling (100k) as large', () => {
      // Arrange: equal to LARGE_MAX should still be 'large'
      vi.mocked(estimateTokens).mockReturnValue(LARGE_MAX);

      // Act
      const report = getDocumentSizeReport('large ceiling text');

      // Assert
      expect(report.sizeClass).toBe('large');
      expect(report.llmRewriteAllowed).toBe(true);
    });
  });

  describe('sizeClass: too-large', () => {
    it('classifies a token count above 100k as too-large and disables llmRewriteAllowed', () => {
      // Arrange: one token over the 100k threshold
      vi.mocked(estimateTokens).mockReturnValue(LARGE_MAX + 1);

      // Act
      const report = getDocumentSizeReport('very large document');

      // Assert: both the class AND the derived flag must reflect the crossing
      expect(report.sizeClass).toBe('too-large');
      expect(report.llmRewriteAllowed).toBe(false);
    });
  });

  describe('modelId delegation', () => {
    it('passes modelId through to estimateTokens when provided', () => {
      // Arrange: supply a specific model id
      const modelId = 'gpt-4o';
      vi.mocked(estimateTokens).mockReturnValue(500);

      // Act
      const report = getDocumentSizeReport('some content', modelId);

      // Assert: the function must have delegated to the tokeniser with the exact args
      // This verifies the CODE's behaviour (forwarding modelId), not the mock's return.
      expect(estimateTokens).toHaveBeenCalledWith('some content', modelId);
      expect(estimateTokens).toHaveBeenCalledTimes(1);
      // And the classification still works on the mocked count
      expect(report.sizeClass).toBe('small');
    });

    it('calls estimateTokens without modelId when none is provided', () => {
      // Arrange
      vi.mocked(estimateTokens).mockReturnValue(500);

      // Act
      getDocumentSizeReport('content without model');

      // Assert: called with undefined for the second arg (or omitted)
      expect(estimateTokens).toHaveBeenCalledWith('content without model', undefined);
    });
  });
});
