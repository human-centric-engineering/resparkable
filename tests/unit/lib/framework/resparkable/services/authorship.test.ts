/**
 * Unit Tests: event authorship — the thing that makes the demand gate work.
 *
 * ## What was broken
 *
 * The gate skips a background run when nothing has changed in the brain since
 * the last one. It could never answer "nothing changed", because the background
 * runs write events too: all four workflows finish by recording a `review`,
 * nightly triage records every thought it promotes and task it creates, and
 * retention records what it archived. Every run wrote the evidence that
 * authorised the next one — on a brain nobody had touched — and the wake on the
 * same path cleared `dormantSince` for every other kind as well.
 *
 * So the gate was decorative and an idle brain was billed nightly, silently.
 * These tests pin the discriminator that fixes it.
 *
 * ## The two directions are not equally bad
 *
 * A background write wrongly marked `user` costs one extra run. A genuine
 * capture wrongly marked `system` is invisible to the gate and can leave
 * somebody without a briefing on the day they came back. The default outside
 * any wrap is therefore `user`, and one test below pins that specifically.
 *
 * Test Coverage:
 * - Outside a wrap, writes are the person's
 * - Inside a wrap, writes are the system's, across `await` boundaries
 * - The mark does not leak out of the wrap, nor into a sibling call
 * - A throw inside the wrap restores the outer value
 *
 * @see lib/framework/resparkable/services/authorship.ts
 */

import { describe, it, expect } from 'vitest';

import {
  currentEventSource,
  runAsSystemAuthored,
} from '@/lib/framework/resparkable/services/authorship';

describe('currentEventSource', () => {
  it('is the person by default', () => {
    // The safe direction. Being wrong this way costs one extra run; being wrong
    // the other way loses somebody's briefing on the day they came back.
    expect(currentEventSource()).toBe('user');
  });

  it('is the system inside a wrap', async () => {
    await runAsSystemAuthored(async () => {
      expect(currentEventSource()).toBe('system');
    });
  });

  it('survives await boundaries, which is the whole reason for AsyncLocalStorage', async () => {
    // A capability's `run()` is several awaits deep by the time it reaches
    // `recordResparkableEvent`. A plain module variable would be clobbered by
    // any interleaved call; a parameter would have to be threaded through nine
    // services and would be one forgotten argument from reopening the hole.
    await runAsSystemAuthored(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 1));
      await Promise.resolve();
      expect(currentEventSource()).toBe('system');
    });
  });

  it('does not leak out of the wrap', async () => {
    await runAsSystemAuthored(async () => currentEventSource());

    expect(currentEventSource()).toBe('user');
  });

  it('does not leak into a concurrent sibling', async () => {
    // The tick drains several jobs at once and the chat handler serves requests
    // alongside them. A leak here would mark a person's capture as system —
    // the failure direction that loses a briefing.
    let sibling = 'unset';

    await Promise.all([
      runAsSystemAuthored(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }),
      (async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        sibling = currentEventSource();
      })(),
    ]);

    expect(sibling).toBe('user');
  });

  it('restores the outer value when the wrapped call throws', async () => {
    await expect(
      runAsSystemAuthored(async () => {
        throw new Error('capability blew up');
      })
    ).rejects.toThrow('capability blew up');

    expect(currentEventSource()).toBe('user');
  });
});
