'use client';

/**
 * useChatStream — the Resparkable chat SSE contract, decoupled from any one
 * message list.
 *
 * Lifted out of `resparkable-chat.tsx`'s inline fetch/parse loop so
 * Sparkey's unified transcript (`components/resparkable/sparkey/`) — which
 * interleaves chat replies with capture and instruct receipts, a shape
 * `resparkable-chat.tsx`'s own bubble list never needed — can drive the
 * same stream without owning a second, diverging copy of it. Callback-based
 * rather than state-owning for exactly that reason: this hook has no
 * opinion on what a "message" looks like on screen, only on what the wire
 * says happened.
 *
 * `resparkable-chat.tsx` itself is **not** rebuilt on this hook in this
 * phase — it already ships, already has its own test coverage, and
 * building Sparkey didn't require changing it. Retrofitting it here is a
 * reasonable, low-risk follow-up, not bundled into this one.
 */

import * as React from 'react';

import { parseChatStreamEvent } from '@/components/admin/orchestration/chat/chat-events';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import { getUserFacingError } from '@/lib/orchestration/chat/error-messages';

export interface ChatStreamEntityContext {
  entityType: string;
  entityId: string;
}

export interface UseChatStreamOptions {
  agentSlug: string;
  entityContext?: ChatStreamEntityContext;
}

export interface ChatStreamDoneResult {
  assistant: string;
  tools: string[];
  /** False when the turn produced no content and no tool call — the words should go back in the box. */
  delivered: boolean;
}

export interface ChatStreamCallbacks {
  /** Fired on every content delta, with the assistant text accumulated so far this turn. */
  onDelta?: (assistantSoFar: string) => void;
  /** Fired whenever the set of capability slugs used this turn changes. */
  onTools?: (tools: string[]) => void;
  /** The status/thinking line ("searching your brain…"), or `null` when it clears. */
  onStatus?: (status: string | null) => void;
  onDone: (result: ChatStreamDoneResult) => void;
  onError: (message: string) => void;
}

export interface UseChatStreamResult {
  streaming: boolean;
  send: (text: string, callbacks: ChatStreamCallbacks) => void;
}

export function useChatStream({
  agentSlug,
  entityContext,
}: UseChatStreamOptions): UseChatStreamResult {
  const [streaming, setStreaming] = React.useState(false);
  const conversationId = React.useRef<string | undefined>(undefined);
  const abortRef = React.useRef<AbortController | null>(null);

  React.useEffect(() => () => abortRef.current?.abort(), []);

  const send = React.useCallback(
    (text: string, callbacks: ChatStreamCallbacks) => {
      const controller = new AbortController();
      abortRef.current = controller;
      setStreaming(true);

      let assistant = '';
      const tools: string[] = [];
      let deliveredNothing = true;

      void (async () => {
        try {
          const response = await fetch(RESPARKABLE_API.CHAT_STREAM, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              message: text,
              agentSlug,
              ...(conversationId.current ? { conversationId: conversationId.current } : {}),
              ...(entityContext ? { entityContext } : {}),
            }),
            signal: controller.signal,
          });

          if (!response.ok || !response.body) {
            callbacks.onError(
              response.status === 429
                ? 'You are sending messages faster than the limit allows. Give it a minute.'
                : getUserFacingError('internal_error').message
            );
            return;
          }

          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';

          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            // SSE frames are separated by a blank line; the trailing fragment
            // stays in the buffer since a frame split across chunks is normal.
            const blocks = buffer.split('\n\n');
            buffer = blocks.pop() ?? '';

            for (const block of blocks) {
              const event = parseChatStreamEvent(block);
              if (!event) continue;

              switch (event.type) {
                case 'start':
                  conversationId.current = event.conversationId;
                  break;
                case 'content':
                  assistant += event.delta;
                  deliveredNothing = false;
                  callbacks.onStatus?.(null);
                  callbacks.onDelta?.(assistant);
                  break;
                case 'status':
                  callbacks.onStatus?.(event.message);
                  break;
                case 'content_reset':
                  assistant = '';
                  callbacks.onDelta?.(assistant);
                  break;
                case 'capability_result':
                  if (!tools.includes(event.capabilitySlug)) tools.push(event.capabilitySlug);
                  deliveredNothing = false;
                  callbacks.onTools?.([...tools]);
                  break;
                case 'capability_results':
                  for (const entry of event.results) {
                    if (!tools.includes(entry.capabilitySlug)) tools.push(entry.capabilitySlug);
                  }
                  deliveredNothing = false;
                  callbacks.onTools?.([...tools]);
                  break;
                case 'warning':
                  callbacks.onStatus?.(event.message);
                  break;
                case 'budget_exceeded_per_turn':
                  // Terminal — no trailing `done`/`error` frame follows this one.
                  callbacks.onError(event.message);
                  return;
                case 'error':
                  callbacks.onError(getUserFacingError(event.code).message);
                  return;
                case 'done':
                  callbacks.onStatus?.(null);
                  break;
                default:
                  break;
              }
            }
          }

          callbacks.onDone({ assistant, tools, delivered: !deliveredNothing });
        } catch (error) {
          if (error instanceof DOMException && error.name === 'AbortError') return;
          callbacks.onError(getUserFacingError('internal_error').message);
        } finally {
          setStreaming(false);
        }
      })();
    },
    [agentSlug, entityContext]
  );

  return { streaming, send };
}
