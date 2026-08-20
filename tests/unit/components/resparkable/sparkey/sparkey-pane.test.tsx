/**
 * Unit Tests: SparkeyPane.
 *
 * `useChatStream` is mocked here — its own wire-protocol contract is
 * pinned down in `use-chat-stream.test.ts`. What this file covers is the
 * routing decision SparkeyPane itself makes: which of capture / chat /
 * instruct / declined a submit becomes, and the "give the words back"
 * behavior when an agent turn delivers nothing.
 *
 * @see components/resparkable/sparkey/sparkey-pane.tsx
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { SparkeyPane } from '@/components/resparkable/sparkey/sparkey-pane';
import { apiClient } from '@/lib/api/client';
import type { ChatStreamCallbacks } from '@/components/resparkable/chat/use-chat-stream';

const sendMock = vi.fn<(text: string, callbacks: ChatStreamCallbacks) => void>();

vi.mock('@/components/resparkable/chat/use-chat-stream', () => ({
  useChatStream: () => ({ streaming: false, send: sendMock }),
}));

vi.mock('@/lib/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/client')>('@/lib/api/client');
  return { ...actual, apiClient: { ...actual.apiClient, post: vi.fn() } };
});

/** The callbacks SparkeyPane handed to the most recent `chat.send(...)` call. */
function lastCallbacks(): ChatStreamCallbacks {
  const call = sendMock.mock.calls.at(-1);
  if (!call) throw new Error('chat.send was never called');
  return call[1];
}

async function selectMode(
  user: ReturnType<typeof userEvent.setup>,
  mode: 'Chat' | 'Capture' | 'Instruct'
) {
  await user.click(screen.getByRole('radio', { name: mode }));
}

async function typeAndSend(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.type(screen.getByRole('textbox', { name: 'Message' }), text);
  await user.click(screen.getByRole('button', { name: 'Send' }));
}

beforeEach(() => {
  sendMock.mockClear();
  vi.mocked(apiClient.post).mockReset();
  // Mode persists via the real useLocalStorage — without this, a mode
  // selected in one test leaks into the next via a shared storage key.
  window.localStorage.clear();
});

describe('SparkeyPane — identity', () => {
  it('names the pane, so it reads as Sparkey rather than a bare composer', () => {
    render(<SparkeyPane />);
    expect(screen.getByRole('heading', { name: 'Ask Sparkey' })).toBeInTheDocument();
  });
});

describe('SparkeyPane — collapsed drawer', () => {
  it('renders PaneRail instead of the composer when collapsed, whole strip clickable to expand', async () => {
    const onExpand = vi.fn();
    const user = userEvent.setup();
    render(<SparkeyPane collapsed onExpand={onExpand} />);

    expect(screen.queryByRole('heading', { name: 'Ask Sparkey' })).not.toBeInTheDocument();
    // PaneRail is one full-strip <button>, not a small icon target — clicking
    // it anywhere (not e.g. only its chevron) must re-expand.
    const rail = screen.getByRole('button', { name: 'Show Sparkey' });
    expect(rail).toBeInTheDocument();

    await user.click(rail);
    expect(onExpand).toHaveBeenCalledTimes(1);
  });

  it('renders no collapse control of its own when expanded — that lives on the handle now', () => {
    render(<SparkeyPane />);

    expect(screen.queryByRole('button', { name: /collapse sparkey/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /show sparkey/i })).not.toBeInTheDocument();
  });
});

describe('SparkeyPane — capture mode', () => {
  it('POSTs to /thoughts and shows a capture receipt', async () => {
    vi.mocked(apiClient.post).mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<SparkeyPane />);

    await selectMode(user, 'Capture');
    await typeAndSend(user, 'a thought worth keeping');

    expect(apiClient.post).toHaveBeenCalledWith(
      '/api/v1/resparkable/thoughts',
      expect.objectContaining({
        body: expect.objectContaining({ content: 'a thought worth keeping' }),
      })
    );
    expect(sendMock).not.toHaveBeenCalled();
    expect(screen.getByText('a thought worth keeping')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Captured — in your inbox.')).toBeInTheDocument());
  });

  it('shows an error receipt when the capture fails', async () => {
    vi.mocked(apiClient.post).mockRejectedValue(new Error('network down'));
    const user = userEvent.setup();
    render(<SparkeyPane />);

    await selectMode(user, 'Capture');
    await typeAndSend(user, 'a note');

    await waitFor(() => expect(screen.getByText('Couldn’t capture this.')).toBeInTheDocument());
  });
});

describe('SparkeyPane — chat mode', () => {
  it('streams into a chat entry via useChatStream', async () => {
    const user = userEvent.setup();
    render(<SparkeyPane />);

    await typeAndSend(user, 'what did I capture about Acme');

    expect(sendMock).toHaveBeenCalledWith('what did I capture about Acme', expect.any(Object));
    expect(screen.getByText('what did I capture about Acme')).toBeInTheDocument();

    act(() => lastCallbacks().onDelta?.('Here is what'));
    await waitFor(() => expect(screen.getByText('Here is what')).toBeInTheDocument());
  });

  it('restores the draft and drops the entry when a turn delivers nothing', async () => {
    const user = userEvent.setup();
    render(<SparkeyPane />);

    await typeAndSend(user, 'hello there');
    const log = screen.getByRole('log', { name: 'Sparkey transcript' });
    expect(within(log).getByText('hello there')).toBeInTheDocument();

    act(() => lastCallbacks().onDone({ assistant: '', tools: [], delivered: false }));

    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('hello there')
    );
    expect(within(log).queryByText('hello there')).not.toBeInTheDocument();
  });
});

describe('SparkeyPane — instruct mode', () => {
  it('sends a non-board instruction through the agent as an instruct entry', async () => {
    const user = userEvent.setup();
    render(<SparkeyPane />);

    await selectMode(user, 'Instruct');
    await typeAndSend(user, 'create a project for the Q3 launch');

    expect(sendMock).toHaveBeenCalledWith('create a project for the Q3 launch', expect.any(Object));

    act(() =>
      lastCallbacks().onDone({
        assistant: '',
        tools: ['resparkable_upsert_project'],
        delivered: true,
      })
    );
    await waitFor(() =>
      expect(screen.getByText('created or changed a project')).toBeInTheDocument()
    );
  });

  it('declines a board-column move locally, without calling the agent', async () => {
    const user = userEvent.setup();
    render(<SparkeyPane />);

    await selectMode(user, 'Instruct');
    await typeAndSend(user, 'move this to Doing');

    expect(sendMock).not.toHaveBeenCalled();
    expect(
      screen.getByText(/Moving cards between board columns isn.t available through Sparkey yet/)
    ).toBeInTheDocument();
  });
});
