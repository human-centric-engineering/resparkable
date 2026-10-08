/**
 * edit-conflict Tests
 *
 * The client's one reading of a phase 58 `rev` conflict: a 409 `APIClientError`
 * whose `details.current` holds the row as it now stands.
 *
 * Test Coverage:
 * - isEditConflict: true only for an APIClientError with status 409
 * - readConflictCurrent: returns the slice the caller's shape asks for,
 *   and null for a non-conflict or a row that does not fit the shape
 *
 * @see lib/framework/resparkable/ui/edit-conflict.ts
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';

import { APIClientError } from '@/lib/api/client';
import { isEditConflict, readConflictCurrent } from '@/lib/framework/resparkable/ui/edit-conflict';

function apiError(status: number, details?: Record<string, unknown>): APIClientError {
  return new APIClientError('Request failed', 'ERROR', status, details);
}

const revShape = z.object({ rev: z.number().int() });

describe('isEditConflict', () => {
  it('is true for a 409 from the API client', () => {
    expect(isEditConflict(apiError(409))).toBe(true);
  });

  it('is false for any other status, and for errors that are not from the API client', () => {
    expect(isEditConflict(apiError(400))).toBe(false);
    expect(isEditConflict(apiError(404))).toBe(false);
    expect(isEditConflict(Object.assign(new Error('x'), { status: 409 }))).toBe(false);
    expect(isEditConflict(null)).toBe(false);
  });
});

describe('readConflictCurrent', () => {
  it("returns the caller's slice of the current row, dropping the rest", () => {
    const error = apiError(409, { current: { id: 'proj_1', rev: 7, name: 'Their retitle' } });

    expect(readConflictCurrent(error, revShape)).toEqual({ rev: 7 });
  });

  it('returns null when the row does not fit the shape', () => {
    const error = apiError(409, { current: { id: 'proj_1', rev: 'seven' } });

    expect(readConflictCurrent(error, revShape)).toBeNull();
  });

  it('returns null for a conflict with no row attached', () => {
    expect(readConflictCurrent(apiError(409), revShape)).toBeNull();
  });

  it('returns null for an error that is not a conflict, even with a row attached', () => {
    const error = apiError(400, { current: { rev: 7 } });

    expect(readConflictCurrent(error, revShape)).toBeNull();
  });
});
