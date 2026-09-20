/**
 * Unit Tests: document-cleanup context helpers
 *
 * Tests for:
 * - resolveCleanupTarget: resolves a CleanupTarget from a CapabilityContext,
 *   returning null in all invalid-context cases.
 * - writeCleanupContent: writes processedContent to the named document.
 * - summariseMutation: computes char/line removal counts from a before/after pair.
 * - compileSafeRegex: compiles a caller-supplied pattern, rejecting invalid
 *   syntax and patterns vulnerable to catastrophic backtracking.
 *
 * @see lib/orchestration/capabilities/built-in/document-cleanup/context.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { nestedQuantifierPattern } from '@/tests/helpers/redos-pattern';

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('@/lib/db/client', () => {
  const prisma = {
    aiConversation: {
      findUnique: vi.fn(),
    },
    aiKnowledgeDocument: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    aiKnowledgeDocumentRevision: {
      findFirst: vi.fn(),
      create: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    // Interactive transaction: hand the callback the same client so the
    // model-method assertions below see the calls made inside it.
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
    // Row lock — `lockDocumentRow` issues this. Tests set the returned row.
    $queryRaw: vi.fn().mockResolvedValue([]),
  };
  return { prisma };
});

// ─── Imports ────────────────────────────────────────────────────────────────

import { prisma } from '@/lib/db/client';
import type { CapabilityContext } from '@/lib/orchestration/capabilities/types';
import {
  resolveCleanupTarget,
  writeCleanupContent,
  mutateCleanupContent,
  describeRefusal,
  summariseMutation,
  compileSafeRegex,
} from '@/lib/orchestration/capabilities/built-in/document-cleanup/context';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const CONVERSATION_ID = 'conv-abc123';
const DOCUMENT_ID = 'doc-xyz789';

function makeContext(overrides: Partial<CapabilityContext> = {}): CapabilityContext {
  return {
    userId: 'user-1',
    agentId: 'agent-1',
    conversationId: CONVERSATION_ID,
    ...overrides,
  };
}

// Prisma's findUnique return types are the full model shape. We only care about
// the selected fields, so we cast to `never` at the mock boundary — this is the
// standard project pattern for partial Prisma mocks.

function makeConvRow(
  overrides: {
    contextType?: string;
    contextId?: string | null;
  } = {}
) {
  return {
    contextType: 'knowledge_document',
    contextId: DOCUMENT_ID,
    ...overrides,
  } as never;
}

function makeDocRow(
  overrides: {
    id?: string;
    status?: string;
    originalContent?: string | null;
    processedContent?: string | null;
  } = {}
) {
  return {
    id: DOCUMENT_ID,
    status: 'cleaning',
    originalContent: 'The original document text.',
    processedContent: null,
    ...overrides,
  } as never;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('resolveCleanupTarget', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null when context.conversationId is missing', async () => {
    // Arrange
    const context = makeContext({ conversationId: undefined });

    // Act
    const result = await resolveCleanupTarget(context);

    // Assert: early return — no DB calls made
    expect(result).toBeNull();
    expect(prisma.aiConversation.findUnique).not.toHaveBeenCalled();
    expect(prisma.aiKnowledgeDocument.findUnique).not.toHaveBeenCalled();
  });

  it('returns null when the conversation has contextType !== knowledge_document', async () => {
    // Arrange
    const context = makeContext();
    vi.mocked(prisma.aiConversation.findUnique).mockResolvedValue(
      makeConvRow({ contextType: 'workflow_execution' })
    );

    // Act
    const result = await resolveCleanupTarget(context);

    // Assert: the guard on contextType filtered this out — doc was never queried
    expect(result).toBeNull();
    expect(prisma.aiConversation.findUnique).toHaveBeenCalledWith({
      where: { id: CONVERSATION_ID },
      select: { contextType: true, contextId: true },
    });
    expect(prisma.aiKnowledgeDocument.findUnique).not.toHaveBeenCalled();
  });

  it('returns null when the conversation contextId is null (missing link)', async () => {
    // Arrange
    const context = makeContext();
    vi.mocked(prisma.aiConversation.findUnique).mockResolvedValue(makeConvRow({ contextId: null }));

    // Act
    const result = await resolveCleanupTarget(context);

    // Assert: contextId null means no doc to look up
    expect(result).toBeNull();
    expect(prisma.aiKnowledgeDocument.findUnique).not.toHaveBeenCalled();
  });

  it('returns null when the conversation row does not exist', async () => {
    // Arrange
    const context = makeContext();
    vi.mocked(prisma.aiConversation.findUnique).mockResolvedValue(null);

    // Act
    const result = await resolveCleanupTarget(context);

    // Assert: null conv row → no match
    expect(result).toBeNull();
    expect(prisma.aiKnowledgeDocument.findUnique).not.toHaveBeenCalled();
  });

  it("returns null when the document status is not 'cleaning'", async () => {
    // Arrange
    const context = makeContext();
    vi.mocked(prisma.aiConversation.findUnique).mockResolvedValue(makeConvRow());
    vi.mocked(prisma.aiKnowledgeDocument.findUnique).mockResolvedValue(
      makeDocRow({ status: 'ready' })
    );

    // Act
    const result = await resolveCleanupTarget(context);

    // Assert: doc exists but isn't in cleaning status — return null
    expect(result).toBeNull();
  });

  it('returns null when originalContent is null (defensive guard)', async () => {
    // Arrange
    const context = makeContext();
    vi.mocked(prisma.aiConversation.findUnique).mockResolvedValue(makeConvRow());
    vi.mocked(prisma.aiKnowledgeDocument.findUnique).mockResolvedValue(
      makeDocRow({ originalContent: null })
    );

    // Act
    const result = await resolveCleanupTarget(context);

    // Assert: the function defensively rejects a doc with no originalContent
    expect(result).toBeNull();
  });

  it('returns a target with content === processedContent when both are populated', async () => {
    // Arrange
    const context = makeContext();
    vi.mocked(prisma.aiConversation.findUnique).mockResolvedValue(makeConvRow());
    vi.mocked(prisma.aiKnowledgeDocument.findUnique).mockResolvedValue(
      makeDocRow({
        originalContent: 'Original text here.',
        processedContent: 'Cleaned text here.',
      })
    );

    // Act
    const result = await resolveCleanupTarget(context);

    // Assert: processedContent takes priority over originalContent for the working copy
    expect(result).not.toBeNull();
    expect(result?.documentId).toBe(DOCUMENT_ID);
    expect(result?.content).toBe('Cleaned text here.');
    expect(result?.originalContent).toBe('Original text here.');
    // Verify the function actually queries the correct doc id from the conversation
    expect(prisma.aiKnowledgeDocument.findUnique).toHaveBeenCalledWith({
      where: { id: DOCUMENT_ID },
      select: {
        id: true,
        status: true,
        originalContent: true,
        processedContent: true,
      },
    });
  });

  it('returns a target with content === originalContent when processedContent is null', async () => {
    // Arrange
    const context = makeContext();
    vi.mocked(prisma.aiConversation.findUnique).mockResolvedValue(makeConvRow());
    vi.mocked(prisma.aiKnowledgeDocument.findUnique).mockResolvedValue(
      makeDocRow({ originalContent: 'Raw source content.', processedContent: null })
    );

    // Act
    const result = await resolveCleanupTarget(context);

    // Assert: when no processedContent yet, content falls back to originalContent
    expect(result).not.toBeNull();
    expect(result?.content).toBe('Raw source content.');
    expect(result?.originalContent).toBe('Raw source content.');
    // Both content and originalContent reference the same source, but they must both be present
    expect(result?.documentId).toBe(DOCUMENT_ID);
  });
});

describe('writeCleanupContent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls prisma.aiKnowledgeDocument.update with the given document id and content', async () => {
    // Arrange
    const docId = 'doc-write-123';
    const newContent = 'Cleaned and processed content.';
    vi.mocked(prisma.aiKnowledgeDocument.update).mockResolvedValue({} as never); // full model shape not needed — only side effect matters
    vi.mocked(prisma.aiKnowledgeDocumentRevision.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.aiKnowledgeDocumentRevision.create).mockResolvedValue({} as never);

    // Act
    await writeCleanupContent(docId, newContent, {
      source: 'capability:test',
      actorId: 'user-1',
    });

    // Assert: the function must write processedContent, not originalContent
    expect(prisma.aiKnowledgeDocument.update).toHaveBeenCalledTimes(1);
    expect(prisma.aiKnowledgeDocument.update).toHaveBeenCalledWith({
      where: { id: docId },
      data: { processedContent: newContent },
    });
  });

  it('appends a revision row with the supplied source + actorId after writing', async () => {
    const docId = 'doc-write-456';
    const newContent = 'Step two of cleanup';
    vi.mocked(prisma.aiKnowledgeDocument.update).mockResolvedValue({} as never);
    vi.mocked(prisma.aiKnowledgeDocumentRevision.findFirst).mockResolvedValue({
      version: 3,
    } as never);
    vi.mocked(prisma.aiKnowledgeDocumentRevision.create).mockResolvedValue({} as never);

    await writeCleanupContent(docId, newContent, {
      source: 'human_full',
      actorId: 'admin-7',
      sectionMarker: 'Intro',
      instructions: 'tighten',
    });

    expect(prisma.aiKnowledgeDocumentRevision.create).toHaveBeenCalledTimes(1);
    expect(prisma.aiKnowledgeDocumentRevision.create).toHaveBeenCalledWith({
      data: {
        documentId: docId,
        version: 4, // next after 3
        content: newContent,
        source: 'human_full',
        actorId: 'admin-7',
        sectionMarker: 'Intro',
        instructions: 'tighten',
      },
    });
  });

  it('allocates version 1 when there is no prior revision for the document', async () => {
    const docId = 'doc-write-789';
    vi.mocked(prisma.aiKnowledgeDocument.update).mockResolvedValue({} as never);
    vi.mocked(prisma.aiKnowledgeDocumentRevision.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.aiKnowledgeDocumentRevision.create).mockResolvedValue({} as never);

    await writeCleanupContent(docId, 'first content', {
      source: 'capability:strip_timestamps',
      actorId: 'admin-1',
    });

    expect(prisma.aiKnowledgeDocumentRevision.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ version: 1 }) })
    );
  });
});

describe('summariseMutation', () => {
  it('computes correct char and line removal counts for a simple before/after pair', () => {
    // Arrange
    const before = 'line one\nline two\nline three';
    const after = 'line one\nline three';

    // Act
    const summary = summariseMutation(before, after);

    // Assert: verify each field is a product of what the function computes, not mock data
    // before: 27 chars, 3 lines; after: 19 chars, 2 lines
    expect(summary.charsRemoved).toBe(before.length - after.length); // 8 chars removed
    expect(summary.charsAfter).toBe(after.length); // 19 chars remain
    expect(summary.linesRemoved).toBe(before.split('\n').length - after.split('\n').length); // 1 line removed
    expect(summary.linesAfter).toBe(after.split('\n').length); // 2 lines remain
  });

  it('returns zero removals when before and after are identical', () => {
    // Arrange
    const text = 'no changes here\nstill the same';

    // Act
    const summary = summariseMutation(text, text);

    // Assert: no-op transform yields zeroes
    expect(summary.charsRemoved).toBe(0);
    expect(summary.linesRemoved).toBe(0);
    expect(summary.charsAfter).toBe(text.length);
    expect(summary.linesAfter).toBe(text.split('\n').length);
  });

  it('returns negative charsRemoved when the after string is longer than before', () => {
    // Arrange — after is longer (e.g. a capability added text)
    const before = 'short';
    const after = 'short and expanded content';

    // Act
    const summary = summariseMutation(before, after);

    // Assert: the function does not clamp to zero — callers decide how to present negatives
    expect(summary.charsRemoved).toBe(before.length - after.length); // negative
    expect(summary.charsAfter).toBe(after.length);
  });

  it('handles empty strings without throwing', () => {
    // Arrange
    const before = 'some text\nwith lines';

    // Act
    const summary = summariseMutation(before, '');

    // Assert: empty after removes all chars and all lines
    expect(summary.charsRemoved).toBe(before.length);
    expect(summary.charsAfter).toBe(0);
    // '' split on '\n' yields [''] — 1 element; before has 2 lines
    expect(summary.linesRemoved).toBe(before.split('\n').length - 1);
    expect(summary.linesAfter).toBe(1);
  });
});

describe('compileSafeRegex', () => {
  it('returns the compiled RegExp for an ordinary pattern', () => {
    const result = compileSafeRegex('^\\[Music\\]', 'i');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.regex).toBeInstanceOf(RegExp);
      expect(result.regex.source).toBe('^\\[Music\\]');
      expect(result.regex.flags).toBe('i');
    }
  });

  it('rejects a syntactically invalid pattern', () => {
    const result = compileSafeRegex('[invalid', '');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/invalid regex/i);
    }
  });

  it('rejects a pattern vulnerable to catastrophic backtracking', () => {
    // Classic nested-quantifier ReDoS shape — exponential worst-case runtime.
    const result = compileSafeRegex(nestedQuantifierPattern('$'), '');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/backtracking/i);
    }
  });
});

describe('mutateCleanupContent', () => {
  // Shape of the row `lockDocumentRow` returns from its SELECT … FOR UPDATE.
  function lockedRow(
    overrides: Partial<{
      status: string;
      originalContent: string | null;
      processedContent: string | null;
      editLockHolder: string | null;
      editLockAcquiredAt: Date | null;
    }> = {}
  ) {
    return [
      {
        id: DOCUMENT_ID,
        status: 'cleaning',
        originalContent: 'original text',
        processedContent: null,
        editLockHolder: null,
        editLockAcquiredAt: null,
        ...overrides,
      },
    ];
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.aiConversation.findUnique).mockResolvedValue(makeConvRow());
    vi.mocked(prisma.aiKnowledgeDocument.update).mockResolvedValue({} as never);
    vi.mocked(prisma.aiKnowledgeDocumentRevision.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.aiKnowledgeDocumentRevision.create).mockResolvedValue({} as never);
    vi.mocked(prisma.aiKnowledgeDocumentRevision.findMany).mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reads the document with a row lock inside the transaction before transforming', async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValue(lockedRow({ processedContent: 'abc' }));

    const seen: string[] = [];
    await mutateCleanupContent(
      makeContext(),
      { source: 'capability:test', actorId: 'user-1' },
      (content) => {
        seen.push(content);
        return { next: content.toUpperCase(), data: {} };
      }
    );

    // The transform must see what the locked read returned — this is the whole
    // point of the helper: a parallel tool batch cannot hand it stale content.
    expect(seen).toEqual(['abc']);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    const sql = vi.mocked(prisma.$queryRaw).mock.calls[0]?.[0] as unknown as { raw?: string[] };
    expect(sql.raw?.join('')).toContain('FOR UPDATE');
  });

  it('writes the transform output and its revision, and returns the mutation summary', async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValue(
      lockedRow({ processedContent: 'one\ntwo\ntwo\n' })
    );
    vi.mocked(prisma.aiKnowledgeDocumentRevision.findFirst).mockResolvedValue({
      version: 2,
    } as never);

    const outcome = await mutateCleanupContent(
      makeContext(),
      { source: 'capability:dedupe_lines', actorId: 'user-1' },
      (content) => ({ next: content.replace('two\ntwo\n', 'two\n'), data: { removed: 1 } })
    );

    expect(prisma.aiKnowledgeDocument.update).toHaveBeenCalledWith({
      where: { id: DOCUMENT_ID },
      data: { processedContent: 'one\ntwo\n' },
    });
    expect(prisma.aiKnowledgeDocumentRevision.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        documentId: DOCUMENT_ID,
        version: 3,
        content: 'one\ntwo\n',
        source: 'capability:dedupe_lines',
        actorId: 'user-1',
      }),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('expected a successful mutation');
    expect(outcome.data).toEqual({ removed: 1 });
    expect(outcome.before).toBe('one\ntwo\ntwo\n');
    expect(outcome.after).toBe('one\ntwo\n');
    expect(outcome.summary.charsRemoved).toBe(4);
    expect(outcome.summary.linesRemoved).toBe(1);
  });

  it('falls back to originalContent when processedContent has not been written yet', async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValue(
      lockedRow({ originalContent: 'raw parsed text', processedContent: null })
    );

    let seen = '';
    await mutateCleanupContent(
      makeContext(),
      { source: 'capability:test', actorId: 'user-1' },
      (content) => {
        seen = content;
        return { next: content, data: {} };
      }
    );

    expect(seen).toBe('raw parsed text');
  });

  it('refuses without writing when the conversation is not a cleanup session', async () => {
    vi.mocked(prisma.aiConversation.findUnique).mockResolvedValue(
      makeConvRow({ contextType: 'agent_chat' })
    );

    const outcome = await mutateCleanupContent(
      makeContext(),
      { source: 'capability:test', actorId: 'user-1' },
      () => ({ next: 'never', data: {} })
    );

    expect(outcome).toEqual({ ok: false, reason: 'not_cleanup_session' });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.aiKnowledgeDocument.update).not.toHaveBeenCalled();
  });

  it('refuses without writing when the document has left cleaning status', async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValue(lockedRow({ status: 'ready' }));

    const outcome = await mutateCleanupContent(
      makeContext(),
      { source: 'capability:test', actorId: 'user-1' },
      () => ({ next: 'never', data: {} })
    );

    expect(outcome).toEqual({ ok: false, reason: 'not_cleanup_session' });
    expect(prisma.aiKnowledgeDocument.update).not.toHaveBeenCalled();
    expect(prisma.aiKnowledgeDocumentRevision.create).not.toHaveBeenCalled();
  });

  it('refuses without writing when another admin holds a live edit lock', async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValue(
      lockedRow({ editLockHolder: 'other-admin', editLockAcquiredAt: new Date() })
    );

    const outcome = await mutateCleanupContent(
      makeContext({ userId: 'user-1' }),
      { source: 'capability:test', actorId: 'user-1' },
      () => ({ next: 'never', data: {} })
    );

    expect(outcome).toEqual({ ok: false, reason: 'target_locked', heldBy: 'other-admin' });
    expect(prisma.aiKnowledgeDocument.update).not.toHaveBeenCalled();
  });

  it('proceeds when the stale lock belongs to another admin but has expired', async () => {
    // 6 minutes old — past the 5-minute TTL, so the row is takeable.
    vi.mocked(prisma.$queryRaw).mockResolvedValue(
      lockedRow({
        editLockHolder: 'other-admin',
        editLockAcquiredAt: new Date(Date.now() - 6 * 60 * 1000),
        processedContent: 'content',
      })
    );

    const outcome = await mutateCleanupContent(
      makeContext({ userId: 'user-1' }),
      { source: 'capability:test', actorId: 'user-1' },
      (content) => ({ next: `${content}!`, data: {} })
    );

    expect(outcome.ok).toBe(true);
    expect(prisma.aiKnowledgeDocument.update).toHaveBeenCalledWith({
      where: { id: DOCUMENT_ID },
      data: { processedContent: 'content!' },
    });
  });

  it('proceeds when the caller is the admin already holding the lock', async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValue(
      lockedRow({
        editLockHolder: 'user-1',
        editLockAcquiredAt: new Date(),
        processedContent: 'mine',
      })
    );

    const outcome = await mutateCleanupContent(
      makeContext({ userId: 'user-1' }),
      { source: 'capability:test', actorId: 'user-1' },
      (content) => ({ next: content, data: {} })
    );

    expect(outcome.ok).toBe(true);
  });
});

describe('describeRefusal', () => {
  it('maps target_locked to the another-admin message and code', () => {
    expect(describeRefusal({ reason: 'target_locked', heldBy: 'admin-2' })).toEqual({
      message: 'The document is being edited by another admin.',
      code: 'target_locked',
    });
  });

  it('maps not_cleanup_session to the wrong-session message and code', () => {
    expect(describeRefusal({ reason: 'not_cleanup_session' })).toEqual({
      message: 'Not in a Document Clean Up session.',
      code: 'not_cleanup_session',
    });
  });
});
