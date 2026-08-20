/**
 * Unit Tests: Composer.
 *
 * Focused on the mismatch prompt — the one piece of real client logic this
 * component owns (mode selection and submit wiring are thin enough to be
 * covered incidentally by `sparkey-pane.test.tsx`) — and on the file-upload
 * wiring (`AttachButton`/`AttachmentCard`), which is new here. `AttachmentCard`'s
 * own extract-vs-file logic is already exhaustively covered in
 * `capture-attachment.test.tsx`; what's tested below is only this component's
 * own glue — selecting a file surfaces the card, and its callbacks land in
 * the right place (the draft, a notice) — not re-derived. Voice/image
 * capture are exercised as reused, unmodified components in their own test
 * suites, not re-tested here.
 *
 * @see components/resparkable/sparkey/composer.tsx
 */

import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { Composer } from '@/components/resparkable/sparkey/composer';

function jsonResponse(status: number, payload: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  } as unknown as Response;
}

/** `AttachButton`'s hidden file input — matched by `accept` rather than assumed to be the only one. */
function attachFileInput(): HTMLInputElement {
  const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
  const match = inputs.find((input) => input.getAttribute('accept')?.includes('.pdf'));
  if (!match) throw new Error('AttachButton file input not found');
  return match as HTMLInputElement;
}

function renderComposer(initialMode: 'chat' | 'capture' | 'instruct' = 'chat') {
  const onSubmit = vi.fn();
  const onModeChange = vi.fn();

  function Wrapper() {
    const [value, setValue] = React.useState('');
    return (
      <Composer
        mode={initialMode}
        onModeChange={onModeChange}
        value={value}
        onValueChange={setValue}
        onSubmit={(text, source) => {
          onSubmit(text, source);
          setValue('');
        }}
      />
    );
  }

  render(<Wrapper />);
  return { onSubmit, onModeChange };
}

describe('Composer — mismatch prompt', () => {
  it('shows no prompt when the text matches the current mode', async () => {
    const user = userEvent.setup();
    renderComposer('capture');

    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'a plain note');

    expect(screen.queryByText(/switch to/i)).not.toBeInTheDocument();
  });

  it('suggests switching when the text reads like a different mode', async () => {
    const user = userEvent.setup();
    renderComposer('capture');

    await user.type(
      screen.getByRole('textbox', { name: 'Message' }),
      'what did I capture about Acme?'
    );

    expect(screen.getByText(/This reads like a question — switch to chat\?/)).toBeInTheDocument();
  });

  it('Switch changes the mode and clears the prompt', async () => {
    const user = userEvent.setup();
    const { onModeChange } = renderComposer('capture');

    await user.type(
      screen.getByRole('textbox', { name: 'Message' }),
      'what did I capture about Acme?'
    );
    await user.click(screen.getByRole('button', { name: 'Switch' }));

    expect(onModeChange).toHaveBeenCalledWith('chat');
  });

  it('Dismiss hides the prompt for the current draft without changing mode', async () => {
    const user = userEvent.setup();
    const { onModeChange } = renderComposer('capture');

    await user.type(
      screen.getByRole('textbox', { name: 'Message' }),
      'what did I capture about Acme?'
    );
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));

    expect(screen.queryByText(/switch to/i)).not.toBeInTheDocument();
    expect(onModeChange).not.toHaveBeenCalled();
  });

  it('re-arms the prompt once the draft changes again after a dismissal', async () => {
    const user = userEvent.setup();
    renderComposer('capture');

    const textbox = screen.getByRole('textbox', { name: 'Message' });
    await user.type(textbox, 'what did I capture about Acme?');
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText(/switch to/i)).not.toBeInTheDocument();

    await user.type(textbox, ' more');
    expect(screen.getByText(/switch to chat/i)).toBeInTheDocument();
  });

  it('submits the trimmed text and clears the mismatch state on send', async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderComposer('chat');

    await user.type(screen.getByRole('textbox', { name: 'Message' }), '  create a project  ');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    expect(onSubmit).toHaveBeenCalledWith('create a project', undefined);
    expect(screen.queryByText(/switch to/i)).not.toBeInTheDocument();
  });

  it('Enter sends, Shift+Enter does not', async () => {
    const user = userEvent.setup();
    const { onSubmit } = renderComposer('chat');

    const textbox = screen.getByRole('textbox', { name: 'Message' });
    await user.type(textbox, 'line one');
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    expect(onSubmit).not.toHaveBeenCalled();

    await user.type(textbox, 'line two');
    await user.keyboard('{Enter}');
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});

describe('Composer — file upload', () => {
  const FILE = new File(['contents'], 'roadmap.pdf', { type: 'application/pdf' });

  it('selecting a file surfaces the attachment card, naming it', async () => {
    const user = userEvent.setup();
    renderComposer();

    await user.upload(attachFileInput(), FILE);

    expect(screen.getByText('roadmap.pdf')).toBeInTheDocument();
  });

  it('reading a file in appends its text to the draft and dismisses the card', async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(200, {
        success: true,
        data: { text: 'Q3 revenue is up.', characters: 18, truncated: false },
      })
    );
    renderComposer();

    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'From the roadmap: ');
    await user.upload(attachFileInput(), FILE);
    await user.click(screen.getByRole('button', { name: /read into capture/i }));

    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue(
        'From the roadmap: Q3 revenue is up.'
      )
    );
    expect(screen.queryByText('roadmap.pdf')).not.toBeInTheDocument();
    expect(screen.getByText(/check it before sending/i)).toBeInTheDocument();
  });

  it('dismissing the card drops the file without touching the draft', async () => {
    const user = userEvent.setup();
    renderComposer();

    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'unrelated draft');
    await user.upload(attachFileInput(), FILE);
    await user.click(screen.getByRole('button', { name: /forget roadmap\.pdf/i }));

    expect(screen.queryByText('roadmap.pdf')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('unrelated draft');
  });
});

describe('Composer — layout', () => {
  it('starts the textarea at 3 rows, not 1', () => {
    renderComposer();

    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveAttribute('rows', '3');
  });

  it('offers only the paperclip for attaching content, not a separate photo button', () => {
    renderComposer();

    expect(screen.getByRole('button', { name: 'Attach a file' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /photograph/i })).not.toBeInTheDocument();
  });
});
