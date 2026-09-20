'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

// Client hook for the Document Clean Up edit lock. Manages acquire/release
// + polling so the editor can render a "held by another admin" banner and
// gate the chat input while the local admin holds the lock.
//
// Pessimistic single-writer semantics: when ANY editor section is being
// edited, the local admin acquires the lock; the rest of the chat UI
// shows a "Pause: document is being edited" overlay; capabilities refuse
// with `target_locked` from the server side.

export interface CleanupLockState {
  heldBy: string | null;
  acquiredAt: string | null;
  active: boolean;
  ttlMs: number;
}

const POLL_INTERVAL_MS = 10_000;
// Re-acquire well inside the 5-minute server TTL so a long-running edit
// never has its lock silently expire and get taken over mid-save.
const HEARTBEAT_INTERVAL_MS = 2 * 60 * 1000;

function lockUrl(documentId: string): string {
  return `/api/v1/admin/orchestration/knowledge/documents/${documentId}/cleanup/lock`;
}

interface UseEditLockResult {
  state: CleanupLockState | null;
  /** True when the lock is held by the local admin (heldBy === currentUserId AND active). */
  heldByMe: boolean;
  /** True when held by a different admin AND active. */
  heldByOther: boolean;
  /** Last error message from a lock operation. Cleared on next successful op. */
  error: string | null;
  acquire: () => Promise<boolean>;
  release: () => Promise<void>;
  /** Force-refresh the lock state from the server. */
  refresh: () => Promise<void>;
}

export function useCleanupEditLock(documentId: string, currentUserId: string): UseEditLockResult {
  const [state, setState] = useState<CleanupLockState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchState = useCallback(async () => {
    try {
      const res = await fetch(lockUrl(documentId), { method: 'GET' });
      if (!res.ok) return;
      const body = (await res.json()) as {
        success: boolean;
        data?: CleanupLockState;
      };
      if (body.success && body.data) setState(body.data);
    } catch {
      /* swallow — polling is best-effort */
    }
  }, [documentId]);

  // Initial fetch + periodic poll so a remote admin's acquire is detected
  // even when the local admin is idle.
  useEffect(() => {
    void fetchState();
    pollTimer.current = setInterval(() => {
      void fetchState();
    }, POLL_INTERVAL_MS);
    return () => {
      if (pollTimer.current) clearInterval(pollTimer.current);
    };
  }, [fetchState]);

  const acquire = useCallback(async (): Promise<boolean> => {
    setError(null);
    try {
      const res = await fetch(lockUrl(documentId), { method: 'POST' });
      const body = (await res.json()) as {
        success: boolean;
        data?: { acquired: boolean; heldBy?: string; acquiredAt?: string; ttlMs: number };
        error?: { message: string; details?: { heldBy?: string[] } };
      };
      if (res.ok && body.success && body.data) {
        setState({
          heldBy: body.data.heldBy ?? currentUserId,
          acquiredAt: body.data.acquiredAt ?? null,
          active: true,
          ttlMs: body.data.ttlMs,
        });
        return true;
      }
      const held = body.error?.details?.heldBy?.[0] ?? 'another admin';
      setError(`Edit lock is held by ${held}.`);
      await fetchState();
      return false;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to acquire lock');
      return false;
    }
  }, [documentId, currentUserId, fetchState]);

  // Until the session resolves, currentUserId is '' — comparing against it
  // would classify the admin's *own* live lock as held by someone else, which
  // on a refresh inside the TTL shows a "being edited by <my own id>" banner
  // and disables the finalise buttons. Treat unknown identity as "no verdict".
  const identityKnown = currentUserId !== '';
  const heldByMe = identityKnown && state?.active === true && state.heldBy === currentUserId;
  const heldByOther = identityKnown && state?.active === true && state.heldBy !== currentUserId;

  // Heartbeat: while the local admin actively holds the lock, periodically
  // re-acquire (POST is idempotent for the current holder) to push the
  // server-side TTL out. Without this, an edit that runs longer than the
  // TTL loses the lock mid-session with no warning, and a second admin can
  // start editing the same document concurrently.
  useEffect(() => {
    if (!heldByMe) return;
    const timer = setInterval(() => {
      void acquire();
    }, HEARTBEAT_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [heldByMe, acquire]);

  const release = useCallback(async (): Promise<void> => {
    try {
      await fetch(lockUrl(documentId), { method: 'DELETE' });
      await fetchState();
    } catch {
      /* swallow — release is idempotent server-side; UI doesn't block on this */
    }
  }, [documentId, fetchState]);

  return {
    state,
    heldByMe,
    heldByOther,
    error,
    acquire,
    release,
    refresh: fetchState,
  };
}
