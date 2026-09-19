/**
 * Unit Tests: EstimateSizeCapability
 *
 * Tests for the estimate_size capability. This capability is READ-ONLY:
 * - Delegates to resolveCleanupTarget to get the current document.
 * - Delegates to getDocumentSizeReport to compute the size report.
 * - Returns the report verbatim (no transformation).
 * - Never calls writeCleanupContent.
 *
 * @see lib/orchestration/capabilities/built-in/document-cleanup/estimate-size.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────────────

// vi.mock is hoisted — use vi.hoisted() so mock fn refs exist before the factory runs
const { mockResolveCleanupTarget, mockWriteCleanupContent } = vi.hoisted(() => ({
  mockResolveCleanupTarget: vi.fn(),
  // writeCleanupContent is included so we can assert it is NEVER called
  mockWriteCleanupContent: vi.fn(),
}));

vi.mock('@/lib/orchestration/capabilities/built-in/document-cleanup/context', () => ({
  resolveCleanupTarget: mockResolveCleanupTarget,
  writeCleanupContent: mockWriteCleanupContent,
  summariseMutation: vi.fn(),
}));

const { mockGetDocumentSizeReport } = vi.hoisted(() => ({
  mockGetDocumentSizeReport: vi.fn(),
}));

vi.mock('@/lib/orchestration/knowledge/size-report', () => ({
  getDocumentSizeReport: mockGetDocumentSizeReport,
}));

// ─── Imports ────────────────────────────────────────────────────────────────

import { EstimateSizeCapability } from '@/lib/orchestration/capabilities/built-in/document-cleanup/estimate-size';
import type { CapabilityContext } from '@/lib/orchestration/capabilities/types';
import type { DocumentSizeReport } from '@/lib/orchestration/knowledge/size-report';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const DOCUMENT_ID = 'doc-es-001';

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

function makeSizeReport(overrides: Partial<DocumentSizeReport> = {}): DocumentSizeReport {
  return {
    tokenCount: 500,
    sizeClass: 'small',
    llmRewriteAllowed: true,
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('EstimateSizeCapability', () => {
  let capability: EstimateSizeCapability;

  beforeEach(() => {
    vi.clearAllMocks();
    capability = new EstimateSizeCapability();
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

    // Assert: capability surfaces the correct error code — not a generic failure
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('not_cleanup_session');
    // Read-only — write must never be called under any circumstance
    expect(mockWriteCleanupContent).not.toHaveBeenCalled();
    // Size report must not be called when there is no target
    expect(mockGetDocumentSizeReport).not.toHaveBeenCalled();
  });

  // ── delegates to getDocumentSizeReport ──────────────────────────────────

  it('calls getDocumentSizeReport with the current document content', async () => {
    // Arrange
    const content = 'The document content to estimate.';
    mockResolveCleanupTarget.mockResolvedValue(makeTarget(content));
    mockGetDocumentSizeReport.mockReturnValue(makeSizeReport());

    // Act
    await capability.execute({}, makeContext());

    // Assert: the capability passed the target content to the size reporter
    expect(mockGetDocumentSizeReport).toHaveBeenCalledWith(content);
  });

  it('returns the DocumentSizeReport shape from getDocumentSizeReport verbatim', async () => {
    // Arrange
    const sizeReport = makeSizeReport({
      tokenCount: 9_500,
      sizeClass: 'medium',
      llmRewriteAllowed: true,
    });
    mockResolveCleanupTarget.mockResolvedValue(makeTarget('medium-length document content'));
    mockGetDocumentSizeReport.mockReturnValue(sizeReport);

    // Act
    const result = await capability.execute({}, makeContext());

    // Assert: the size report is returned inside success.data — not transformed
    expect(result.success).toBe(true);
    expect(result.data?.tokenCount).toBe(9_500);
    expect(result.data?.sizeClass).toBe('medium');
    expect(result.data?.llmRewriteAllowed).toBe(true);
  });

  it('returns too-large report with llmRewriteAllowed false when doc exceeds 100k tokens', async () => {
    // Arrange: simulate a too-large document
    const sizeReport = makeSizeReport({
      tokenCount: 120_000,
      sizeClass: 'too-large',
      llmRewriteAllowed: false,
    });
    mockResolveCleanupTarget.mockResolvedValue(makeTarget('very large document content'));
    mockGetDocumentSizeReport.mockReturnValue(sizeReport);

    // Act
    const result = await capability.execute({}, makeContext());

    // Assert: even for too-large documents, the capability succeeds — it just reports the class
    expect(result.success).toBe(true);
    expect(result.data?.sizeClass).toBe('too-large');
    expect(result.data?.llmRewriteAllowed).toBe(false);
    expect(result.data?.tokenCount).toBe(120_000);
  });

  // ── read-only — does NOT call writeCleanupContent ────────────────────────

  it('does NOT call writeCleanupContent on a successful estimate', async () => {
    // Arrange
    mockResolveCleanupTarget.mockResolvedValue(makeTarget('some document content'));
    mockGetDocumentSizeReport.mockReturnValue(makeSizeReport());

    // Act
    const result = await capability.execute({}, makeContext());

    // Assert: estimate_size is strictly read-only
    expect(result.success).toBe(true);
    expect(mockWriteCleanupContent).not.toHaveBeenCalled();
  });
});
