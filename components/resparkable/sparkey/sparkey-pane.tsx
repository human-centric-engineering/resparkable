'use client';

/**
 * SparkeyPane — the composer's home: owns the mode, the draft, and the
 * unified transcript, and routes a submit to whichever of capture/chat/
 * instruct it belongs to.
 *
 * ## Why capture never touches the agent
 *
 * A one-line `POST /thoughts`, the same write `QuickCapture` makes — not a
 * `resparkable_capture` tool call through the companion. Per §8's
 * discipline: a capture that has to wait on a model round trip is a
 * capture that can fail for a reason that has nothing to do with saving
 * the words, and this app's one rule above all others is that a thought
 * never gets lost.
 *
 * ## Why instruct is chat with a different receipt
 *
 * Both ride `useChatStream` against the same `resparkable-companion`
 * agent, which already holds the `resparkable_upsert_*` capabilities an
 * instruction needs — the build plan's "UI-level 'instruct' framing" means
 * exactly that framing is the only difference: `InstructReceipt` shows a
 * compact status card instead of a conversational bubble, but the wire
 * call is identical to Chat mode's.
 *
 * ## Why a board-shaped instruction never reaches the agent at all
 *
 * `isBoardInstruction` is checked before `chat.send` runs. No agent
 * capability writes board membership or card position, so sending it
 * anyway is a guaranteed dead end — either a confusing non-answer or an
 * LLM inventing a tool call that doesn't exist. Declining locally costs
 * nothing and is honest about what Sparkey can't do yet.
 */

import * as React from 'react';

import { SparkIcon } from '@/components/brand/spark-glyph';
import { useChatStream } from '@/components/resparkable/chat/use-chat-stream';
import { PaneRail } from '@/components/resparkable/shell/pane-rail';
import { Composer } from '@/components/resparkable/sparkey/composer';
import type {
  CaptureEntry,
  ChatEntry,
  InstructEntry,
  SparkeyMode,
  TranscriptEntry,
} from '@/components/resparkable/sparkey/sparkey-types';
import { Transcript } from '@/components/resparkable/sparkey/transcript';
import { apiClient, APIClientError } from '@/lib/api/client';
import { RESPARKABLE_AGENT_SLUGS } from '@/lib/framework/resparkable/agents';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import { isBoardInstruction } from '@/lib/framework/resparkable/ui/workspace/classify-intent';
import { useLocalStorage } from '@/lib/hooks/use-local-storage';

const MODE_KEY = 'resparkable.sparkey.mode.v1';

function createId(): string {
  return crypto.randomUUID();
}

export interface SparkeyPaneProps {
  /** True once `WorkspaceShell`'s Sparkey panel has collapsed to a rail. */
  collapsed?: boolean;
  /** Expands the panel — wired to `PaneRail`'s click, not a button this pane renders itself. */
  onExpand?: () => void;
}

export function SparkeyPane({
  collapsed = false,
  onExpand,
}: SparkeyPaneProps = {}): React.ReactElement {
  const [mode, setMode] = useLocalStorage<SparkeyMode>(MODE_KEY, 'chat');
  const [draft, setDraft] = React.useState('');
  const [entries, setEntries] = React.useState<TranscriptEntry[]>([]);
  const chat = useChatStream({ agentSlug: RESPARKABLE_AGENT_SLUGS.companion });

  function patchAgentTurn(
    id: string,
    patch: Partial<
      Pick<ChatEntry | InstructEntry, 'assistantText' | 'tools' | 'status' | 'errorMessage'>
    >
  ): void {
    setEntries((prev) =>
      prev.map((entry) =>
        entry.id === id && (entry.kind === 'chat' || entry.kind === 'instruct')
          ? { ...entry, ...patch }
          : entry
      )
    );
  }

  function removeEntry(id: string): void {
    setEntries((prev) => prev.filter((entry) => entry.id !== id));
  }

  function patchCapture(
    id: string,
    patch: Partial<Pick<CaptureEntry, 'status' | 'errorMessage'>>
  ): void {
    setEntries((prev) =>
      prev.map((entry) =>
        entry.id === id && entry.kind === 'capture' ? { ...entry, ...patch } : entry
      )
    );
  }

  function submitCapture(text: string, source?: 'voice' | 'image'): void {
    const id = createId();
    setEntries((prev) => [...prev, { kind: 'capture', id, content: text, status: 'saving' }]);

    void apiClient
      .post<unknown>(RESPARKABLE_API.THOUGHTS, {
        body: { content: text, ...(source ? { source } : {}) },
      })
      .then(() => patchCapture(id, { status: 'saved' }))
      .catch((error: unknown) => {
        patchCapture(id, {
          status: 'error',
          errorMessage: error instanceof APIClientError ? error.message : 'Couldn’t capture this.',
        });
      });
  }

  function submitAgentTurn(kind: 'chat' | 'instruct', text: string): void {
    const id = createId();
    setEntries((prev) => [
      ...prev,
      { kind, id, userText: text, assistantText: '', tools: [], status: 'streaming' },
    ]);

    chat.send(text, {
      onDelta: (assistantSoFar) => patchAgentTurn(id, { assistantText: assistantSoFar }),
      onTools: (tools) => patchAgentTurn(id, { tools }),
      onDone: ({ assistant, tools, delivered }) => {
        if (!delivered) {
          // Nothing came back — give the words back to the box rather than
          // leaving an empty exchange sitting in the transcript.
          removeEntry(id);
          setDraft(text);
          return;
        }
        patchAgentTurn(id, { assistantText: assistant, tools, status: 'done' });
      },
      onError: (message) => patchAgentTurn(id, { status: 'error', errorMessage: message }),
    });
  }

  function submitDeclined(text: string): void {
    setEntries((prev) => [...prev, { kind: 'declined', id: createId(), text }]);
  }

  function onSubmit(text: string, source?: 'voice' | 'image'): void {
    if (mode === 'capture') {
      submitCapture(text, source);
      return;
    }
    if (mode === 'instruct' && isBoardInstruction(text)) {
      submitDeclined(text);
      return;
    }
    submitAgentTurn(mode, text);
  }

  if (collapsed) {
    return <PaneRail label="Sparkey" side="left" icon={SparkIcon} onExpand={onExpand} />;
  }

  return (
    // `bg-card`, not `bg-background`: Sparkey is chrome — a persistent
    // utility rail alongside the workspace, the same rung as the header's
    // own `.lattice-chrome` — not a page in its own right. `Transcript`'s
    // and `Composer`'s own boxes are `bg-background` for exactly the
    // opposite reason `WorkspacePane`'s are `bg-background` under `bg-card`
    // content: here the pane is the elevated surface, so its nested boxes
    // recess a rung *below* it instead of climbing above it (live feedback).
    //
    // `.terminal-surface` (brand-theme.css) puts the transcript and the
    // composer into the mono family — a session with a program, not a
    // document. The header's own `font-display` on the `h2` below wins over
    // the inherited mono, same as every other display heading in the app.
    <div className="bg-card terminal-surface flex h-full flex-col">
      <div className="flex items-center justify-center gap-2 border-b px-3 py-3">
        <SparkIcon className="h-4 w-4" aria-hidden="true" />
        <h2 className="font-display text-sm font-semibold tracking-wide">Ask Sparkey</h2>
      </div>
      <Transcript entries={entries} />
      <Composer
        mode={mode}
        onModeChange={setMode}
        value={draft}
        onValueChange={setDraft}
        onSubmit={onSubmit}
        disabled={chat.streaming}
      />
    </div>
  );
}
