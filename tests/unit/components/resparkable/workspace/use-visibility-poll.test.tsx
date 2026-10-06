// @vitest-environment happy-dom

/**
 * Unit Tests: the visibility-gated poll (phase 59, §23.10).
 *
 * Polling is only cheaper than a held connection if a hidden page costs
 * nothing, so the timer has to stop when the page is hidden and catch up at
 * once when it comes back.
 *
 * @see components/resparkable/workspace/use-visibility-poll.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

import { useVisibilityPoll } from '@/components/resparkable/workspace/use-visibility-poll';

function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  vi.useFakeTimers();
  setVisibility('visible');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useVisibilityPoll', () => {
  it('ticks on the interval while the page is visible', () => {
    const tick = vi.fn();
    renderHook(() => useVisibilityPoll(tick, 1000));

    vi.advanceTimersByTime(3000);

    expect(tick).toHaveBeenCalledTimes(3);
  });

  it('stops while the page is hidden', () => {
    const tick = vi.fn();
    renderHook(() => useVisibilityPoll(tick, 1000));

    setVisibility('hidden');
    vi.advanceTimersByTime(5000);

    expect(tick).not.toHaveBeenCalled();
  });

  it('catches up at once on becoming visible again, then keeps ticking', () => {
    const tick = vi.fn();
    renderHook(() => useVisibilityPoll(tick, 1000));
    setVisibility('hidden');
    vi.advanceTimersByTime(5000);

    setVisibility('visible');
    expect(tick).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1000);
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it('does not start while hidden at mount', () => {
    setVisibility('hidden');
    const tick = vi.fn();
    renderHook(() => useVisibilityPoll(tick, 1000));

    vi.advanceTimersByTime(3000);

    expect(tick).not.toHaveBeenCalled();
  });

  it('stops for good on unmount', () => {
    const tick = vi.fn();
    const { unmount } = renderHook(() => useVisibilityPoll(tick, 1000));

    unmount();
    vi.advanceTimersByTime(3000);
    setVisibility('visible');

    expect(tick).not.toHaveBeenCalled();
  });

  it('always calls the latest tick without restarting the timer', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(({ tick }) => useVisibilityPoll(tick, 1000), {
      initialProps: { tick: first },
    });

    vi.advanceTimersByTime(500);
    rerender({ tick: second });
    vi.advanceTimersByTime(500);

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
