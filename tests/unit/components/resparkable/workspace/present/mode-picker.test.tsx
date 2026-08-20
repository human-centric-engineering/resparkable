/**
 * Unit Tests: ModePicker.
 *
 * A three-way radio group — the contract is that clicking an option reports
 * exactly that option, and the currently active mode is marked checked so
 * assistive tech and CSS state agree with what's on screen.
 *
 * @see components/resparkable/workspace/present/mode-picker.tsx
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ModePicker } from '@/components/resparkable/workspace/present/mode-picker';

describe('ModePicker', () => {
  it('marks the active mode checked', () => {
    render(<ModePicker mode="deck" onChange={vi.fn()} />);

    expect(screen.getByRole('radio', { name: 'Deck' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'Lightweight' })).toHaveAttribute(
      'aria-checked',
      'false'
    );
  });

  it('reports the clicked mode', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ModePicker mode="deck" onChange={onChange} />);

    await user.click(screen.getByRole('radio', { name: 'On the fly' }));

    expect(onChange).toHaveBeenCalledWith('on-the-fly');
  });
});
