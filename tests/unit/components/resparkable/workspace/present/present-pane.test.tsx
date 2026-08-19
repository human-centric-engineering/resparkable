/**
 * Unit Tests: PresentPane.
 *
 * `VoiceCaptureButton`'s own recording/transcription state machine is
 * pinned down in its own test file — mocked here to a plain
 * transcript/error trigger so this file covers only what `PresentPane`
 * itself does with those callbacks: append a slide, jump to it, and clear
 * a prior error. `buildSlidesFromSelection()`'s own logic (ordering,
 * connectors) is covered in `build-slides.test.ts`; this file only checks
 * that `PresentPane` calls it with the right selection.
 *
 * @see components/resparkable/workspace/present/present-pane.tsx
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { PresentPane } from '@/components/resparkable/workspace/present/present-pane';
import type { GraphPayloadWire } from '@/lib/framework/resparkable/ui/payloads';

vi.mock('@/components/resparkable/layout/voice-capture-button', () => ({
  VoiceCaptureButton: ({
    onTranscript,
    onError,
  }: {
    onTranscript: (text: string) => void;
    onError: (message: string) => void;
  }) => (
    <div>
      <button onClick={() => onTranscript('talking through the Q4 roadmap')}>
        Simulate dictation
      </button>
      <button onClick={() => onError('Microphone access was blocked.')}>Simulate mic error</button>
    </div>
  ),
}));

function payload(): GraphPayloadWire {
  return {
    focus: { type: 'project', id: 'proj_1' },
    nodes: [
      { type: 'project', id: 'proj_1', title: 'Q4 launch', subtitle: 'The big push', depth: 0 },
      { type: 'thought', id: 'th_1', title: 'A note', subtitle: null, depth: 1 },
    ],
    edges: [],
    truncated: false,
    nodeCap: 150,
    depth: 2,
  };
}

describe('PresentPane — mode switching', () => {
  it('defaults to Deck mode', () => {
    render(<PresentPane payload={payload()} />);
    expect(screen.getByRole('radio', { name: 'Deck' })).toHaveAttribute('aria-checked', 'true');
  });

  it('shows a nudge for Lightweight mode, with no deck controls', async () => {
    const user = userEvent.setup();
    render(<PresentPane payload={payload()} />);

    await user.click(screen.getByRole('radio', { name: 'Lightweight' }));

    expect(screen.getByText('Nothing to build')).toBeInTheDocument();
    expect(screen.queryByText('Q4 launch')).not.toBeInTheDocument();
  });

  it('shows a nudge for Deck mode when no Graph tab is open', () => {
    render(<PresentPane payload={null} />);
    expect(screen.getByText('Nothing to build from yet')).toBeInTheDocument();
  });
});

describe('PresentPane — Deck mode', () => {
  it('builds a deck from the checked nodes and shows the first slide', async () => {
    const user = userEvent.setup();
    render(<PresentPane payload={payload()} />);

    await user.click(screen.getByLabelText(/Q4 launch/));
    await user.click(screen.getByRole('button', { name: 'Build deck (1)' }));

    const slide = within(screen.getByRole('region', { name: 'Current slide' }));
    expect(slide.getByText('1 of 1')).toBeInTheDocument();
    expect(slide.getByText('The big push')).toBeInTheDocument();
  });

  it('clears the deck when switching modes away and back', async () => {
    const user = userEvent.setup();
    render(<PresentPane payload={payload()} />);

    await user.click(screen.getByLabelText(/Q4 launch/));
    await user.click(screen.getByRole('button', { name: 'Build deck (1)' }));
    expect(screen.getByText('1 of 1')).toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: 'Lightweight' }));
    await user.click(screen.getByRole('radio', { name: 'Deck' }));

    expect(screen.queryByText('1 of 1')).not.toBeInTheDocument();
  });
});

describe('PresentPane — On-the-fly mode', () => {
  it('appends a dictated slide and jumps to it', async () => {
    const user = userEvent.setup();
    render(<PresentPane payload={payload()} />);

    await user.click(screen.getByRole('radio', { name: 'On the fly' }));
    await user.click(screen.getByText('Simulate dictation'));

    expect(screen.getByText('1 of 1')).toBeInTheDocument();
    expect(screen.getByText('talking through the Q4 roadmap')).toBeInTheDocument();

    await user.click(screen.getByText('Simulate dictation'));
    expect(screen.getByText('2 of 2')).toBeInTheDocument();
  });

  it('shows the mic error and clears it on the next successful dictation', async () => {
    const user = userEvent.setup();
    render(<PresentPane payload={payload()} />);

    await user.click(screen.getByRole('radio', { name: 'On the fly' }));
    await user.click(screen.getByText('Simulate mic error'));
    expect(screen.getByRole('alert')).toHaveTextContent('Microphone access was blocked.');

    await user.click(screen.getByText('Simulate dictation'));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
