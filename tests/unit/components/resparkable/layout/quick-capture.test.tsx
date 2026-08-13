/**
 * QuickCapture Component Tests
 *
 * This component has one job it must never fail at: not losing the thought.
 * Capture is optimistic — the textarea clears before the POST resolves, because
 * waiting on a round trip makes rapid capture feel broken — which means a failed
 * request has already wiped the only copy of what the user typed. The restore
 * path is therefore the most important assertion in this file, not an edge case.
 *
 * Test Coverage:
 * - Submitting POSTs the thought content to the thoughts collection
 * - Typed-only input sends no `source` — the schema's own default (`web`) covers it
 * - Dictating and submitting without further edits sends `source: 'voice'`
 * - Photographing and submitting without further edits sends `source: 'image'`
 * - Editing by hand after dictating clears it back to unset before submit
 * - A failed submit restores the source along with the text, so a retry is honest
 * - The textarea clears optimistically on submit
 * - A FAILED POST puts the text back in the box and reports the error, so the
 *   words are never lost
 * - Whitespace-only input does not fire a request
 * - ⌘/Ctrl+Enter submits from inside the textarea
 * - A successful capture refreshes the route so the nav's inbox badge follows
 *
 * @see components/resparkable/layout/quick-capture.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRouter } from 'next/navigation';

import { QuickCapture } from '@/components/resparkable/layout/quick-capture';

vi.mock('@/components/resparkable/documents/upload-request', () => ({
  uploadDocument: vi.fn(),
}));

vi.mock('@/lib/api/client', () => ({
  apiClient: { post: vi.fn() },
  APIClientError: class APIClientError extends Error {},
}));

// `VoiceCaptureButton` renders nothing unless `useVoiceRecording()` reports
// `supported: true` — true in a real browser, false under jsdom, which has no
// `MediaRecorder`. Mocked the same way `voice-capture-button.test.tsx` mocks it,
// so the tests below drive the *real* button, not a stand-in for it.
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

const stopMock = vi.fn(async () => ({
  blob: new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/webm' }),
  mimeType: 'audio/webm',
  durationMs: 1200,
}));

vi.mock('@/lib/hooks/use-voice-recording', () => ({
  DEFAULT_MAX_DURATION_MS: 180_000,
  useVoiceRecording: () => ({
    state: hookState.state,
    elapsedMs: hookState.elapsedMs,
    error: hookState.error,
    supported: hookState.supported,
    stream: null as MediaStream | null,
    start: vi.fn(async () => {}),
    stop: stopMock,
    cancel: vi.fn(),
  }),
}));

import { apiClient } from '@/lib/api/client';
import { uploadDocument } from '@/components/resparkable/documents/upload-request';

const mockedUpload = vi.mocked(uploadDocument);

const mockedPost = apiClient.post as ReturnType<typeof vi.fn>;
const mockedRouter = useRouter as unknown as ReturnType<typeof vi.fn>;

const refresh = vi.fn();

/**
 * Drives the real `VoiceCaptureButton` through its stop → transcript step.
 * `hookState.state` is read once per render (it is a plain mock, not React
 * state — see the header note), so callers must set it to `'recording'`
 * *before* `render(<QuickCapture />)`, matching the pattern
 * `voice-capture-button.test.tsx` uses for the same hook mock.
 */
async function dictate(user: ReturnType<typeof userEvent.setup>, text: string): Promise<void> {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ success: true, data: { text } }),
  } as unknown as Response);

  await user.click(screen.getByRole('button', { name: /stop recording/i }));
  await waitFor(() => expect(textarea()).toHaveValue(text));
  hookState.state = 'idle';
}

beforeEach(() => {
  vi.clearAllMocks();
  hookState.state = 'idle';
  hookState.elapsedMs = 0;
  hookState.error = null;
  hookState.supported = true;
  mockedPost.mockResolvedValue({ id: 'thought_1' });
  mockedRouter.mockReturnValue({
    push: vi.fn(),
    replace: vi.fn(),
    refresh,
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  });
});

function textarea(): HTMLTextAreaElement {
  return screen.getByLabelText('Capture a thought');
}

/**
 * jsdom has no drag-and-drop, so the `dataTransfer` the handlers read is faked.
 * `types` matters as much as `files` — the component only claims a drop that is
 * actually carrying files.
 */
function dropFile(file: File): void {
  fireEvent.drop(textarea(), {
    dataTransfer: { types: ['Files'], files: [file] },
  });
}

describe('QuickCapture', () => {
  it('posts the trimmed content to the thoughts collection', async () => {
    const user = userEvent.setup();
    render(<QuickCapture />);

    await user.type(textarea(), '  Ring the accountant about the Q4 filing  ');
    await user.click(screen.getByRole('button', { name: /capture/i }));

    await waitFor(() => {
      expect(mockedPost).toHaveBeenCalledWith('/api/v1/resparkable/thoughts', {
        body: { content: 'Ring the accountant about the Q4 filing' },
      });
    });
  });

  it('sends no source for typed-only input — the schema default (`web`) covers it', async () => {
    const user = userEvent.setup();
    render(<QuickCapture />);

    await user.type(textarea(), 'A thought');
    await user.click(screen.getByRole('button', { name: /capture/i }));

    await waitFor(() => expect(mockedPost).toHaveBeenCalled());

    const body = mockedPost.mock.calls[0]?.[1]?.body as Record<string, unknown>;
    expect(body).not.toHaveProperty('source');
  });

  it('sends source: "voice" when the draft was dictated and not further edited', async () => {
    const user = userEvent.setup();
    hookState.state = 'recording';
    render(<QuickCapture />);

    await dictate(user, 'Ring the accountant');
    await user.click(screen.getByRole('button', { name: /capture/i }));

    await waitFor(() => {
      expect(mockedPost).toHaveBeenCalledWith('/api/v1/resparkable/thoughts', {
        body: { content: 'Ring the accountant', source: 'voice' },
      });
    });
  });

  it('sends source: "image" when the draft came from a photo and not further edited', async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: { text: 'Buy milk, call the dentist' } }),
    } as unknown as Response);

    render(<QuickCapture />);

    const photo = new File(['x'], 'note.jpg', { type: 'image/jpeg' });
    await user.upload(
      document.querySelector('input[type="file"][accept="image/*"]') as HTMLInputElement,
      photo
    );
    await waitFor(() => expect(textarea()).toHaveValue('Buy milk, call the dentist'));

    await user.click(screen.getByRole('button', { name: /capture/i }));

    await waitFor(() => {
      expect(mockedPost).toHaveBeenCalledWith('/api/v1/resparkable/thoughts', {
        body: { content: 'Buy milk, call the dentist', source: 'image' },
      });
    });
  });

  it('clears the source back to unset once the dictated text is hand-edited', async () => {
    const user = userEvent.setup();
    hookState.state = 'recording';
    render(<QuickCapture />);

    await dictate(user, 'Ring the accountant');
    await user.type(textarea(), ' tomorrow');
    await user.click(screen.getByRole('button', { name: /capture/i }));

    await waitFor(() => {
      expect(mockedPost).toHaveBeenCalledWith('/api/v1/resparkable/thoughts', {
        body: { content: 'Ring the accountant tomorrow' },
      });
    });
  });

  it('restores the source alongside the text when a dictated capture fails', async () => {
    const user = userEvent.setup();
    mockedPost.mockRejectedValue(new Error('offline'));
    hookState.state = 'recording';
    render(<QuickCapture />);

    await dictate(user, 'Ring the accountant');
    await user.click(screen.getByRole('button', { name: /capture/i }));

    await waitFor(() => expect(textarea()).toHaveValue('Ring the accountant'));

    // Retry, now that the connection is back — the source must not have been
    // silently dropped by the failed attempt.
    mockedPost.mockResolvedValue({ id: 'thought_1' });
    await user.click(screen.getByRole('button', { name: /capture/i }));

    await waitFor(() => {
      expect(mockedPost).toHaveBeenLastCalledWith('/api/v1/resparkable/thoughts', {
        body: { content: 'Ring the accountant', source: 'voice' },
      });
    });
  });

  it('clears the box immediately rather than waiting for the response', async () => {
    const user = userEvent.setup();
    // A POST that never settles — the box must still be empty.
    mockedPost.mockReturnValue(new Promise(() => {}));
    render(<QuickCapture />);

    await user.type(textarea(), 'Half-formed idea');
    await user.click(screen.getByRole('button', { name: /capture/i }));

    await waitFor(() => expect(textarea()).toHaveValue(''));
  });

  it('puts the text BACK when the request fails, so nothing is lost', async () => {
    const user = userEvent.setup();
    mockedPost.mockRejectedValue(new Error('offline'));
    render(<QuickCapture />);

    await user.type(textarea(), 'The one thought I must not lose');
    await user.click(screen.getByRole('button', { name: /capture/i }));

    await waitFor(() => {
      expect(textarea()).toHaveValue('The one thought I must not lose');
    });
    expect(screen.getByText('offline')).toBeInTheDocument();
  });

  it('ignores a whitespace-only submission', async () => {
    const user = userEvent.setup();
    render(<QuickCapture />);

    await user.type(textarea(), '   ');
    // The button is disabled for blank input, so drive the form directly to
    // prove the guard is in the handler and not only in the disabled attribute.
    await user.keyboard('{Control>}{Enter}{/Control}');

    expect(mockedPost).not.toHaveBeenCalled();
  });

  it('submits on Ctrl+Enter from inside the textarea', async () => {
    const user = userEvent.setup();
    render(<QuickCapture />);

    await user.click(textarea());
    await user.keyboard('Captured by keyboard');
    await user.keyboard('{Control>}{Enter}{/Control}');

    await waitFor(() => {
      expect(mockedPost).toHaveBeenCalledWith('/api/v1/resparkable/thoughts', {
        body: { content: 'Captured by keyboard' },
      });
    });
  });

  it('refreshes the route after a successful capture so badges follow', async () => {
    const user = userEvent.setup();
    render(<QuickCapture />);

    await user.type(textarea(), 'Something new');
    await user.click(screen.getByRole('button', { name: /capture/i }));

    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('takes a dropped file and asks where it should go', async () => {
    render(<QuickCapture />);

    dropFile(new File(['# Notes'], 'notes.md', { type: 'text/markdown' }));

    expect(await screen.findByTestId('capture-attachment')).toBeInTheDocument();
    // Neither destination is chosen for the user — that is the whole design.
    expect(screen.getByRole('button', { name: /read into capture/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add to documents/i })).toBeInTheDocument();
  });

  it('ignores a drag that is not carrying files, so selecting text is harmless', () => {
    render(<QuickCapture />);

    fireEvent.drop(textarea(), {
      dataTransfer: { types: ['text/plain'], files: [] },
    });

    expect(screen.queryByTestId('capture-attachment')).not.toBeInTheDocument();
  });

  it('appends extracted text to what you already wrote instead of replacing it', async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: { text: 'Revenue is up.', characters: 14, truncated: false },
      }),
    } as unknown as Response);

    render(<QuickCapture />);

    await user.type(textarea(), 'My own framing:');
    dropFile(new File(['x'], 'report.pdf', { type: 'application/pdf' }));
    await user.click(await screen.findByRole('button', { name: /read into capture/i }));

    // The words you typed are the point; the file's text joins them.
    await waitFor(() => {
      expect(textarea()).toHaveValue('My own framing:\n\nRevenue is up.');
    });
    expect(screen.queryByTestId('capture-attachment')).not.toBeInTheDocument();
  });

  it('does not capture anything on its own when a file is read in', async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: { text: 'Some prose', characters: 10 } }),
    } as unknown as Response);

    render(<QuickCapture />);
    dropFile(new File(['x'], 'report.pdf', { type: 'application/pdf' }));
    await user.click(await screen.findByRole('button', { name: /read into capture/i }));

    await waitFor(() => expect(textarea()).toHaveValue('Some prose'));
    // A draft, until a person presses Capture.
    expect(mockedPost).not.toHaveBeenCalled();
  });

  it('does not refresh when the capture failed', async () => {
    const user = userEvent.setup();
    mockedPost.mockRejectedValue(new Error('nope'));
    render(<QuickCapture />);

    await user.type(textarea(), 'Something new');
    await user.click(screen.getByRole('button', { name: /capture/i }));

    await waitFor(() => expect(screen.getByText('nope')).toBeInTheDocument());
    expect(refresh).not.toHaveBeenCalled();
  });

  it('starts with initialValue in the box, for the share-target page', () => {
    render(<QuickCapture initialValue="Shared from another app" />);

    expect(textarea()).toHaveValue('Shared from another app');
  });

  it('sends initialSource when the pre-filled draft is captured unedited', async () => {
    const user = userEvent.setup();
    render(<QuickCapture initialValue="Shared from another app" initialSource="pwa" />);

    await user.click(screen.getByRole('button', { name: /capture/i }));

    await waitFor(() => {
      expect(mockedPost).toHaveBeenCalledWith('/api/v1/resparkable/thoughts', {
        body: { content: 'Shared from another app', source: 'pwa' },
      });
    });
  });

  it('clears initialSource back to unset once the shared draft is hand-edited', async () => {
    const user = userEvent.setup();
    render(<QuickCapture initialValue="Shared from another app" initialSource="pwa" />);

    await user.type(textarea(), ' — worth following up');
    await user.click(screen.getByRole('button', { name: /capture/i }));

    await waitFor(() => {
      expect(mockedPost).toHaveBeenCalledWith('/api/v1/resparkable/thoughts', {
        body: { content: 'Shared from another app — worth following up' },
      });
    });
  });

  it('lights up the drop zone on dragover and clears it on dragleave', () => {
    render(<QuickCapture />);

    fireEvent.dragOver(textarea(), { dataTransfer: { types: ['Files'] } });
    expect(textarea().className).toMatch(/border-primary/);

    fireEvent.dragLeave(textarea());
    expect(textarea().className).not.toMatch(/border-primary/);
  });

  it('does not light up the drop zone for a drag that carries no files', () => {
    render(<QuickCapture />);

    fireEvent.dragOver(textarea(), { dataTransfer: { types: ['text/plain'] } });
    expect(textarea().className).not.toMatch(/border-primary/);
  });

  it('forgets a dropped file without reading or filing it', async () => {
    render(<QuickCapture />);
    dropFile(new File(['x'], 'report.pdf', { type: 'application/pdf' }));

    const card = await screen.findByTestId('capture-attachment');
    await userEvent
      .setup()
      .click(within(card).getByRole('button', { name: /forget report\.pdf/i }));

    expect(screen.queryByTestId('capture-attachment')).not.toBeInTheDocument();
    expect(mockedPost).not.toHaveBeenCalled();
  });

  it('reports and refreshes after "Add to Documents" filing a new file', async () => {
    const user = userEvent.setup();
    mockedUpload.mockResolvedValue({ ok: true, deduped: false });

    render(<QuickCapture />);
    dropFile(new File(['x'], 'report.pdf', { type: 'application/pdf' }));
    await user.click(await screen.findByRole('button', { name: /add to documents/i }));

    await waitFor(() =>
      expect(screen.getByText(/becomes searchable once indexed/i)).toBeInTheDocument()
    );
    expect(refresh).toHaveBeenCalled();
    expect(screen.queryByTestId('capture-attachment')).not.toBeInTheDocument();
  });

  it('reports a dedupe distinctly from a newly filed document', async () => {
    const user = userEvent.setup();
    mockedUpload.mockResolvedValue({ ok: true, deduped: true });

    render(<QuickCapture />);
    dropFile(new File(['x'], 'report.pdf', { type: 'application/pdf' }));
    await user.click(await screen.findByRole('button', { name: /add to documents/i }));

    await waitFor(() => expect(screen.getByText(/same file, so nothing new/i)).toBeInTheDocument());
  });

  it('shows a dictation failure as an alert, not an info note', async () => {
    hookState.error = { code: 'permission_denied', message: 'Microphone access was blocked' };
    render(<QuickCapture />);

    // The error tone renders role="alert" (note.tone === 'error'); the info
    // tone renders role="status" — this is what proves the branch was taken.
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Microphone access was blocked');
    });
  });

  it('shows an image extraction failure as an alert', async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ success: false, error: { code: 'NO_VISION_PROVIDER' } }),
    } as unknown as Response);

    render(<QuickCapture />);
    const photo = new File(['x'], 'note.jpg', { type: 'image/jpeg' });
    await user.upload(
      document.querySelector('input[type="file"][accept="image/*"]') as HTMLInputElement,
      photo
    );

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/vision-capable model/i);
    });
    expect(mockedPost).not.toHaveBeenCalled();
  });
});
