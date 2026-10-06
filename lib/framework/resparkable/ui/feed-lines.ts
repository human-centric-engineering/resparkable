/**
 * The group activity feed, as sentences (§23.10, phase 59).
 *
 * **The subject of a line is the item; the person is attribution.** "Chapter 4
 * notes, added by Sam", never "Sam added Chapter 4 notes", because a column of
 * names is what a productivity monitor looks like, and the feed must read as a
 * shared record instead. That is a rendering rule, and this file is where it
 * is kept.
 *
 * A kind or type this file cannot render returns `null`, and the view drops
 * the line: a kind added in a later release costs a missing line rather than
 * a raw internal word in front of thirty people.
 *
 * Pure, so 13m is a test of what is written, without rendering anything.
 */

import type { FeedItemWire } from '@/lib/framework/resparkable/ui/payloads';

/** The item's kind, in words, used when it has no title (deleted since). */
const NOUN: Record<string, string> = {
  task: 'A task',
  project: 'A project',
  goal: 'A goal',
  area: 'An area',
  entity: 'A person or organisation',
  board: 'A board',
  thought: 'A note',
  review: 'A review',
};

/** What happened, in the past tense, as the predicate of a line about the item. */
const VERB: Record<string, string> = {
  captured: 'added',
  created: 'added',
  updated: 'edited',
  completed: 'completed',
  promoted: 'turned into a task',
  archived: 'archived',
  restored: 'restored',
  deleted: 'deleted',
  snoozed: 'snoozed',
  unsnoozed: 'brought back',
  linked: 'linked',
};

export interface FeedLine {
  /** What the line is about: the item's title, or its kind when it is gone. */
  subject: string;
  /** The rest: "added by Sam", "completed by you", "archived by the workspace". */
  predicate: string;
}

function attribution(item: FeedItemWire): string {
  if (item.system) return 'by the workspace';
  if (item.byYou) return 'by you';
  return `by ${item.actorName ?? 'someone'}`;
}

export function feedLine(item: FeedItemWire): FeedLine | null {
  const noun = NOUN[item.entityType];
  const verb = VERB[item.kind];
  if (!noun || !verb) return null;

  return {
    subject: item.title && item.title.trim() !== '' ? item.title : noun,
    predicate: `${verb} ${attribution(item)}`,
  };
}

/** Whether a line arrived after the reader last marked the feed read. Styling only. */
export function isNew(item: FeedItemWire, seenAt: string | null): boolean {
  if (item.byYou) return false;
  return seenAt === null || new Date(item.createdAt).getTime() > new Date(seenAt).getTime();
}
