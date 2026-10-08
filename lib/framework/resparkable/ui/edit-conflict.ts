/**
 * Reading a 409 edit conflict on the client.
 *
 * Phase 58's `rev` check answers a stale write with `ConflictError`: status
 * 409, the row as it now stands in `error.details.current`. Every client that
 * sends a `rev` needs the same two questions answered about a failed save (was
 * it a conflict, and what does the row look like now), so they are answered
 * here once rather than re-derived per caller and left to drift when the shape
 * of `details.current` changes.
 *
 * Each caller passes the slice of the row it needs. The edit dialogs only want
 * the `rev`; the note editor also wants the `content`, to offer it back.
 *
 * @see lib/framework/resparkable/services/resources.ts (`revConflict()`)
 */

import { z } from 'zod';

import { APIClientError } from '@/lib/api/client';

/** Whether a failed request was a `rev` mismatch. */
export function isEditConflict(error: unknown): error is APIClientError {
  return error instanceof APIClientError && error.status === 409;
}

/**
 * The current row a conflict carries, read through `shape` without asserting.
 *
 * `null` when the error is not a conflict, or when it is one whose details do
 * not hold a row of that shape.
 */
export function readConflictCurrent<T>(error: unknown, shape: z.ZodType<T>): T | null {
  if (!isEditConflict(error)) return null;
  const details = z.object({ current: shape }).safeParse(error.details);
  return details.success ? details.data.current : null;
}
