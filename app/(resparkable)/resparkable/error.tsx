'use client';

/**
 * Resparkable Shell Error Boundary
 *
 * Catches errors that occur within the Resparkable workspace. Every page here
 * already handles its own expected fetch failures inline via `LoadError`/
 * `TabLoadError` (`readResparkable()` returns `{ ok: false }` rather than
 * throwing), so this boundary only ever fires on a genuinely unexpected
 * exception. `/resparkable` sits outside `(protected)` but is still
 * auth-gated by `proxy.ts` on the literal pathname (see the layout above),
 * so a dropped session is checked here the same way it is for `(protected)`.
 *
 * @see https://nextjs.org/docs/app/api-reference/file-conventions/error
 */

import { Home } from 'lucide-react';
import { RouteErrorBoundary } from '@/components/errors/route-error-boundary';

export default function ResparkableError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): React.ReactElement {
  return (
    <RouteErrorBoundary
      error={error}
      reset={reset}
      boundaryName="ResparkableError"
      tag="resparkable"
      title="Something went wrong"
      description="An error occurred while loading your workspace. This has been logged."
      checkSession
      fallback={{
        label: 'Back to Today',
        href: '/resparkable',
        navigate: 'reload',
        icon: <Home className="mr-2 h-4 w-4" />,
      }}
    />
  );
}
