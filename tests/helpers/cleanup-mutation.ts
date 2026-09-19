/**
 * Test double for `mutateCleanupContent`.
 *
 * The seven deterministic Document Clean Up capabilities all mutate through
 * that one helper, which wraps the read → transform → write in a Postgres
 * transaction holding the document row lock. Unit tests for a capability are
 * about its *transform* (which regexes fire, what the counts are), not about
 * the transaction, so they substitute this double: it runs the capability's
 * real transform against a caller-supplied content string and records the
 * write, while letting a test simulate either refusal.
 *
 * The transaction itself — the part this double skips — is covered directly
 * in tests/unit/lib/orchestration/capabilities/built-in/document-cleanup/
 * context.test.ts against a mocked Prisma client.
 */

export interface CleanupTargetLike {
  documentId: string;
  content: string;
  originalContent: string;
}

export interface MutateDoubleDeps {
  /** Returns the current target, or null to simulate 'not in a cleanup session'. */
  resolveTarget: (context: unknown) => Promise<CleanupTargetLike | null> | CleanupTargetLike | null;
  /** Returns the cooperative-lock verdict for the target. */
  requireEditable: (
    documentId: string,
    userId: string | null
  ) => Promise<{ ok: boolean; heldBy?: string }> | { ok: boolean; heldBy?: string };
  /** Records the write the capability performed. */
  recordWrite: (documentId: string, content: string, opts: unknown) => void | Promise<void>;
  /** Produces the MutationSummary block merged into the capability's data. */
  summarise: (before: string, after: string) => Record<string, number>;
}

/**
 * Build the `mutateCleanupContent` replacement. Mirrors the production
 * ordering: session check, then lock check, then transform, then write.
 */
export function makeMutateCleanupContentDouble(deps: MutateDoubleDeps) {
  return async function mutateCleanupContent(
    context: { userId: string | null },
    opts: unknown,
    transform: (
      content: string,
      target: CleanupTargetLike
    ) => { next: string; data: Record<string, unknown> }
  ) {
    const target = await deps.resolveTarget(context);
    if (!target) return { ok: false as const, reason: 'not_cleanup_session' as const };

    const lock = await deps.requireEditable(target.documentId, context.userId);
    if (!lock.ok) {
      return { ok: false as const, reason: 'target_locked' as const, heldBy: lock.heldBy };
    }

    const { next, data } = transform(target.content, target);
    await deps.recordWrite(target.documentId, next, opts);
    return {
      ok: true as const,
      before: target.content,
      after: next,
      data,
      summary: deps.summarise(target.content, next),
    };
  };
}

/** The real `describeRefusal` wording, so error assertions stay meaningful. */
export function describeRefusalDouble(refusal: { reason: string }): {
  message: string;
  code: string;
} {
  if (refusal.reason === 'target_locked') {
    return { message: 'The document is being edited by another admin.', code: 'target_locked' };
  }
  return { message: 'Not in a Document Clean Up session.', code: 'not_cleanup_session' };
}
