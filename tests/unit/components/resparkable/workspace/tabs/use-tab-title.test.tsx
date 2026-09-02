// @vitest-environment happy-dom

/**
 * Unit Tests: useTabTitle and titleFromNoteBody.
 *
 * Why this is worth its own file: `TabState.title` existed unwritten for the
 * whole of the shell's first release, so three Project tabs open side by side
 * were three tabs all labelled "Project". The two things that make the fix
 * safe rather than merely present are asserted here — that a still-loading
 * fetch writes nothing (so a tab never flashes a blank name), and that the
 * write settles rather than looping, since the hook fires on every render of
 * a loaded detail tab.
 *
 * The write is debounced, so the cases that expect one assert through
 * `waitFor`. That is not test ceremony around an implementation detail: the
 * write serializes the entire workspace tree to localStorage and re-renders
 * every pane, and `NoteTab` passes a value that changes on every keystroke.
 * The last test pins the coalescing directly.
 *
 * @see components/resparkable/workspace/tabs/use-tab-title.ts
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

import {
  titleFromNoteBody,
  useTabTitle,
} from '@/components/resparkable/workspace/tabs/use-tab-title';
import { useWorkspace } from '@/components/resparkable/workspace/workspace-context';

vi.mock('@/components/resparkable/workspace/workspace-context', () => ({
  useWorkspace: vi.fn(),
}));

const setTabTitle = vi.fn();

beforeEach(() => {
  setTabTitle.mockReset();
  vi.mocked(useWorkspace).mockReturnValue({ setTabTitle } as unknown as ReturnType<
    typeof useWorkspace
  >);
});

describe('useTabTitle', () => {
  it('writes the title against the tab id it was given', async () => {
    renderHook(() => useTabTitle('tab_7', 'Q3 Roadmap'));

    await waitFor(() => expect(setTabTitle).toHaveBeenCalledWith('tab_7', 'Q3 Roadmap'));
  });

  it('writes nothing while the fetch is still in flight', () => {
    renderHook(() => useTabTitle('tab_7', null));

    expect(setTabTitle).not.toHaveBeenCalled();
  });

  it('treats a whitespace-only name as no name, rather than blanking the tab', () => {
    renderHook(() => useTabTitle('tab_7', '   '));

    expect(setTabTitle).not.toHaveBeenCalled();
  });

  it('trims surrounding whitespace off the name it writes', async () => {
    renderHook(() => useTabTitle('tab_7', '  Q3 Roadmap  '));

    await waitFor(() => expect(setTabTitle).toHaveBeenCalledWith('tab_7', 'Q3 Roadmap'));
  });

  it('writes once and stays quiet on a re-render with the same title', async () => {
    const { rerender } = renderHook(({ title }) => useTabTitle('tab_7', title), {
      initialProps: { title: 'Q3 Roadmap' },
    });

    rerender({ title: 'Q3 Roadmap' });

    await waitFor(() => expect(setTabTitle).toHaveBeenCalledTimes(1));
  });

  it('writes again when the content is renamed under it', async () => {
    const { rerender } = renderHook(({ title }) => useTabTitle('tab_7', title), {
      initialProps: { title: 'Q3 Roadmap' },
    });

    rerender({ title: 'Q4 Roadmap' });

    await waitFor(() => expect(setTabTitle).toHaveBeenLastCalledWith('tab_7', 'Q4 Roadmap'));
  });

  it('coalesces a burst of typing into one write', async () => {
    // The reason the debounce exists. `NoteTab` passes the live editor value,
    // so without this every keystroke in a note's first line serialized the
    // whole workspace tree and re-rendered every pane in the shell.
    const { rerender } = renderHook(({ title }) => useTabTitle('tab_7', title), {
      initialProps: { title: 'K' },
    });
    for (const title of ['Ki', 'Kic', 'Kick', 'Kicko', 'Kickoff']) rerender({ title });

    await waitFor(() => expect(setTabTitle).toHaveBeenCalledTimes(1));
    // The trailing edge wins, so the settled title is the exact final value.
    expect(setTabTitle).toHaveBeenCalledWith('tab_7', 'Kickoff');
  });

  it('caps a very long name so one tab cannot take the whole strip', async () => {
    renderHook(() => useTabTitle('tab_7', 'x'.repeat(200)));

    await waitFor(() => expect(setTabTitle).toHaveBeenCalledTimes(1));
    const [, written] = setTabTitle.mock.calls[0];
    expect(written).toHaveLength(60);
  });
});

describe('titleFromNoteBody', () => {
  it('uses the first non-empty line', () => {
    expect(titleFromNoteBody('\n\n  Kickoff notes\nmore text')).toBe('Kickoff notes');
  });

  it('strips a Markdown heading marker, so "# Kickoff" titles as "Kickoff"', () => {
    expect(titleFromNoteBody('# Kickoff notes\n\nbody')).toBe('Kickoff notes');
  });

  it('strips deeper heading levels too', () => {
    expect(titleFromNoteBody('### Deep heading')).toBe('Deep heading');
  });

  it('returns null for an empty note, which keeps the generic "Note" default', () => {
    expect(titleFromNoteBody('')).toBeNull();
    expect(titleFromNoteBody('\n   \n')).toBeNull();
  });

  it('does not mistake a hash inside a word for a heading', () => {
    expect(titleFromNoteBody('C#5 chord voicings')).toBe('C#5 chord voicings');
  });
});
