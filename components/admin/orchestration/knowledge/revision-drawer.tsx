'use client';

// Revision history as a dialog, opened from the cleanup page header. The list
// and diff themselves live in <RevisionHistory>, which the History tab in the
// document-preview pane renders inline — same component, two entry points.

import { useEffect, useState } from 'react';
import { History } from 'lucide-react';

import { RevisionHistory } from '@/components/admin/orchestration/knowledge/revision-history';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { DEFAULT_REVISION_RETENTION } from '@/lib/orchestration/knowledge/revision-retention';

interface RevisionDrawerProps {
  documentId: string;
  currentContent: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRestored: () => void;
}

export function RevisionDrawer({
  documentId,
  currentContent,
  open,
  onOpenChange,
  onRestored,
}: RevisionDrawerProps) {
  // Bumped on each open so the list refetches — a capability may have written
  // revisions since the dialog was last closed. Keyed off the `open` prop
  // rather than onOpenChange: the parent owns that state, so the dialog's own
  // handler never fires for a programmatic open.
  const [refreshKey, setRefreshKey] = useState(0);
  useEffect(() => {
    if (open) setRefreshKey((k) => k + 1);
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <History className="h-4 w-4" /> Revision history
          </DialogTitle>
          <DialogDescription>
            Every change to this document — your edits, agent capability calls, finalise events — in
            chronological order. Restoring any revision writes a new entry. Only the most recent{' '}
            {DEFAULT_REVISION_RETENTION} revisions are kept per document; older ones are pruned
            automatically.
          </DialogDescription>
        </DialogHeader>

        {open ? (
          <RevisionHistory
            documentId={documentId}
            currentContent={currentContent}
            onRestored={onRestored}
            onAfterRestore={() => onOpenChange(false)}
            refreshKey={refreshKey}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
