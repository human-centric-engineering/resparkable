/**
 * Unit Tests: the cascade — what a grant on one item reaches (phase 10).
 *
 * The cascade is the part of sharing most likely to be wrong in a way nobody
 * notices, because both failure directions are quiet. Too narrow, and a shared
 * project is a title and a paragraph — people work around that by pasting task
 * lists into descriptions, which is strictly worse. Too wide, and sharing one
 * thing hands over a subtree its owner never looked at.
 *
 * So the shape is declared as data (`RESPARKABLE_CASCADE`) and asserted here
 * directly, rather than probed one call at a time for absences.
 *
 * Test Coverage:
 * - The declared edges, and the declared non-edges
 * - The two maps are exact inverses of each other
 * - `boardFilterMatches` agrees with `loadFilteredCards`, including the
 *   awkward `done` rule that the board's own columns resolve
 * - `dropped` is never on a board unless asked for
 * - A malformed stored filter fails safe rather than throwing
 *
 * @see lib/framework/resparkable/access/cascade.ts
 * @see lib/framework/resparkable/services/board-view.ts — the other direction
 */

import { describe, expect, it } from 'vitest';

import {
  boardFilterMatches,
  RESPARKABLE_CASCADE,
  RESPARKABLE_CASCADE_PARENTS,
} from '@/lib/framework/resparkable/access/cascade';
import { RESPARKABLE_SHAREABLE_TYPES } from '@/lib/framework/resparkable/access/types';

describe('the declared cascade', () => {
  it('is exactly these edges and no others', () => {
    // Stated whole rather than asserted edge by edge: a new edge added without
    // a decision shows up here as a diff to a literal, which is a thing a
    // reviewer reads, rather than as a passing test nobody wrote.
    expect(RESPARKABLE_CASCADE).toEqual({
      project: ['task'],
      goal: ['goal'],
      board: ['task'],
      area: [],
      review: [],
      task: [],
    });
  });

  it('cascades from an area to nothing', () => {
    // An area is a life domain. Sharing "Health" must not hand over every
    // project, task and review anyone ever filed under it.
    expect(RESPARKABLE_CASCADE.area).toEqual([]);
  });

  it('has no goal → project edge, matching the schema rather than the prose', () => {
    // §13 describes the goal cascade as reaching "child goals and projects".
    // The schema has no such edge — a project hangs off an `areaId`, and its
    // relationship to a goal is a user-authored `ResparkableLink`. Following
    // links would make the cascade transitive AND user-editable, which is
    // precisely what "one level and typed" forbids. Asserted so the deviation
    // stays a decision.
    expect(RESPARKABLE_CASCADE.goal).not.toContain('project');
  });

  it('is the exact inverse of the parent map', () => {
    // Two maps describing one relation is two chances to be wrong. This is the
    // assertion that keeps them one relation.
    for (const parent of RESPARKABLE_SHAREABLE_TYPES) {
      for (const child of RESPARKABLE_CASCADE[parent]) {
        expect(RESPARKABLE_CASCADE_PARENTS[child]).toContain(parent);
      }
    }
    for (const child of RESPARKABLE_SHAREABLE_TYPES) {
      for (const parent of RESPARKABLE_CASCADE_PARENTS[child]) {
        expect(RESPARKABLE_CASCADE[parent]).toContain(child);
      }
    }
  });

  it('covers every shareable type in both directions', () => {
    // A type missing from either map would silently cascade to nothing, or be
    // reachable from nothing, with no error anywhere.
    for (const type of RESPARKABLE_SHAREABLE_TYPES) {
      expect(RESPARKABLE_CASCADE).toHaveProperty(type);
      expect(RESPARKABLE_CASCADE_PARENTS).toHaveProperty(type);
    }
  });
});

describe('boardFilterMatches', () => {
  const columns = (...statuses: string[]) => statuses.map((status) => ({ status, label: status }));

  // `boardFilterSchema` validates `projectId` as a cuid, so a short fixture id
  // would fail parsing and fall back to "no filter" — which would make the
  // exclusion tests below pass for entirely the wrong reason.
  const PROJECT_A = 'clh0000000000000000000001';
  const PROJECT_B = 'clh0000000000000000000002';

  it('matches any task when the filter names no project', () => {
    const board = { id: 'b', filter: {}, columns: columns('todo') };
    expect(boardFilterMatches(board, { projectId: PROJECT_A, status: 'todo' })).toBe(true);
    expect(boardFilterMatches(board, { projectId: null, status: 'todo' })).toBe(true);
  });

  it('excludes a task from another project when the filter names one', () => {
    const board = { id: 'b', filter: { projectId: PROJECT_A }, columns: columns('todo') };
    expect(boardFilterMatches(board, { projectId: PROJECT_B, status: 'todo' })).toBe(false);
    expect(boardFilterMatches(board, { projectId: null, status: 'todo' })).toBe(false);
    expect(boardFilterMatches(board, { projectId: PROJECT_A, status: 'todo' })).toBe(true);
  });

  it('never shows dropped work unless the filter asks for it', () => {
    // Abandoned work is not finished work, and no default column shows it.
    const board = { id: 'b', filter: {}, columns: columns('todo', 'done') };
    expect(boardFilterMatches(board, { projectId: null, status: 'dropped' })).toBe(false);

    const asked = { id: 'b', filter: { includeDone: true }, columns: columns('todo') };
    expect(boardFilterMatches(asked, { projectId: null, status: 'dropped' })).toBe(true);
  });

  it('lets the board’s own columns decide the done case', () => {
    // The awkward one. A board WITH a Done column has asked for finished work
    // by saying where to put it; a board without one would only ever pile it
    // into `unplaced`. Getting this wrong in the access layer while
    // `loadFilteredCards` gets it right is a one-directional leak: resolution
    // grants a card the board never displayed.
    const withDone = { id: 'b', filter: {}, columns: columns('todo', 'done') };
    const withoutDone = { id: 'b', filter: {}, columns: columns('todo', 'doing') };

    expect(boardFilterMatches(withDone, { projectId: null, status: 'done' })).toBe(true);
    expect(boardFilterMatches(withoutDone, { projectId: null, status: 'done' })).toBe(false);
  });

  it('denies on a malformed stored filter rather than throwing OR failing open', () => {
    // The column is `Json?`, so a row written by an older version — or by hand
    // — can hold anything. Three behaviours are available and only one is
    // right: throwing takes the page down; falling back to an empty filter (as
    // `loadFilteredCards` does when RENDERING) would widen a shared board to
    // the owner's whole task list. Denying makes the mismatch run in the safe
    // direction — the grantee sees fewer cards than the owner, never more.
    const board = { id: 'b', filter: { nonsense: true }, columns: columns('todo') };
    expect(boardFilterMatches(board, { projectId: PROJECT_A, status: 'todo' })).toBe(false);
  });

  it('denies a done task when the columns are unreadable', () => {
    // No readable Done column is no evidence the board asked for finished work.
    const board = { id: 'b', filter: {}, columns: 'not an array' };
    expect(boardFilterMatches(board, { projectId: PROJECT_A, status: 'done' })).toBe(false);
    // A live task is unaffected: the columns only decide the `done` case.
    expect(boardFilterMatches(board, { projectId: PROJECT_A, status: 'todo' })).toBe(true);
  });

  it('treats a null filter as matching everything live', () => {
    const board = { id: 'b', filter: null, columns: columns('todo') };
    expect(boardFilterMatches(board, { projectId: PROJECT_A, status: 'next' })).toBe(true);
  });
});
