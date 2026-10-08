// @vitest-environment happy-dom

/**
 * NoteTab Component Tests
 *
 * The note editor autosaves, so in a group two people with one note open would
 * otherwise overwrite each other with no warning. Phase 63 makes every save send
 * the `rev` it last saw and stop on a 409 until the person chooses.
 *
 * Test Coverage:
 * - The first save sends the rev the note loaded with, the next sends the rev
 *   the first save returned
 * - Saves run one at a time, so a second save never reuses the first's rev
 * - A row without rev saves without one (last-write-wins, as before)
 * - A 409 shows NOTE_CONFLICT_MESSAGE, keeps the typed text and stops autosave
 * - "Save my version" writes the typed text with the other version's rev
 * - "Use their version" replaces the text, and later saves send their rev
 * - Closing the tab during a shown conflict writes nothing; a conflict found
 *   after close (the flush, or a save in flight) keeps the text as a new note
 * - Saves go to the workspace the editor opened in, fixed at mount
 * - A non-409 error shows its own message and offers no choice
 * - A 409 without the current row fetches the row and offers the same choice
 * - A 409 that changed the row but not the words (a status change, a response
 *   with no rev) saves through without asking, at most three attempts, and
 *   compares against the text the server stored (it trims)
 * - A real conflict is held even on the last attempt
 * - "Use their version" drops a save queued before it; one failed save does
 *   not stop later ones
 * - Saves to one note queue across editors: a reopened editor waits for the
 *   closing editor's flush, and asks rather than writing over it
 * - Loading and load-error states render before any editor exists
 *
 * @see components/resparkable/workspace/tabs/note-tab.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

import { NOTE_CONFLICT_MESSAGE, NoteTab } from '@/components/resparkable/workspace/tabs/note-tab';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import { thoughtSchema } from '@/lib/framework/resparkable/ui/payloads';

vi.mock('@/lib/api/client', () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  APIClientError: class APIClientError extends Error {},
}));

vi.mock('@/components/resparkable/workspace/tabs/use-tab-fetch', () => ({
  useTabFetch: vi.fn(),
}));

vi.mock('@/components/resparkable/workspace/tabs/use-tab-title', () => ({
  useTabTitle: vi.fn(),
  titleFromNoteBody: (body: string) => body.split('\n')[0] ?? '',
}));

import { apiClient, APIClientError } from '@/lib/api/client';
import { useTabFetch } from '@/components/resparkable/workspace/tabs/use-tab-fetch';

const mockPatch = vi.mocked(apiClient.patch);
const mockGet = vi.mocked(apiClient.get);
const mockPost = vi.mocked(apiClient.post);
const NOTE_PATH = RESPARKABLE_API.itemPath(RESPARKABLE_API.THOUGHTS, 'thought_1');

function noteRow(rev: number | undefined): Record<string, unknown> {
  return {
    id: 'thought_1',
    content: 'First draft',
    source: 'manual',
    status: 'inbox',
    promotedToType: null,
    promotedToId: null,
    snoozedUntil: null,
    snoozeCount: 0,
    archivedAt: null,
    ...(rev === undefined ? {} : { rev }),
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  };
}

function loadNote(rev: number | undefined): void {
  vi.mocked(useTabFetch).mockReturnValue([
    { status: 'ready', data: thoughtSchema.parse(noteRow(rev)) },
    vi.fn(),
  ]);
}

function conflictError(rev: number, content: string): Error {
  return Object.assign(new APIClientError('ignored by the handler'), {
    status: 409,
    details: { current: { id: 'thought_1', rev, content } },
  });
}

function type(value: string): void {
  fireEvent.change(screen.getByLabelText('Note body'), { target: { value } });
}

/** Lets the 800 ms debounce fire and the save it starts settle. */
async function flushSave(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(800);
  });
}

describe('NoteTab: rev (phase 63)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    loadNote(3);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends the loaded rev first, then the rev each save returns', async () => {
    mockPatch.mockResolvedValueOnce({ id: 'thought_1', rev: 4, content: 'Second draft' });
    mockPatch.mockResolvedValueOnce({ id: 'thought_1', rev: 5, content: 'Third draft' });
    render(<NoteTab tabId="t1" id="thought_1" />);

    type('Second draft');
    await flushSave();
    type('Third draft');
    await flushSave();

    expect(mockPatch).toHaveBeenNthCalledWith(1, NOTE_PATH, {
      body: { content: 'Second draft', rev: 3 },
    });
    expect(mockPatch).toHaveBeenNthCalledWith(2, NOTE_PATH, {
      body: { content: 'Third draft', rev: 4 },
    });
  });

  it('waits for a slow save before starting the next, so it never reuses a rev', async () => {
    let finishFirst: (row: unknown) => void = () => {};
    mockPatch.mockImplementationOnce(() => new Promise((resolve) => (finishFirst = resolve)));
    mockPatch.mockResolvedValueOnce({ id: 'thought_1', rev: 5, content: 'Third draft' });
    render(<NoteTab tabId="t1" id="thought_1" />);

    type('Second draft');
    await flushSave();
    type('Third draft');
    await flushSave();

    // The first save is still in flight, so the second has not been sent.
    expect(mockPatch).toHaveBeenCalledTimes(1);

    await act(async () => {
      finishFirst({ id: 'thought_1', rev: 4, content: 'Second draft' });
      await vi.runAllTimersAsync();
    });

    expect(mockPatch).toHaveBeenCalledTimes(2);
    expect(mockPatch).toHaveBeenLastCalledWith(NOTE_PATH, {
      body: { content: 'Third draft', rev: 4 },
    });
  });

  it('saves without a rev when the row has none', async () => {
    loadNote(undefined);
    mockPatch.mockResolvedValueOnce({ id: 'thought_1' });
    render(<NoteTab tabId="t1" id="thought_1" />);

    type('Second draft');
    await flushSave();

    expect(mockPatch).toHaveBeenCalledWith(NOTE_PATH, { body: { content: 'Second draft' } });
  });

  it('on a 409 keeps the typed text and stops autosaving until the person chooses', async () => {
    mockPatch.mockRejectedValueOnce(conflictError(9, 'Their version'));
    render(<NoteTab tabId="t1" id="thought_1" />);

    type('My version');
    await flushSave();

    expect(screen.getByText(NOTE_CONFLICT_MESSAGE)).toBeInTheDocument();
    expect(screen.queryByText('ignored by the handler')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Note body')).toHaveValue('My version');

    // Typing on writes nothing: an autosave now would replace their version
    // without anyone having chosen to.
    type('My version, longer');
    await flushSave();
    expect(mockPatch).toHaveBeenCalledTimes(1);
  });

  it('"Save my version" writes the typed text with the other version\'s rev', async () => {
    mockPatch.mockRejectedValueOnce(conflictError(9, 'Their version'));
    mockPatch.mockResolvedValueOnce({ id: 'thought_1', rev: 10, content: 'My version' });
    render(<NoteTab tabId="t1" id="thought_1" />);

    type('My version');
    await flushSave();
    fireEvent.click(screen.getByRole('button', { name: 'Save my version' }));
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(mockPatch).toHaveBeenLastCalledWith(NOTE_PATH, {
      body: { content: 'My version', rev: 9 },
    });
    expect(screen.queryByText(NOTE_CONFLICT_MESSAGE)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save my version' })).not.toBeInTheDocument();
  });

  it('"Use their version" replaces the text, and the next save sends their rev', async () => {
    mockPatch.mockRejectedValueOnce(conflictError(9, 'Their version'));
    mockPatch.mockResolvedValueOnce({ id: 'thought_1', rev: 10, content: 'Their version, edited' });
    render(<NoteTab tabId="t1" id="thought_1" />);

    type('My version');
    await flushSave();
    fireEvent.click(screen.getByRole('button', { name: 'Use their version' }));

    expect(screen.getByLabelText('Note body')).toHaveValue('Their version');
    expect(screen.queryByText(NOTE_CONFLICT_MESSAGE)).not.toBeInTheDocument();
    expect(mockPatch).toHaveBeenCalledTimes(1);

    type('Their version, edited');
    await flushSave();

    expect(mockPatch).toHaveBeenLastCalledWith(NOTE_PATH, {
      body: { content: 'Their version, edited', rev: 9 },
    });
  });

  it('writes nothing when the tab closes during a conflict', async () => {
    mockPatch.mockRejectedValueOnce(conflictError(9, 'Their version'));
    const { unmount } = render(<NoteTab tabId="t1" id="thought_1" />);

    type('My version');
    await flushSave();
    type('My version, longer');
    unmount();
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(mockPatch).toHaveBeenCalledTimes(1);
  });

  it('shows its own message, and no choice, for a non-409 error', async () => {
    mockPatch.mockRejectedValueOnce(
      Object.assign(new APIClientError('That note is too long.'), { status: 400 })
    );
    render(<NoteTab tabId="t1" id="thought_1" />);

    type('My version');
    await flushSave();

    expect(screen.getByText('That note is too long.')).toBeInTheDocument();
    expect(screen.queryByText(NOTE_CONFLICT_MESSAGE)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save my version' })).not.toBeInTheDocument();
  });
});

describe('NoteTab: edges', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    loadNote(3);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('on a 409 without the current row, fetches the row and offers the choice', async () => {
    // Without the row the editor cannot learn the new rev, and every later
    // save would repeat the stale one. Fetching it turns that into a choice.
    mockPatch.mockRejectedValueOnce(
      Object.assign(new APIClientError('This note was changed by someone else.'), { status: 409 })
    );
    mockGet.mockResolvedValueOnce({ ...noteRow(9), content: 'Their version' });
    render(<NoteTab tabId="t1" id="thought_1" />);

    type('My version');
    await flushSave();

    expect(mockGet).toHaveBeenCalledWith(NOTE_PATH);
    expect(screen.getByText(NOTE_CONFLICT_MESSAGE)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Use their version' }));
    expect(screen.getByLabelText('Note body')).toHaveValue('Their version');
  });

  it('shows the server message when a 409 carries no row and the refetch has no rev', async () => {
    mockPatch.mockRejectedValueOnce(
      Object.assign(new APIClientError('This note was changed by someone else.'), { status: 409 })
    );
    mockGet.mockResolvedValueOnce({ ...noteRow(undefined), content: 'Their version' });
    render(<NoteTab tabId="t1" id="thought_1" />);

    type('My version');
    await flushSave();

    expect(screen.getByText('This note was changed by someone else.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save my version' })).not.toBeInTheDocument();
  });

  it('saves through a 409 that changed the row but not the words', async () => {
    // A status change or a snooze moves the rev and leaves the text alone.
    // Nobody else wrote anything, so there is nothing to ask about.
    mockPatch.mockRejectedValueOnce(conflictError(4, 'First draft'));
    mockPatch.mockResolvedValueOnce({ id: 'thought_1', rev: 5, content: 'Second draft' });
    render(<NoteTab tabId="t1" id="thought_1" />);

    type('Second draft');
    await flushSave();

    expect(mockPatch).toHaveBeenLastCalledWith(NOTE_PATH, {
      body: { content: 'Second draft', rev: 4 },
    });
    expect(screen.queryByText(NOTE_CONFLICT_MESSAGE)).not.toBeInTheDocument();
  });

  it('recovers when a save response carries no rev, instead of reporting itself as someone else', async () => {
    mockPatch.mockResolvedValueOnce({ id: 'thought_1' });
    // The server moved to 4 on that save; this editor still holds 3.
    mockPatch.mockRejectedValueOnce(conflictError(4, 'Second draft'));
    mockPatch.mockResolvedValueOnce({ id: 'thought_1', rev: 5, content: 'Third draft' });
    render(<NoteTab tabId="t1" id="thought_1" />);

    type('Second draft');
    await flushSave();
    type('Third draft');
    await flushSave();

    expect(mockPatch).toHaveBeenNthCalledWith(2, NOTE_PATH, {
      body: { content: 'Third draft', rev: 3 },
    });
    expect(mockPatch).toHaveBeenLastCalledWith(NOTE_PATH, {
      body: { content: 'Third draft', rev: 4 },
    });
    expect(screen.queryByText(NOTE_CONFLICT_MESSAGE)).not.toBeInTheDocument();
  });

  it('follows a rev that keeps moving without the words changing, up to the cap', async () => {
    mockPatch.mockRejectedValueOnce(conflictError(4, 'First draft'));
    mockPatch.mockRejectedValueOnce(conflictError(5, 'First draft'));
    mockPatch.mockResolvedValueOnce({ id: 'thought_1', rev: 6, content: 'Second draft' });
    render(<NoteTab tabId="t1" id="thought_1" />);

    type('Second draft');
    await flushSave();

    expect(mockPatch).toHaveBeenCalledTimes(3);
    expect(mockPatch).toHaveBeenLastCalledWith(NOTE_PATH, {
      body: { content: 'Second draft', rev: 5 },
    });
    expect(screen.queryByText(NOTE_CONFLICT_MESSAGE)).not.toBeInTheDocument();
  });

  it('compares the next conflict against the text the server stored, not the text sent', async () => {
    // The server trims a note body, so the words it holds can differ from the
    // keystrokes sent by trailing whitespace alone.
    mockPatch.mockResolvedValueOnce({ id: 'thought_1', rev: 4, content: 'Buy milk' });
    mockPatch.mockRejectedValueOnce(conflictError(5, 'Buy milk'));
    mockPatch.mockResolvedValueOnce({ id: 'thought_1', rev: 6, content: 'Buy milk and eggs' });
    render(<NoteTab tabId="t1" id="thought_1" />);

    type('Buy milk\n');
    await flushSave();
    type('Buy milk and eggs');
    await flushSave();

    expect(mockPatch).toHaveBeenLastCalledWith(NOTE_PATH, {
      body: { content: 'Buy milk and eggs', rev: 5 },
    });
    expect(screen.queryByText(NOTE_CONFLICT_MESSAGE)).not.toBeInTheDocument();
  });

  it('holds a real conflict even when it arrives on the last attempt', async () => {
    mockPatch.mockRejectedValueOnce(conflictError(4, 'First draft'));
    mockPatch.mockRejectedValueOnce(conflictError(5, 'First draft'));
    mockPatch.mockRejectedValueOnce(conflictError(6, 'Their version'));
    render(<NoteTab tabId="t1" id="thought_1" />);

    type('My version');
    await flushSave();

    expect(screen.getByText(NOTE_CONFLICT_MESSAGE)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Use their version' })).toBeInTheDocument();
  });

  it('drops a save queued before "Use their version", instead of sending it with their rev', async () => {
    mockPatch.mockRejectedValueOnce(conflictError(4, 'Their version'));
    render(<NoteTab tabId="t1" id="thought_1" />);
    type('My version');
    await flushSave();
    expect(screen.getByText(NOTE_CONFLICT_MESSAGE)).toBeInTheDocument();

    // A second editor of the same note closes with a slow save, so the shared
    // queue is busy when this editor's next keystroke save joins it.
    let finishOther: (row: unknown) => void = () => {};
    mockPatch.mockImplementationOnce(() => new Promise((resolve) => (finishOther = resolve)));
    const other = render(<NoteTab tabId="t2" id="thought_1" />);
    fireEvent.change(screen.getAllByLabelText('Note body')[1], {
      target: { value: 'Other pane text' },
    });
    other.unmount();
    type('My version, longer');
    await flushSave();

    // Choosing their version settles the conflict while that save still waits.
    fireEvent.click(screen.getByRole('button', { name: 'Use their version' }));
    await act(async () => {
      finishOther({ id: 'thought_1', rev: 5, content: 'Other pane text' });
      await vi.runAllTimersAsync();
    });

    expect(mockPatch).toHaveBeenCalledTimes(2);
    expect(mockPatch).not.toHaveBeenCalledWith(NOTE_PATH, {
      body: { content: 'My version, longer', rev: 4 },
    });
    expect(screen.getByLabelText('Note body')).toHaveValue('Their version');
  });

  it('keeps saving a note after one of its saves fails outright', async () => {
    mockPatch.mockRejectedValueOnce(new Error('Network down'));
    mockPatch.mockResolvedValueOnce({ id: 'thought_1', rev: 4, content: 'Second try' });
    render(<NoteTab tabId="t1" id="thought_1" />);

    type('First try');
    await flushSave();
    expect(screen.getByText('Network down')).toBeInTheDocument();

    type('Second try');
    await flushSave();
    expect(mockPatch).toHaveBeenLastCalledWith(NOTE_PATH, {
      body: { content: 'Second try', rev: 3 },
    });
  });

  it('stops following after three attempts and reports the failure', async () => {
    const stillMoving = Object.assign(
      new APIClientError('This note was changed by someone else.'),
      {
        status: 409,
        details: { current: { id: 'thought_1', rev: 9, content: 'First draft' } },
      }
    );
    mockPatch
      .mockRejectedValueOnce(stillMoving)
      .mockRejectedValueOnce(stillMoving)
      .mockRejectedValueOnce(stillMoving);
    render(<NoteTab tabId="t1" id="thought_1" />);

    type('Second draft');
    await flushSave();

    expect(mockPatch).toHaveBeenCalledTimes(3);
    expect(screen.getByText('This note was changed by someone else.')).toBeInTheDocument();
  });

  it("makes a reopened editor wait for the closing editor's save, then ask rather than overwrite it", async () => {
    // The closing editor flushes its last keystrokes; the reopened one loaded
    // the row from before that flush. Its save must not race the flush, and
    // must not write over the flushed words without asking.
    let finishFlush: (row: unknown) => void = () => {};
    mockPatch.mockImplementationOnce(() => new Promise((resolve) => (finishFlush = resolve)));
    const first = render(<NoteTab tabId="t1" id="thought_1" />);
    type('Written before closing');
    first.unmount();

    render(<NoteTab tabId="t2" id="thought_1" />);
    type('Written after reopening');
    await flushSave();
    expect(mockPatch).toHaveBeenCalledTimes(1);

    mockPatch.mockRejectedValueOnce(conflictError(4, 'Written before closing'));
    await act(async () => {
      finishFlush({ id: 'thought_1', rev: 4, content: 'Written before closing' });
      await vi.runAllTimersAsync();
    });

    expect(mockPatch).toHaveBeenCalledTimes(2);
    expect(mockPatch).toHaveBeenLastCalledWith(NOTE_PATH, {
      body: { content: 'Written after reopening', rev: 3 },
    });
    expect(screen.getByText(NOTE_CONFLICT_MESSAGE)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Use their version' }));
    expect(screen.getByLabelText('Note body')).toHaveValue('Written before closing');
  });

  it('keeps the closing text as a new note when the closing save finds a conflict', async () => {
    // Nobody is left to ask, so the text goes to a note of its own rather than
    // over the other version or nowhere.
    mockPatch.mockRejectedValueOnce(conflictError(4, 'Their version'));
    mockPost.mockResolvedValueOnce({ id: 'thought_2', rev: 0, content: 'Written before closing' });
    const { unmount } = render(<NoteTab tabId="t1" id="thought_1" />);

    type('Written before closing');
    unmount();
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(mockPatch).toHaveBeenCalledTimes(1);
    expect(mockPost).toHaveBeenCalledWith(RESPARKABLE_API.THOUGHTS, {
      body: { content: 'Written before closing' },
    });
  });

  it('keeps a save still in flight at close as a new note when it meets a conflict', async () => {
    let failSave: (error: unknown) => void = () => {};
    mockPatch.mockImplementationOnce(() => new Promise((_, reject) => (failSave = reject)));
    mockPost.mockResolvedValueOnce({ id: 'thought_2', rev: 0, content: 'Mid-save text' });
    const { unmount } = render(<NoteTab tabId="t1" id="thought_1" />);

    type('Mid-save text');
    await flushSave();
    unmount();
    await act(async () => {
      failSave(conflictError(4, 'Their version'));
      await vi.runAllTimersAsync();
    });

    expect(mockPost).toHaveBeenCalledWith(RESPARKABLE_API.THOUGHTS, {
      body: { content: 'Mid-save text' },
    });
  });

  it('saves to the workspace the editor opened in, even after the address bar moves on', async () => {
    window.history.replaceState(null, '', '/resparkable?space=space_a');
    mockPatch.mockResolvedValueOnce({ id: 'thought_1', rev: 4, content: 'Written in A' });
    const { unmount } = render(<NoteTab tabId="t1" id="thought_1" />);

    type('Written in A');
    window.history.replaceState(null, '', '/resparkable?space=space_b');
    unmount();
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    window.history.replaceState(null, '', '/');

    expect(mockPatch).toHaveBeenCalledWith(`${NOTE_PATH}?space=space_a`, {
      body: { content: 'Written in A', rev: 3 },
    });
  });

  it('shows a loading state and no editor while the note loads', () => {
    vi.mocked(useTabFetch).mockReturnValue([{ status: 'loading' }, vi.fn()]);
    render(<NoteTab tabId="t1" id="thought_1" />);

    expect(screen.getByRole('status')).toHaveTextContent('Loading note');
    expect(screen.queryByLabelText('Note body')).not.toBeInTheDocument();
  });

  it('shows the load error with a retry, and no editor', () => {
    const retry = vi.fn();
    vi.mocked(useTabFetch).mockReturnValue([
      { status: 'error', message: 'Could not reach the server.', httpStatus: null },
      retry,
    ]);
    render(<NoteTab tabId="t1" id="thought_1" />);

    expect(screen.getByRole('alert')).toHaveTextContent('Could not reach the server.');
    expect(screen.queryByLabelText('Note body')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
