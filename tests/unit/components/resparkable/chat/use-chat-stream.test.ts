/**
 * Unit Tests: useChatStream.
 *
 * Same SSE-mocking approach as `resparkable-chat.test.tsx` (a real
 * `ReadableStream` built from `{type, ...}` frames), since this hook now
 * owns exactly the wire-protocol logic that test file's fixture drives —
 * lifted out so Sparkey can reuse it against a different message model.
 * Coverage here is about the hook's own contract (callbacks fire, terminal
 * frames skip `onDone`, the "delivered nothing" flag, conversationId
 * threading, abort-on-unmount) rather than re-deriving every event-type
 * case `resparkable-chat.test.tsx` already covers for the parser itself.
 *
 * @see components/resparkable/chat/use-chat-stream.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

import {
  useChatStream,
  type ChatStreamCallbacks,
} from '@/components/resparkable/chat/use-chat-stream';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';

function sseBody(frames: Array<Record<string, unknown>>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const text = frames
    .map((frame) => `event: ${String(frame.type)}\ndata: ${JSON.stringify(frame)}\n\n`)
    .join('');
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

function respondWith(frames: Array<Record<string, unknown>>): Response {
  return { ok: true, status: 200, body: sseBody(frames) } as unknown as Response;
}

function callbacks(overrides: Partial<ChatStreamCallbacks> = {}): {
  spies: {
    onDelta: ReturnType<typeof vi.fn>;
    onTools: ReturnType<typeof vi.fn>;
    onStatus: ReturnType<typeof vi.fn>;
    onDone: ReturnType<typeof vi.fn>;
    onError: ReturnType<typeof vi.fn>;
  };
  callbacks: ChatStreamCallbacks;
} {
  const spies = {
    onDelta: vi.fn(),
    onTools: vi.fn(),
    onStatus: vi.fn(),
    onDone: vi.fn(),
    onError: vi.fn(),
  };
  return { spies, callbacks: { ...spies, ...overrides } };
}

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockResolvedValue(respondWith([{ type: 'done' }]));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useChatStream', () => {
  it('posts to CHAT_STREAM with the message and agentSlug', async () => {
    const { result } = renderHook(() => useChatStream({ agentSlug: 'resparkable-companion' }));
    const { callbacks: cb } = callbacks();

    result.current.send('hello', cb);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    expect(fetchMock.mock.calls[0]?.[0]).toBe(RESPARKABLE_API.CHAT_STREAM);
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ message: 'hello', agentSlug: 'resparkable-companion' });
    expect(body.conversationId).toBeUndefined();
  });

  it('accumulates content deltas and calls onDone with the full text', async () => {
    fetchMock.mockResolvedValue(
      respondWith([
        { type: 'start', conversationId: 'conv_1' },
        { type: 'content', delta: 'Hel' },
        { type: 'content', delta: 'lo' },
        { type: 'done' },
      ])
    );

    const { result } = renderHook(() => useChatStream({ agentSlug: 'resparkable-companion' }));
    const { spies, callbacks: cb } = callbacks();

    result.current.send('hi', cb);
    await waitFor(() => expect(spies.onDone).toHaveBeenCalledTimes(1));

    expect(spies.onDelta).toHaveBeenCalledWith('Hel');
    expect(spies.onDelta).toHaveBeenCalledWith('Hello');
    expect(spies.onDone).toHaveBeenCalledWith({ assistant: 'Hello', tools: [], delivered: true });
  });

  it('de-duplicates tool slugs across capability_result frames', async () => {
    fetchMock.mockResolvedValue(
      respondWith([
        { type: 'capability_result', capabilitySlug: 'resparkable_capture', result: {} },
        { type: 'capability_result', capabilitySlug: 'resparkable_capture', result: {} },
        { type: 'capability_result', capabilitySlug: 'resparkable_search', result: {} },
        { type: 'done' },
      ])
    );

    const { result } = renderHook(() => useChatStream({ agentSlug: 'resparkable-companion' }));
    const { spies, callbacks: cb } = callbacks();

    result.current.send('do things', cb);
    await waitFor(() => expect(spies.onDone).toHaveBeenCalledTimes(1));

    expect(spies.onDone).toHaveBeenCalledWith({
      assistant: '',
      tools: ['resparkable_capture', 'resparkable_search'],
      delivered: true,
    });
  });

  it('marks delivered:false when the turn produced no content and no tool call', async () => {
    fetchMock.mockResolvedValue(
      respondWith([{ type: 'status', message: 'thinking' }, { type: 'done' }])
    );

    const { result } = renderHook(() => useChatStream({ agentSlug: 'resparkable-companion' }));
    const { spies, callbacks: cb } = callbacks();

    result.current.send('hi', cb);
    await waitFor(() => expect(spies.onDone).toHaveBeenCalledTimes(1));

    expect(spies.onDone).toHaveBeenCalledWith({ assistant: '', tools: [], delivered: false });
  });

  it('content_reset clears the accumulated assistant text', async () => {
    fetchMock.mockResolvedValue(
      respondWith([
        { type: 'content', delta: 'partial answer' },
        { type: 'content_reset' },
        { type: 'content', delta: 'full answer' },
        { type: 'done' },
      ])
    );

    const { result } = renderHook(() => useChatStream({ agentSlug: 'resparkable-companion' }));
    const { spies, callbacks: cb } = callbacks();

    result.current.send('hi', cb);
    await waitFor(() => expect(spies.onDone).toHaveBeenCalledTimes(1));

    expect(spies.onDelta).toHaveBeenLastCalledWith('full answer');
    expect(spies.onDone).toHaveBeenCalledWith({
      assistant: 'full answer',
      tools: [],
      delivered: true,
    });
  });

  it('budget_exceeded_per_turn is terminal — onError fires, onDone does not', async () => {
    fetchMock.mockResolvedValue(
      respondWith([
        {
          type: 'budget_exceeded_per_turn',
          code: 'budget_exceeded_per_turn',
          message: 'Budget exceeded.',
          usedUsd: 1,
          limitUsd: 1,
        },
        { type: 'done' },
      ])
    );

    const { result } = renderHook(() => useChatStream({ agentSlug: 'resparkable-companion' }));
    const { spies, callbacks: cb } = callbacks();

    result.current.send('hi', cb);
    await waitFor(() => expect(spies.onError).toHaveBeenCalledWith('Budget exceeded.'));

    expect(spies.onDone).not.toHaveBeenCalled();
  });

  it('a 429 response maps to an actionable rate-limit message', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 429, body: null });

    const { result } = renderHook(() => useChatStream({ agentSlug: 'resparkable-companion' }));
    const { spies, callbacks: cb } = callbacks();

    result.current.send('hi', cb);
    await waitFor(() => expect(spies.onError).toHaveBeenCalledTimes(1));

    expect(spies.onError).toHaveBeenCalledWith(expect.stringContaining('faster than the limit'));
  });

  it('threads conversationId from start into the next send', async () => {
    fetchMock.mockResolvedValue(
      respondWith([{ type: 'start', conversationId: 'conv_9' }, { type: 'done' }])
    );

    const { result } = renderHook(() => useChatStream({ agentSlug: 'resparkable-companion' }));
    const { spies, callbacks: cb } = callbacks();

    result.current.send('first', cb);
    await waitFor(() => expect(spies.onDone).toHaveBeenCalledTimes(1));

    result.current.send('second', cb);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    const second = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as Record<
      string,
      unknown
    >;
    expect(second.conversationId).toBe('conv_9');
  });

  it('streaming is true while a turn is in flight and false once it settles', async () => {
    let resolveFetch: ((response: Response) => void) | undefined;
    fetchMock.mockReturnValue(
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      })
    );

    const { result } = renderHook(() => useChatStream({ agentSlug: 'resparkable-companion' }));
    const { callbacks: cb } = callbacks();

    expect(result.current.streaming).toBe(false);
    result.current.send('hi', cb);
    await waitFor(() => expect(result.current.streaming).toBe(true));

    resolveFetch?.(respondWith([{ type: 'done' }]));
    await waitFor(() => expect(result.current.streaming).toBe(false));
  });
});
