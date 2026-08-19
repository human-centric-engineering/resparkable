'use client';

/**
 * useMediaQuery — SSR-safe `window.matchMedia` state hook.
 *
 * Starts `false` on both server and client, matching `useVoiceRecording`'s
 * own `supported` flag (`lib/hooks/use-voice-recording.ts`) for the same
 * reason: a lazy initializer reading `window` here would make the client's
 * first render disagree with the server's HTML (no `window` there) and
 * trip a hydration mismatch. The real value lands one tick later, after
 * mount, via the effect below — accepted as a one-frame flash rather than
 * a tree-teardown.
 */

import { useEffect, useState } from 'react';

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia(query);
    setMatches(mql.matches);

    const onChange = (event: MediaQueryListEvent) => setMatches(event.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}
