'use client';

/**
 * Run `tick` every `intervalMs` while the page is visible, and not at all
 * while it is hidden (§23.10, phase 59).
 *
 * The tier's first poll, written once to be shared. Polling rather than
 * pushing is the feed's decision: a held connection per open laptop costs
 * more than a cheap conditional request every half-minute. And a hidden tab
 * costs nothing, because the timer stops; becoming visible again ticks once
 * straight away, so a person returning to the tab sees what they missed
 * without waiting out an interval.
 */

import * as React from 'react';

export function useVisibilityPoll(tick: () => void, intervalMs: number): void {
  // The latest `tick` without restarting the timer whenever its identity
  // changes, which would reset the interval on every render.
  const latest = React.useRef(tick);
  React.useEffect(() => {
    latest.current = tick;
  }, [tick]);

  React.useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;

    const start = (): void => {
      if (timer === null) timer = setInterval(() => latest.current(), intervalMs);
    };
    const stop = (): void => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') {
        latest.current();
        start();
      } else {
        stop();
      }
    };

    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [intervalMs]);
}
