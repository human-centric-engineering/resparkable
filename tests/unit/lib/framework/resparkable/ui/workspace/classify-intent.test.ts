/**
 * Unit Tests: Sparkey's mode-mismatch classifier.
 *
 * Table-driven, one case per rule in the header comment's priority order —
 * `classifyIntent` has no I/O and no randomness, so each case is just a
 * string in and an `IntentKind` out.
 *
 * @see lib/framework/resparkable/ui/workspace/classify-intent.ts
 */

import { describe, expect, it } from 'vitest';

import {
  classifyIntent,
  isBoardInstruction,
} from '@/lib/framework/resparkable/ui/workspace/classify-intent';

describe('classifyIntent — chat', () => {
  it.each([
    'What did I capture about the Q3 launch?',
    'is this project still active',
    'Can you summarise my week',
    "Who's on the Acme account",
    'How does area balance affect scoring',
  ])('reads %j as chat', (text) => {
    expect(classifyIntent(text)).toBe('chat');
  });

  it('treats a trailing "?" as chat even without a question-leading word', () => {
    expect(classifyIntent('the Acme deal, still on track?')).toBe('chat');
  });
});

describe('classifyIntent — instruct', () => {
  it.each([
    'Create a project for the Q3 launch',
    'move this to Doing',
    'Mark the onboarding task complete',
    'archive the Acme project',
    'set the due date to Friday',
  ])('reads %j as instruct', (text) => {
    expect(classifyIntent(text)).toBe('instruct');
  });
});

describe('classifyIntent — capture (the safe default)', () => {
  it.each([
    'Acme wants to renew for another year',
    'idea: a weekly digest email',
    'the launch slipped to next month',
    '',
    '   ',
  ])('reads %j as capture', (text) => {
    expect(classifyIntent(text)).toBe('capture');
  });
});

describe('classifyIntent — rule ordering', () => {
  it('a trailing "?" wins even when the leading word is imperative', () => {
    // "Move" is an imperative leader, but the trailing "?" makes this a
    // question about a move, not an instruction to make one.
    expect(classifyIntent('Move the meeting, did I already do that?')).toBe('chat');
  });

  it("an apostrophe doesn't break the leading-word check", () => {
    expect(classifyIntent("Can't remember if I archived this")).toBe('chat');
  });
});

describe('isBoardInstruction', () => {
  it.each([
    'move this to Doing',
    'Move the Acme task to Done',
    'drag this to the backlog',
    'put this on the board',
    'move it to the board',
    'put this in the Done column',
  ])('reads %j as a board instruction', (text) => {
    expect(isBoardInstruction(text)).toBe(true);
  });

  it.each([
    '',
    '   ',
    'Create a project for the Q3 launch',
    'archive the Acme project',
    'close the Q3 board', // mentions "board" but isn't a move
    'What column is this task in?', // mentions "column" but isn't a move
  ])('does not read %j as a board instruction', (text) => {
    expect(isBoardInstruction(text)).toBe(false);
  });
});
