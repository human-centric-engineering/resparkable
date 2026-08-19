'use client';

/**
 * Transcript — the pane's one scrolling list, rendering chat replies,
 * instruct receipts, capture receipts, and declined-instruction receipts
 * inline, in the order they happened.
 *
 * `TOOL_LABELS` is a small, deliberate duplicate of `resparkable-chat.tsx`'s
 * own map, not an import — that map lives on a component this file doesn't
 * otherwise depend on, and the two are free to diverge if Sparkey's receipt
 * copy ever needs to read differently from the standalone chat page's.
 */

import * as React from 'react';
import { CheckCircle2, Loader2, PenLine, Wrench, XCircle } from 'lucide-react';

import type { TranscriptEntry } from '@/components/resparkable/sparkey/sparkey-types';
import { MarkdownView } from '@/components/resparkable/ui/markdown-view';

const TOOL_LABELS: Record<string, string> = {
  resparkable_capture: 'captured a thought',
  resparkable_search: 'searched your brain',
  resparkable_upsert_task: 'created or changed a task',
  resparkable_upsert_project: 'created or changed a project',
  resparkable_upsert_area: 'created or changed a life area',
  resparkable_upsert_goal: 'created or changed a goal',
  resparkable_upsert_entity: 'created or changed a person or company',
  resparkable_upsert_time_block: 'booked time',
  resparkable_link_entities: 'linked two items',
  resparkable_promote_thought: 'promoted a note',
};

function toolLabel(slug: string): string {
  return TOOL_LABELS[slug] ?? slug.replace(/^resparkable_/, '').replace(/_/g, ' ');
}

export interface TranscriptProps {
  entries: TranscriptEntry[];
}

/** Grows as a streaming assistant reply's text grows, not just as entries are added or removed. */
function contentSignature(entries: TranscriptEntry[]): number {
  return entries.reduce((total, entry) => {
    const text = entry.kind === 'chat' || entry.kind === 'instruct' ? entry.assistantText : '';
    return total + text.length;
  }, entries.length);
}

export function Transcript({ entries }: TranscriptProps): React.ReactElement {
  const endRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
    // A streamed reply grows this component's own entries array in place
    // (same length, more text) — depending on entries.length alone would
    // never re-scroll while a long answer is still arriving.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contentSignature(entries)]);

  return (
    <div
      role="log"
      aria-label="Sparkey transcript"
      className="flex flex-1 flex-col gap-3 overflow-y-auto p-3"
    >
      {entries.map((entry) => (
        <TranscriptRow key={entry.id} entry={entry} />
      ))}
      <div ref={endRef} />
    </div>
  );
}

function TranscriptRow({ entry }: { entry: TranscriptEntry }): React.ReactElement {
  switch (entry.kind) {
    case 'chat':
      return <ChatTurn entry={entry} />;
    case 'instruct':
      return <InstructReceipt entry={entry} />;
    case 'capture':
      return <CaptureReceipt entry={entry} />;
    case 'declined':
      return <DeclinedReceipt entry={entry} />;
  }
}

function ChatTurn({
  entry,
}: {
  entry: Extract<TranscriptEntry, { kind: 'chat' }>;
}): React.ReactElement {
  return (
    <div className="space-y-2">
      <p className="text-sm">{entry.userText}</p>
      {(entry.assistantText || entry.status === 'streaming') && (
        <div className="bg-card rounded-md border p-2.5">
          {entry.assistantText ? (
            <MarkdownView content={entry.assistantText} className="text-sm" />
          ) : (
            <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
              Thinking…
            </span>
          )}
          {entry.tools.length > 0 && (
            <p className="text-muted-foreground mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 border-t pt-2 text-xs">
              <Wrench className="h-3 w-3 shrink-0" aria-hidden="true" />
              {entry.tools.map(toolLabel).join(' · ')}
            </p>
          )}
          {entry.status === 'error' && entry.errorMessage && (
            <p className="text-destructive mt-2 text-xs">{entry.errorMessage}</p>
          )}
        </div>
      )}
    </div>
  );
}

function InstructReceipt({
  entry,
}: {
  entry: Extract<TranscriptEntry, { kind: 'instruct' }>;
}): React.ReactElement {
  return (
    <div className="bg-card flex items-start gap-2.5 rounded-md border p-2.5">
      <StatusIcon status={entry.status} />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-sm font-medium">{entry.userText}</p>
        {entry.status === 'streaming' && (
          <p className="text-muted-foreground text-xs">Working on it…</p>
        )}
        {entry.status === 'done' && entry.tools.length > 0 && (
          <p className="text-muted-foreground text-xs">{entry.tools.map(toolLabel).join(' · ')}</p>
        )}
        {entry.status === 'done' && entry.tools.length === 0 && (
          <p className="text-muted-foreground text-xs">
            {entry.assistantText || 'Done — no changes were needed.'}
          </p>
        )}
        {entry.status === 'error' && (
          <p className="text-destructive text-xs">{entry.errorMessage}</p>
        )}
      </div>
    </div>
  );
}

function CaptureReceipt({
  entry,
}: {
  entry: Extract<TranscriptEntry, { kind: 'capture' }>;
}): React.ReactElement {
  return (
    <div className="bg-card flex items-start gap-2.5 rounded-md border p-2.5">
      {entry.status === 'saving' ? (
        <Loader2
          className="text-muted-foreground mt-0.5 h-4 w-4 shrink-0 animate-spin"
          aria-hidden="true"
        />
      ) : entry.status === 'saved' ? (
        <CheckCircle2 className="text-primary mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      ) : (
        <XCircle className="text-destructive mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      )}
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-sm">{entry.content}</p>
        <p className="text-muted-foreground text-xs">
          {entry.status === 'saving' && 'Capturing…'}
          {entry.status === 'saved' && 'Captured — in your inbox.'}
          {entry.status === 'error' && (entry.errorMessage ?? 'Couldn’t capture this.')}
        </p>
      </div>
    </div>
  );
}

function DeclinedReceipt({
  entry,
}: {
  entry: Extract<TranscriptEntry, { kind: 'declined' }>;
}): React.ReactElement {
  return (
    <div className="bg-muted/40 flex items-start gap-2.5 rounded-md border border-dashed p-2.5">
      <PenLine className="text-muted-foreground mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-sm">{entry.text}</p>
        <p className="text-muted-foreground text-xs">
          Moving cards between board columns isn’t available through Sparkey yet — use the board
          directly.
        </p>
      </div>
    </div>
  );
}

function StatusIcon({ status }: { status: 'streaming' | 'done' | 'error' }): React.ReactElement {
  if (status === 'streaming') {
    return (
      <Loader2
        className="text-muted-foreground mt-0.5 h-4 w-4 shrink-0 animate-spin"
        aria-hidden="true"
      />
    );
  }
  if (status === 'error') {
    return <XCircle className="text-destructive mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />;
  }
  return <CheckCircle2 className="text-primary mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />;
}
