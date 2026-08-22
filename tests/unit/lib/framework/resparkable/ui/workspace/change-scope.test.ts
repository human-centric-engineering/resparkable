/**
 * Unit Tests: the change vocabulary.
 *
 * Two things here are worth more than the rest, and both are the kind of thing
 * that fails silently rather than loudly.
 *
 * **The key algebra has to close.** `keysForChange` and `keysForTab` are two
 * halves of one agreement, written in different files and read by different
 * components; nothing but a test makes them agree. The cases below assert the
 * agreement by its consequences rather than by its strings: a list catches a
 * change to any record, a detail catches its own record and not a sibling's,
 * and an id-less change reaches every detail of that type.
 *
 * **The tables have to stay complete.** A new `TabKind` with no scope entry,
 * or a capability slug renamed in the catalogue, both produce a working app
 * that quietly stops refreshing something. The coverage blocks fail instead.
 *
 * @see lib/framework/resparkable/ui/workspace/change-scope.ts
 */

import { describe, expect, it } from 'vitest';

import { RESPARKABLE_CAPABILITY_SLUGS } from '@/lib/framework/resparkable/capabilities/catalogue';
import {
  TAB_CHANGE_SCOPE_KINDS,
  WRITING_CAPABILITY_SLUGS,
  changesForCapabilities,
  keysForChange,
  keysForTab,
} from '@/lib/framework/resparkable/ui/workspace/change-scope';
import {
  TAB_KINDS,
  type TabKind,
  type TabParams,
} from '@/lib/framework/resparkable/ui/workspace/tab-registry';

/** What a boundary actually computes: does this change reach this tab at all. */
function reaches(
  change: Parameters<typeof keysForChange>[0],
  kind: TabKind,
  params: TabParams = {}
): boolean {
  const subscribed = new Set(keysForTab(kind, params));
  return keysForChange(change).some((key) => subscribed.has(key));
}

describe('coverage', () => {
  it('scopes every tab kind, so a new kind cannot arrive unsubscribed', () => {
    expect([...TAB_CHANGE_SCOPE_KINDS].sort()).toEqual([...TAB_KINDS].sort());
  });

  it('names only capability slugs that exist, so a rename in the catalogue fails here', () => {
    const known = new Set<string>(Object.values(RESPARKABLE_CAPABILITY_SLUGS));
    for (const slug of WRITING_CAPABILITY_SLUGS) {
      expect(known, `${slug} is not a real capability slug`).toContain(slug);
    }
  });
});

describe('lists', () => {
  it('catch a change to any record of the type they list', () => {
    expect(reaches({ type: 'thought', id: 'anything' }, 'inbox')).toBe(true);
    expect(reaches({ type: 'project', id: 'p9' }, 'projects')).toBe(true);
    expect(reaches({ type: 'goal' }, 'goals')).toBe(true);
  });

  it('ignore a type they do not show', () => {
    expect(reaches({ type: 'document' }, 'inbox')).toBe(false);
    expect(reaches({ type: 'board' }, 'goals')).toBe(false);
  });

  it('leave Search and Vault alone, which have nothing a change invalidates', () => {
    expect(reaches({ type: 'thought' }, 'search')).toBe(false);
    expect(reaches({ type: 'document' }, 'vault')).toBe(false);
  });
});

describe('detail tabs', () => {
  it('catch a change to their own record', () => {
    expect(reaches({ type: 'project', id: 'p1' }, 'project', { id: 'p1' })).toBe(true);
    expect(reaches({ type: 'entity', id: 'e1' }, 'entity', { id: 'e1' })).toBe(true);
    expect(reaches({ type: 'thought', id: 't1' }, 'note', { id: 't1' })).toBe(true);
  });

  it('ignore a change to a sibling record, which is the whole point of carrying an id', () => {
    expect(reaches({ type: 'project', id: 'p2' }, 'project', { id: 'p1' })).toBe(false);
    expect(reaches({ type: 'thought', id: 't2' }, 'note', { id: 't1' })).toBe(false);
  });

  it('catch an id-less change, since the writer could not say it was not theirs', () => {
    expect(reaches({ type: 'project' }, 'project', { id: 'p1' })).toBe(true);
    expect(reaches({ type: 'thought' }, 'note', { id: 't1' })).toBe(true);
  });

  it('still catch the collections they render alongside their own record', () => {
    // A project detail shows its task list, so a task written anywhere is a
    // task list that may have changed.
    expect(reaches({ type: 'task', id: 'x' }, 'project', { id: 'p1' })).toBe(true);
  });
});

describe('changesForCapabilities', () => {
  it('maps a write capability to what it wrote', () => {
    expect(changesForCapabilities([RESPARKABLE_CAPABILITY_SLUGS.upsertGoal])).toEqual([
      { type: 'goal' },
    ]);
  });

  it('reports nothing for a turn that only read', () => {
    expect(
      changesForCapabilities([
        RESPARKABLE_CAPABILITY_SLUGS.search,
        RESPARKABLE_CAPABILITY_SLUGS.getSnapshot,
      ])
    ).toEqual([]);
  });

  it('reports nothing for a turn that called no tool at all', () => {
    expect(changesForCapabilities([])).toEqual([]);
  });

  it('dedupes, so a turn that upserted three tasks announces tasks once', () => {
    const slug = RESPARKABLE_CAPABILITY_SLUGS.upsertTask;
    expect(changesForCapabilities([slug, slug, slug])).toEqual([{ type: 'task' }]);
  });

  it('reports every type a multi-effect capability touches', () => {
    const changes = changesForCapabilities([RESPARKABLE_CAPABILITY_SLUGS.promoteThought]);
    expect(changes.map((change) => change.type).sort()).toEqual(['project', 'task', 'thought']);
  });

  it('carries no id, because the stream never reports one', () => {
    const changes = changesForCapabilities([RESPARKABLE_CAPABILITY_SLUGS.upsertProject]);
    expect(changes.every((change) => change.id === undefined)).toBe(true);
    // Which is exactly why an open project detail tab must still hear it.
    expect(reaches(changes[0], 'project', { id: 'p1' })).toBe(true);
  });

  it('ignores a slug it has never heard of rather than throwing', () => {
    expect(changesForCapabilities(['some_host_project_capability'])).toEqual([]);
  });
});
