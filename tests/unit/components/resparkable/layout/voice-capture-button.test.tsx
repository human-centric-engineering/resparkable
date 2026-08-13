/**
 * VoiceCaptureButton tests.
 *
 * Two properties this file is here to defend:
 *
 * - **The transcript is handed back, never posted.** Dictation mishears things,
 *   and a capture box that filed straight from the microphone would file the
 *   mishearing. The button's contract is `onTranscript`, and it has no path that
 *   writes a thought.
 * - **The route it posts to is Resparkable's, not the admin one.** The platform's
 *   transcribe endpoint is `withAdminAuth`; pointing here at it would work in a
 *   developer's own browser and 403 for every other user, which is the worst
 *   possible way for this to break.
 *
 * Errors are asserted as the sentence the user reads rather than the code,
 * because "no provider configured" and "transcription failed" send someone
 * looking in completely different places.
 *
 * @see components/resparkable/layout/voice-capture-button.tsx
 */

import * as React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

interface RecordingHookState {
  state: 'idle' | 'requesting' | 'recording' | 'stopping';
  elapsedMs: number;
  error: { code: string; message: string } | null;
  supported: boolean;
}

const hookState: RecordingHookState = {
  state: 'idle',
  elapsedMs: 0,
  error: null,
  supported: true,
};

const startMock = vi.fn(async () => {});
const stopMock = vi.fn(async () => ({
  blob: new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/webm' }),
  mimeType: 'audio/webm',
  durationMs: 1500,
}));

// The hook mock reads `hookState` on each invocation, so pre-setting it before
// render controls what the button sees. It does not force a re-render when the
// object mutates afterwards — every test here pre-sets state and asserts at the
// dispatch level (mock calls, callback arguments), which is the same approach
// the platform's mic-button tests take and for the same reason.
vi.mock('@/lib/hooks/use-voice-recording', () => ({
  DEFAULT_MAX_DURATION_MS: 180_000,
  useVoiceRecording: () => ({
    state: hookState.state,
    elapsedMs: hookState.elapsedMs,
    error: hookState.error,
    supported: hookState.supported,
    stream: null as MediaStream | null,
    start: startMock,
    stop: stopMock,
    cancel: vi.fn(),
  }),
}));

import { VoiceCaptureButton } from '@/components/resparkable/layout/voice-capture-button';

const fetchMock = vi.fn();

beforeEach(() => {
  hookState.state = 'idle';
  hookState.elapsedMs = 0;
  hookState.error = null;
  hookState.supported = true;
  startMock.mockClear();
  stopMock.mockClear();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(status: number, payload: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

function makeProps(overrides: Partial<React.ComponentProps<typeof VoiceCaptureButton>> = {}) {
  return { onTranscript: vi.fn(), onError: vi.fn(), ...overrides };
}

describe('VoiceCaptureButton', () => {
  it('renders nothing when the browser cannot record', () => {
    hookState.supported = false;
    const { container } = render(<VoiceCaptureButton {...makeProps()} />);

    // A button that fails on click is worse than no button.
    expect(container).toBeEmptyDOMElement();
  });

  it('starts recording on the first click', async () => {
    const user = userEvent.setup();
    render(<VoiceCaptureButton {...makeProps()} />);

    await user.click(screen.getByRole('button', { name: /dictate a thought/i }));

    expect(startMock).toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('hands the transcript back instead of posting a thought', async () => {
    const user = userEvent.setup();
    hookState.state = 'recording';
    fetchMock.mockResolvedValue(
      jsonResponse(200, { success: true, data: { text: 'ring the accountant', durationMs: 1500 } })
    );

    const props = makeProps();
    render(<VoiceCaptureButton {...props} />);

    await user.click(screen.getByRole('button', { name: /stop recording/i }));

    await waitFor(() => expect(props.onTranscript).toHaveBeenCalledWith('ring the accountant'));
    expect(props.onError).not.toHaveBeenCalled();
  });

  it('posts to Resparkable’s transcribe route, not the admin one', async () => {
    const user = userEvent.setup();
    hookState.state = 'recording';
    fetchMock.mockResolvedValue(jsonResponse(200, { success: true, data: { text: 'hello' } }));

    render(<VoiceCaptureButton {...makeProps()} />);
    await user.click(screen.getByRole('button', { name: /stop recording/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/resparkable/transcribe');

    // No agentId travels from the browser — the route resolves it server-side so
    // a client cannot bill one agent for another's audio.
    const body = fetchMock.mock.calls[0]?.[1]?.body as FormData;
    expect(body.get('agentId')).toBeNull();
    expect(body.get('audio')).toBeInstanceOf(File);
  });

  it('turns a missing provider into advice an admin can act on', async () => {
    const user = userEvent.setup();
    hookState.state = 'recording';
    fetchMock.mockResolvedValue(
      jsonResponse(503, { success: false, error: { code: 'NO_AUDIO_PROVIDER' } })
    );

    const props = makeProps();
    render(<VoiceCaptureButton {...props} />);
    await user.click(screen.getByRole('button', { name: /stop recording/i }));

    await waitFor(() => {
      expect(props.onError).toHaveBeenCalledWith(
        expect.stringContaining('speech-to-text provider')
      );
    });
    expect(props.onTranscript).not.toHaveBeenCalled();
  });

  it('reports a network failure without claiming the words were lost to the mic', async () => {
    const user = userEvent.setup();
    hookState.state = 'recording';
    fetchMock.mockRejectedValue(new Error('offline'));

    const props = makeProps();
    render(<VoiceCaptureButton {...props} />);
    await user.click(screen.getByRole('button', { name: /stop recording/i }));

    await waitFor(() => {
      expect(props.onError).toHaveBeenCalledWith(expect.stringContaining('transcription service'));
    });
  });

  it.each([
    ['VOICE_DISABLED', /switched off on this instance/i],
    ['AGENT_NOT_SEEDED', /speech-to-text provider/i],
    ['AUDIO_TOO_LARGE', /too long/i],
    ['AUDIO_INVALID_TYPE', /format we can.t transcribe/i],
    ['RATE_LIMIT_EXCEEDED', /lot of dictation/i],
  ])('turns %s into its own sentence', async (code, expected) => {
    const user = userEvent.setup();
    hookState.state = 'recording';
    fetchMock.mockResolvedValue(jsonResponse(503, { success: false, error: { code } }));

    const props = makeProps();
    render(<VoiceCaptureButton {...props} />);
    await user.click(screen.getByRole('button', { name: /stop recording/i }));

    await waitFor(() =>
      expect(props.onError).toHaveBeenCalledWith(expect.stringMatching(expected))
    );
  });

  it('falls back to the server-supplied message for an unrecognised error code', async () => {
    const user = userEvent.setup();
    hookState.state = 'recording';
    fetchMock.mockResolvedValue(
      jsonResponse(500, {
        success: false,
        error: { code: 'SOMETHING_NEW', message: 'a new failure mode' },
      })
    );

    const props = makeProps();
    render(<VoiceCaptureButton {...props} />);
    await user.click(screen.getByRole('button', { name: /stop recording/i }));

    await waitFor(() => expect(props.onError).toHaveBeenCalledWith('a new failure mode'));
  });

  it.each([
    ['audio/mp4', 'audio.mp4'],
    ['audio/webm', 'audio.webm'],
    ['audio/ogg', 'audio.ogg'],
    ['application/octet-stream', 'audio.bin'],
  ])(
    'names the uploaded file %s → %s from the recorder-reported mime type',
    async (mimeType, filename) => {
      const user = userEvent.setup();
      hookState.state = 'recording';
      stopMock.mockResolvedValueOnce({
        blob: new Blob([new Uint8Array([1, 2, 3, 4])], { type: mimeType }),
        mimeType,
        durationMs: 1000,
      });
      fetchMock.mockResolvedValue(jsonResponse(200, { success: true, data: { text: 'hi' } }));

      render(<VoiceCaptureButton {...makeProps()} />);
      await user.click(screen.getByRole('button', { name: /stop recording/i }));

      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      const body = fetchMock.mock.calls[0]?.[1]?.body as FormData;
      const file = body.get('audio') as File;
      expect(file.name).toBe(filename);
    }
  );

  it('surfaces a permission failure from the recorder itself', async () => {
    hookState.error = { code: 'permission_denied', message: 'Microphone access was blocked' };

    const props = makeProps();
    render(<VoiceCaptureButton {...props} />);

    await waitFor(() => {
      expect(props.onError).toHaveBeenCalledWith('Microphone access was blocked');
    });
  });

  /**
   * Regression test. Every caller of this component in the codebase passes
   * `onError` as an inline closure — a new function reference every time the
   * *parent* re-renders, including a re-render the parent makes in response to
   * this exact effect calling `onError`. An effect that depended on `onError`
   * directly turned one real recorder error into an infinite loop: fire, parent
   * re-renders, `onError` reference changes, effect's deps changed, fire again
   * — forever, with `recording.error` never needing to change at all. This
   * reproduces that shape (a parent that hands down a fresh closure on every
   * render) and asserts the call count settles rather than growing.
   */
  it('calls onError once per real error, even when the caller hands it a new closure on every render', async () => {
    hookState.error = { code: 'permission_denied', message: 'Microphone access was blocked' };
    const calls = vi.fn();

    function ChurningParent() {
      const [, forceRerender] = React.useState(0);
      // A fresh closure every render — the shape every real caller has.
      return (
        <>
          <VoiceCaptureButton onTranscript={vi.fn()} onError={() => calls()} />
          <button onClick={() => forceRerender((n) => n + 1)}>rerender parent</button>
        </>
      );
    }

    const user = userEvent.setup();
    render(<ChurningParent />);

    await waitFor(() => expect(calls).toHaveBeenCalledTimes(1));

    // Force three more parent re-renders, each handing VoiceCaptureButton a
    // brand-new `onError` closure. The buggy version re-fired the effect on
    // every single one of these.
    await user.click(screen.getByRole('button', { name: /rerender parent/i }));
    await user.click(screen.getByRole('button', { name: /rerender parent/i }));
    await user.click(screen.getByRole('button', { name: /rerender parent/i }));

    expect(calls).toHaveBeenCalledTimes(1);
  });
});
