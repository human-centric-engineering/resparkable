'use client';

/**
 * useMediaQuery — SSR-safe `window.matchMedia` state hook.
 *
 * Starts at `initialValue` (default `false`) on both server and client,
 * matching `useVoiceRecording`'s own `supported` flag
 * (`lib/hooks/use-voice-recording.ts`) for the same reason: a lazy
 * initializer reading `window` here would make the client's first render
 * disagree with the server's HTML (no `window` there) and trip a hydration
 * mismatch. The real value lands one tick later, after mount, via the
 * effect below — accepted as a one-frame flash rather than a tree-teardown.
 *
 * `initialValue` exists so a caller whose layout guess is wrong far more
 * often than it's right — e.g. `workspace-shell.tsx` picking a mobile vs.
 * desktop layout for a workspace app where the common case is desktop —
 * can flip which side of that flash it lands on, without changing what
 * every other, direction-agnostic caller (e.g. `prefers-reduced-motion`,
 * where guessing `true` would be its own wrong default) gets by default.
 */

import { useEffect, useState } from 'react';

export function useMediaQuery(query: string, initialValue = false): boolean {
  const [matches, setMatches] = useState(initialValue);

  useEffect(() => {
    const mql = window.matchMedia(query);
    setMatches(mql.matches);

    const onChange = (event: MediaQueryListEvent) => setMatches(event.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}
