// @vitest-environment happy-dom

/**
 * Unit Tests: `CreateModeToggle` and `useCreateMode`.
 *
 * Test Coverage:
 * - Renders both options, marking the current mode via `aria-checked`
 * - Clicking the other option calls `onChange` with it
 * - `useCreateMode` defaults to 'chat' with nothing stored
 * - `useCreateMode` reads a previously stored preference
 *
 * @see components/resparkable/creation/create-mode-toggle.tsx
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, renderHook, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  CreateModeToggle,
  useCreateMode,
} from '@/components/resparkable/creation/create-mode-toggle';

beforeEach(() => {
  localStorage.clear();
});

describe('CreateModeToggle', () => {
  it('marks the current mode checked and the other one not', () => {
    render(<CreateModeToggle mode="chat" onChange={() => {}} />);

    expect(screen.getByRole('radio', { name: 'chat' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'form' })).toHaveAttribute('aria-checked', 'false');
  });

  it('calls onChange with the clicked option', async () => {
    const user = userEvent.setup();
    let mode: string | null = null;
    render(<CreateModeToggle mode="chat" onChange={(next) => (mode = next)} />);

    await user.click(screen.getByRole('radio', { name: 'form' }));

    expect(mode).toBe('form');
  });
});

describe('useCreateMode', () => {
  it('defaults to chat with nothing stored', () => {
    const { result } = renderHook(() => useCreateMode());

    expect(result.current[0]).toBe('chat');
  });

  it('picks up a previously stored preference after mount', async () => {
    localStorage.setItem('resparkable.create-mode.v1', JSON.stringify('form'));

    const { result } = renderHook(() => useCreateMode());

    await waitFor(() => expect(result.current[0]).toBe('form'));
  });
});
