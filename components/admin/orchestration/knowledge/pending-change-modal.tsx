'use client';

import { useCallback, useEffect, useState } from 'react';
import { Check, Loader2, Sparkles, X } from 'lucide-react';

import { TextDiffViewer } from '@/components/admin/orchestration/knowledge/text-diff-viewer';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { apiClient } from '@/lib/api/client';

interface PendingChangeRecord {
  id: string;
  source: 'rewrite_with_llm' | 'rewrite_section_with_llm';
  beforeContent: string;
  afterContent: string;
  sectionMarker: string | null;
  instructions: string;
}

interface PendingChangeModalProps {
  documentId: string;
  /** The pending-change id surfaced via capability_result. */
  changeId: string | null;
  onClose: () => void;
  /** Fired after Accept or Reject so the parent can re-fetch the doc. */
  onResolved: () => void;
}

// Renders a side-by-side diff for a pending LLM rewrite + Accept / Reject
// buttons. Opens when the chat surface intercepts a capability_result for
// `rewrite_with_llm` or `rewrite_section_with_llm` and the response carries
// a `pendingChangeId`.
//
// Loads the change record on open from the per-change GET. Fetching it there
// rather than off the documents/[id] route keeps the proposal's full before +
// after copy of the document out of the doc payload, which the cleanup view
// re-fetches after every chat turn and capability result.
export function PendingChangeModal({
  documentId,
  changeId,
  onClose,
  onResolved,
}: PendingChangeModalProps) {
  const [record, setRecord] = useState<PendingChangeRecord | null>(null);
  const [loading, setLoading] = useState(false);
  const [acting, setActing] = useState<'accept' | 'reject' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const open = changeId !== null;

  useEffect(() => {
    if (!open || !changeId) {
      setRecord(null);
      setError(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        // The capability_result that triggers this modal carries the pending
        // change content directly in the chat trace, but the modal is rendered
        // outside that scope — fetch the row by id.
        const body = await apiClient.get<{ change: PendingChangeRecord }>(
          `/api/v1/admin/orchestration/knowledge/documents/${documentId}/cleanup/changes/${changeId}`
        );
        if (cancelled) return;
        if (!body.change) throw new Error('Pending change not found');
        setRecord(body.change);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load pending change');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, changeId, documentId]);

  const accept = useCallback(async () => {
    if (!changeId) return;
    setActing('accept');
    setError(null);
    try {
      const res = await fetch(
        `/api/v1/admin/orchestration/knowledge/documents/${documentId}/cleanup/changes/${changeId}/accept`,
        { method: 'POST' }
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        throw new Error(body?.error?.message ?? `Accept failed (${res.status})`);
      }
      onResolved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Accept failed');
    } finally {
      setActing(null);
    }
  }, [changeId, documentId, onResolved, onClose]);

  const reject = useCallback(async () => {
    if (!changeId) return;
    setActing('reject');
    setError(null);
    try {
      const res = await fetch(
        `/api/v1/admin/orchestration/knowledge/documents/${documentId}/cleanup/changes/${changeId}/reject`,
        { method: 'POST' }
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        throw new Error(body?.error?.message ?? `Reject failed (${res.status})`);
      }
      onResolved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Reject failed');
    } finally {
      setActing(null);
    }
  }, [changeId, documentId, onResolved, onClose]);

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent className="max-w-5xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4" /> Review LLM rewrite
          </DialogTitle>
          <DialogDescription>
            The agent proposed a change. Accept to apply it (writes a revision); Reject to discard
            it (doc unchanged, no revision).
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="text-muted-foreground flex items-center justify-center p-8 text-sm">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : error ? (
          <p className="text-destructive text-sm">{error}</p>
        ) : record ? (
          <>
            <div className="text-muted-foreground space-y-1 text-xs">
              <p>
                <strong className="text-foreground">Source:</strong>{' '}
                {record.source === 'rewrite_with_llm'
                  ? 'Whole-document rewrite'
                  : `Section rewrite: ${record.sectionMarker ?? '?'}`}
              </p>
              <p>
                <strong className="text-foreground">Instructions:</strong> {record.instructions}
              </p>
            </div>
            <TextDiffViewer before={record.beforeContent} after={record.afterContent} />
          </>
        ) : null}

        <div className="flex justify-end gap-2">
          <Button
            variant="ghost"
            onClick={() => void reject()}
            disabled={acting !== null || !record}
          >
            {acting === 'reject' ? (
              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
            ) : (
              <X className="mr-1 h-3 w-3" />
            )}
            Reject
          </Button>
          <Button onClick={() => void accept()} disabled={acting !== null || !record}>
            {acting === 'accept' ? (
              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
            ) : (
              <Check className="mr-1 h-3 w-3" />
            )}
            Accept
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
