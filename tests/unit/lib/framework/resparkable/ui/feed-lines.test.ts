/**
 * Unit Tests: the activity feed as sentences (phase 59, §23.10).
 *
 * The rule under test is a rendering rule: the subject of a line is the item,
 * and the person is attribution. Plus the failure direction for a kind the
 * renderer does not know, which is a missing line rather than a raw word.
 *
 * @see lib/framework/resparkable/ui/feed-lines.ts
 */

import { describe, expect, it } from 'vitest';

import { feedLine, isNew } from '@/lib/framework/resparkable/ui/feed-lines';
import type { FeedItemWire } from '@/lib/framework/resparkable/ui/payloads';

function item(overrides: Partial<FeedItemWire> = {}): FeedItemWire {
  return {
    id: 'evt_1',
    kind: 'created',
    entityType: 'task',
    entityId: 'task_1',
    title: 'Chapter 4 notes',
    actorName: 'Sam',
    byYou: false,
    system: false,
    createdAt: '2026-10-01T10:00:00.000Z',
    ...overrides,
  };
}

describe('feedLine', () => {
  it('makes the item the subject and the person the attribution', () => {
    expect(feedLine(item())).toEqual({ subject: 'Chapter 4 notes', predicate: 'added by Sam' });
  });

  it.each([
    ['captured', 'added'],
    ['created', 'added'],
    ['updated', 'edited'],
    ['completed', 'completed'],
    ['promoted', 'turned into a task'],
    ['archived', 'archived'],
    ['restored', 'restored'],
    ['deleted', 'deleted'],
    ['snoozed', 'snoozed'],
    ['unsnoozed', 'brought back'],
    ['linked', 'linked'],
  ])('words %s as "%s"', (kind, verb) => {
    expect(feedLine(item({ kind }))?.predicate).toBe(`${verb} by Sam`);
  });

  it.each([
    ['task', 'A task'],
    ['project', 'A project'],
    ['goal', 'A goal'],
    ['area', 'An area'],
    ['entity', 'A person or organisation'],
    ['board', 'A board'],
    ['thought', 'A note'],
    ['review', 'A review'],
  ])('names a %s without a title as "%s"', (entityType, noun) => {
    expect(feedLine(item({ entityType, title: null }))?.subject).toBe(noun);
    expect(feedLine(item({ entityType, title: '   ' }))?.subject).toBe(noun);
  });

  it('attributes a background run to the workspace, never to a person', () => {
    expect(feedLine(item({ system: true, actorName: null }))?.predicate).toBe(
      'added by the workspace'
    );
  });

  it('says "you" for the reader’s own lines and "someone" for a nameless account', () => {
    expect(feedLine(item({ byYou: true }))?.predicate).toBe('added by you');
    expect(feedLine(item({ actorName: null }))?.predicate).toBe('added by someone');
  });

  it('renders nothing for a kind or a type it does not know', () => {
    expect(feedLine(item({ kind: 'shared' }))).toBeNull();
    expect(feedLine(item({ entityType: 'timeBlock' }))).toBeNull();
  });
});

describe('isNew', () => {
  it('never marks the reader’s own lines as new', () => {
    expect(isNew(item({ byYou: true }), null)).toBe(false);
  });

  it('marks everything new for a reader who has never opened the feed', () => {
    expect(isNew(item(), null)).toBe(true);
  });

  it('marks a line new only when it arrived after the reader last looked', () => {
    expect(isNew(item(), '2026-09-30T10:00:00.000Z')).toBe(true);
    expect(isNew(item(), '2026-10-02T10:00:00.000Z')).toBe(false);
  });
});
