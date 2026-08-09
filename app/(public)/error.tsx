'use client';

/**
 * Public Routes Error Boundary
 *
 * Catches errors that occur within public routes (landing, about, contact, etc.).
 *
 * @see https://nextjs.org/docs/app/api-reference/file-conventions/error
 */

import { Home } from 'lucide-react';
import { RouteErrorBoundary } from '@/components/errors/route-error-boundary';

export default function PublicError({
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
      boundaryName="PublicError"
      tag="public"
      title="That did not work."
      description="Something broke on our side rather than yours. Try again, or head back to the front page. If it keeps happening, the contact page reaches the people who can fix it."
      fallback={{
        label: 'Go home',
        href: '/',
        navigate: 'reload',
        icon: <Home className="mr-2 h-4 w-4" />,
      }}
    />
  );
}
