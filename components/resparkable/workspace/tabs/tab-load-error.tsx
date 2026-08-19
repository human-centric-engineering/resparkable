'use client';

/**
 * TabLoadError — `LoadError`'s look, with a retry that actually works inside
 * a tab.
 *
 * `LoadError` (`components/resparkable/ui/load-error.tsx`) retries via
 * `router.refresh()`, which re-runs the server component that did the
 * failing fetch — there is no server component here, so that retry would
 * silently do nothing. Same markup, but `onRetry` comes from the caller's
 * `useTabFetch` instead.
 */

import * as React from 'react';
import { AlertTriangle, RotateCw } from 'lucide-react';

import { Button } from '@/components/ui/button';

export interface TabLoadErrorProps {
  /** What failed, in the user's terms — "your tasks", "this project". */
  what: string;
  message: string;
  onRetry: () => void;
}

export function TabLoadError({ what, message, onRetry }: TabLoadErrorProps): React.ReactElement {
  return (
    <div
      role="alert"
      className="m-4 flex flex-col items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200"
    >
      <p className="flex items-center gap-2 font-medium">
        <AlertTriangle className="h-4 w-4" aria-hidden="true" />
        Couldn&rsquo;t load {what}.
      </p>
      <p>{message}</p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        <RotateCw className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
        Try again
      </Button>
    </div>
  );
}
