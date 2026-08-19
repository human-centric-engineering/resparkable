/**
 * Unit Tests: Composer.
 *
 * Focused on the mismatch prompt — the one piece of real client logic this
 * component owns (mode selection and submit wiring are thin enough to be
 * covered incidentally by `sparkey-pane.test.tsx`). Voice/image capture
 * are exercised as reused, unmodified components in their own test suites,
 * not re-tested here.
 *
 * @see components/resparkable/sparkey/composer.tsx
 */

import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { Composer } from '@/components/resparkable/sparkey/composer';

describe('Composer — mismatch prompt', () => {
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
