import safeRegex from 'safe-regex2';
import { prisma } from '@/lib/db/client';
import type { CapabilityContext } from '@/lib/orchestration/capabilities/types';
import { evaluateLock } from '@/lib/orchestration/knowledge/edit-lock';
import {
  CLEANUP_TX_MAX_WAIT_MS,
  CLEANUP_TX_TIMEOUT_MS,
  lockDocumentRow,
  writeRevisionWithin,
} from '@/lib/orchestration/knowledge/revisions';

export interface CleanupTarget {
  documentId: string;
  /** Current working state — `processedContent` if set, otherwise `originalContent`. */
  content: string;
  /** Immutable source-of-truth; never mutated by capabilities. */
  originalContent: string;
}

export type CompileRegexResult = { ok: true; regex: RegExp } | { ok: false; error: string };

// strip_lines_matching / strip_matches let the cleanup agent pick a regex from
// natural-language instructions and run it against the document. Node's
// RegExp engine has no built-in guard against catastrophic backtracking, and
// a synchronous `.test()` / `.replace()` already in flight cannot be timed
// out — so a crafted or hallucinated pattern (e.g. `(a+)+b`) must be rejected
// before it ever runs, not caught after it hangs the process.
export function compileSafeRegex(pattern: string, flags: string): CompileRegexResult {
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, flags);
  } catch (err) {
    return { ok: false, error: `Invalid regex: ${(err as Error).message}` };
  }
  if (!safeRegex(regex)) {
    return {
      ok: false,
      error: 'Regex rejected: pattern is vulnerable to catastrophic backtracking.',
    };
  }
  return { ok: true, regex };
}

// Document Clean Up capabilities run inside a chat session bound to a single
// knowledge document via AiConversation.contextType='knowledge_document' +
// contextId. This helper resolves the target doc from the conversation, asserts
// the doc is in 'cleaning' status, and returns the current working content.
// Returns null when the context doesn't match (caller surfaces a clear error
// to the agent so the LLM tells the user "this isn't a cleanup session").
export async function resolveCleanupTarget(
  context: CapabilityContext
): Promise<CleanupTarget | null> {
  if (!context.conversationId) return null;
  const conv = await prisma.aiConversation.findUnique({
    where: { id: context.conversationId },
    select: { contextType: true, contextId: true },
  });
  if (conv?.contextType !== 'knowledge_document' || !conv.contextId) return null;
  const doc = await prisma.aiKnowledgeDocument.findUnique({
    where: { id: conv.contextId },
    select: {
      id: true,
      status: true,
      originalContent: true,
      processedContent: true,
    },
  });
  if (!doc || doc.status !== 'cleaning' || doc.originalContent === null) return null;
  return {
    documentId: doc.id,
    content: doc.processedContent ?? doc.originalContent,
    originalContent: doc.originalContent,
  };
}

export interface WriteCleanupContentOpts {
  /** Where the mutation came from — flows into AiKnowledgeDocumentRevision.source. */
  source: string;
  /** Caller principal (admin in chat session, null if internal). */
  actorId: string | null;
  /** Optional — section marker for per-section edits. */
  sectionMarker?: string;
  /** Optional — instructions for LLM-source rewrites. */
  instructions?: string;
}

// Mutate processedContent AND append a revision row in one transaction, under
// the document row lock. Every callsite — capabilities, edit endpoints —
// flows through here so the revision history is always written.
//
// Use this only when the content was computed from a snapshot the caller has
// already validated against (the edit routes' fingerprint / stale-change
// guards). A caller that derives new content FROM current content must use
// `mutateCleanupContent`, which keeps the read inside the same lock.
export async function writeCleanupContent(
  documentId: string,
  content: string,
  opts: WriteCleanupContentOpts
): Promise<void> {
  await prisma.$transaction(
    async (tx) => {
      await lockDocumentRow(tx, documentId);
      await tx.aiKnowledgeDocument.update({
        where: { id: documentId },
        data: { processedContent: content },
      });
      await writeRevisionWithin(tx, {
        documentId,
        content,
        source: opts.source,
        actorId: opts.actorId,
        sectionMarker: opts.sectionMarker,
        instructions: opts.instructions,
      });
    },
    { timeout: CLEANUP_TX_TIMEOUT_MS, maxWait: CLEANUP_TX_MAX_WAIT_MS }
  );
}

/** Why a cleanup mutation didn't run. Maps 1:1 onto a capability error code. */
export type CleanupMutationRefusal =
  { reason: 'not_cleanup_session' } | { reason: 'target_locked'; heldBy?: string };

export type CleanupMutationOutcome<T> =
  | { ok: true; before: string; after: string; data: T; summary: MutationSummary }
  | ({ ok: false } & CleanupMutationRefusal);

/**
 * Map a refusal onto the message + error code a capability returns to the
 * agent. Kept here so all seven deterministic cleanups word it identically.
 */
export function describeRefusal(refusal: CleanupMutationRefusal): {
  message: string;
  code: string;
} {
  if (refusal.reason === 'target_locked') {
    return { message: 'The document is being edited by another admin.', code: 'target_locked' };
  }
  return { message: 'Not in a Document Clean Up session.', code: 'not_cleanup_session' };
}

/**
 * Read the current cleanup content, apply `transform` to it, and write the
 * result plus its revision — all inside one transaction holding the document
 * row lock, so the read cannot be stale by the time the write lands.
 *
 * This is the only safe way for a capability to mutate the document. The chat
 * loop dispatches a turn's tool calls in parallel (`Promise.allSettled` in
 * streaming-handler), so without the lock five deterministic cleanups all read
 * the same base content and the last write silently discarded the other four.
 * Under the lock they queue and compose: each transform sees the previous
 * one's output, which is what a multi-step cleanup plan means.
 *
 * `transform` runs inside the transaction and must stay cheap and pure — no
 * network calls, no LLM. An LLM rewrite proposes a pending change instead and
 * lands through `writeCleanupContent` on accept.
 */
export async function mutateCleanupContent<T>(
  context: CapabilityContext,
  opts: WriteCleanupContentOpts,
  transform: (content: string, target: CleanupTarget) => { next: string; data: T }
): Promise<CleanupMutationOutcome<T>> {
  if (!context.conversationId) return { ok: false, reason: 'not_cleanup_session' };
  const conv = await prisma.aiConversation.findUnique({
    where: { id: context.conversationId },
    select: { contextType: true, contextId: true },
  });
  if (conv?.contextType !== 'knowledge_document' || !conv.contextId) {
    return { ok: false, reason: 'not_cleanup_session' };
  }
  const documentId = conv.contextId;

  return prisma.$transaction(
    async (tx): Promise<CleanupMutationOutcome<T>> => {
      const row = await lockDocumentRow(tx, documentId);
      if (!row || row.status !== 'cleaning' || row.originalContent === null) {
        return { ok: false, reason: 'not_cleanup_session' };
      }

      // Same verdict requireEditableTarget would reach, but against the row we
      // already hold — one round trip, and no window between check and write.
      const lock = evaluateLock(row.editLockHolder, row.editLockAcquiredAt, context.userId);
      if (!lock.ok) return { ok: false, reason: 'target_locked', heldBy: lock.heldBy };

      const before = row.processedContent ?? row.originalContent;
      const { next, data } = transform(before, {
        documentId,
        content: before,
        originalContent: row.originalContent,
      });

      await tx.aiKnowledgeDocument.update({
        where: { id: documentId },
        data: { processedContent: next },
      });
      await writeRevisionWithin(tx, {
        documentId,
        content: next,
        source: opts.source,
        actorId: opts.actorId,
        sectionMarker: opts.sectionMarker,
        instructions: opts.instructions,
      });

      return { ok: true, before, after: next, data, summary: summariseMutation(before, next) };
    },
    { timeout: CLEANUP_TX_TIMEOUT_MS, maxWait: CLEANUP_TX_MAX_WAIT_MS }
  );
}

export interface MutationSummary {
  charsRemoved: number;
  charsAfter: number;
  linesRemoved: number;
  linesAfter: number;
}

export function summariseMutation(before: string, after: string): MutationSummary {
  return {
    charsRemoved: before.length - after.length,
    charsAfter: after.length,
    linesRemoved: before.split('\n').length - after.split('\n').length,
    linesAfter: after.split('\n').length,
  };
}
