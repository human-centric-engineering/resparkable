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

import { classifyIntent } from '@/lib/framework/resparkable/ui/workspace/classify-intent';

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
