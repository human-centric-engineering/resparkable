/**
 * Unit Tests: TabLoadError.
 *
 * The one thing worth pinning down: `onRetry` is a plain callback, not
 * `router.refresh()` — every `*-tab.tsx` adapter's error branch depends on
 * that call actually reaching `useTabFetch`'s `retry()`, and nothing else
 * in the suite exercises this component's own error/retry path directly
 * (each adapter's error branch is currently covered only indirectly).
 *
 * @see components/resparkable/workspace/tabs/tab-load-error.tsx
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { TabLoadError } from '@/components/resparkable/workspace/tabs/tab-load-error';

describe('TabLoadError', () => {
  it('names what failed and shows the message', () => {
    render(<TabLoadError what="your projects" message="The server is unwell." onRetry={vi.fn()} />);

    expect(screen.getByRole('alert')).toHaveTextContent('Couldn’t load your projects.');
    expect(screen.getByText('The server is unwell.')).toBeInTheDocument();
  });

  it('calls onRetry when Try again is clicked', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(<TabLoadError what="this project" message="Not found." onRetry={onRetry} />);

    await user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
