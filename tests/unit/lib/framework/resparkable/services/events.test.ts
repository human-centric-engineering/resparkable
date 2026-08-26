/**
 * Unit Tests: activity-log writes (Release 1, phase 2).
 *
 * The file's whole reason to exist is one asymmetry: an event write must
 * never fail a user's mutation. That's the single most important behaviour
 * here and has zero coverage today — `insertEvent` is always mocked to
 * resolve in every other suite that touches this module transitively.
 *
 * @see lib/framework/resparkable/services/events.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/framework/resparkable/repo/events', () => ({
  insertEvent: vi.fn(),
}));

vi.mock('@/lib/framework/resparkable/queue/enqueue', () => ({
  wakeResparkableJobs: vi.fn(),
}));

import { logger } from '@/lib/logging';
import { insertEvent } from '@/lib/framework/resparkable/repo/events';
import { wakeResparkableJobs } from '@/lib/framework/resparkable/queue/enqueue';
import { runAsSystemAuthored } from '@/lib/framework/resparkable/services/authorship';
import {
  eventKindForUpdate,
  recordResparkableEvent,
} from '@/lib/framework/resparkable/services/events';
import { ownerScope } from '@/lib/framework/resparkable/repo/owner-scope';

const SCOPE = ownerScope('user_x');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('recordResparkableEvent', () => {
  it('resolves even when the underlying insert rejects', async () => {
    // Arrange: the log write must never turn a successful mutation into a
    // 500 because the activity-log insert lost a race.
    vi.mocked(insertEvent).mockRejectedValue(new Error('db unavailable'));

    // Act / Assert: the returned promise settles, it does not reject.
    await expect(
      recordResparkableEvent(SCOPE, { kind: 'completed', entityType: 'task', entityId: 'task_1' })
    ).resolves.toBeUndefined();
  });

  it('logs a warning with the kind, entityType and entityId on failure', async () => {
    // Arrange
    vi.mocked(insertEvent).mockRejectedValue(new Error('db unavailable'));

    // Act
    await recordResparkableEvent(SCOPE, {
      kind: 'completed',
      entityType: 'task',
      entityId: 'task_1',
    });

    // Assert: a swallowed failure must still be diagnosable from the log line.
    expect(logger.warn).toHaveBeenCalledWith(
      'Resparkable event write failed',
      expect.objectContaining({
        kind: 'completed',
        entityType: 'task',
        entityId: 'task_1',
      })
    );
  });

  it('falls back to String(error) when the rejection is not an Error instance', async () => {
    // Arrange: some rejections aren't Error objects (a thrown string, a
    // plain object) — the `error instanceof Error` guard must not throw
    // trying to read `.message` off something that doesn't have one.
    vi.mocked(insertEvent).mockRejectedValue('boom');

    // Act
    await recordResparkableEvent(SCOPE, {
      kind: 'completed',
      entityType: 'task',
      entityId: 'task_1',
    });

    // Assert
    expect(logger.warn).toHaveBeenCalledWith(
      'Resparkable event write failed',
      expect.objectContaining({ error: 'boom' })
    );
  });
});

describe('recordResparkableEvent — authorship (phase 56)', () => {
  it('stamps a plain write as the person’s', async () => {
    vi.mocked(insertEvent).mockResolvedValue({} as never);

    await recordResparkableEvent(SCOPE, {
      kind: 'captured',
      entityType: 'thought',
      entityId: 't1',
    });

    expect(vi.mocked(insertEvent).mock.calls[0]?.[1]).toMatchObject({ source: 'user' });
  });

  it('stamps a write made inside a background run as the system’s', async () => {
    // The row that decides whether an idle brain gets billed. Written `user`,
    // this event is the background run authorising its own successor.
    vi.mocked(insertEvent).mockResolvedValue({} as never);

    await runAsSystemAuthored(async () => {
      await recordResparkableEvent(SCOPE, {
        kind: 'created',
        entityType: 'review',
        entityId: 'r1',
      });
    });

    expect(vi.mocked(insertEvent).mock.calls[0]?.[1]).toMatchObject({ source: 'system' });
  });

  it('does NOT wake the brain for a system-authored write', async () => {
    // Waking is the mirror of the demand gate and must read the same signal.
    // A background run that woke the brain would clear `dormantSince` for every
    // OTHER kind too — so the gate would not merely fail to fire, it would
    // re-arm the whole set on a brain nobody had touched.
    vi.mocked(insertEvent).mockResolvedValue({} as never);

    await runAsSystemAuthored(async () => {
      await recordResparkableEvent(SCOPE, {
        kind: 'created',
        entityType: 'review',
        entityId: 'r1',
      });
    });

    expect(wakeResparkableJobs).not.toHaveBeenCalled();
  });
});

describe('recordResparkableEvent — waking a dormant brain (phase 56)', () => {
  it('wakes the brain after a successful write', async () => {
    // The demand gate backs an untouched brain off to weekly, and this is the
    // write that pulls it back in. Doing it here rather than in each of the
    // twenty services that mutate something is the point: the event log is the
    // one thing they all already go through.
    vi.mocked(insertEvent).mockResolvedValue({} as never);

    await recordResparkableEvent(SCOPE, {
      kind: 'captured',
      entityType: 'thought',
      entityId: 't1',
    });

    expect(wakeResparkableJobs).toHaveBeenCalledWith('user_x');
  });

  it('does NOT wake when the event failed to write', async () => {
    // The wake pulls every due time forward on the strength of this event. An
    // event that failed to write is one the demand gate will never be able to
    // see, so waking on it schedules work to look for a change that is not
    // recorded anywhere — and, worse, clears `dormantSince` so the *next* gate
    // cannot tell the brain has been quiet. The module comment claimed this
    // ordering while the code ran the wake unconditionally.
    vi.mocked(insertEvent).mockRejectedValue(new Error('db unavailable'));

    await recordResparkableEvent(SCOPE, {
      kind: 'captured',
      entityType: 'thought',
      entityId: 't1',
    });

    expect(wakeResparkableJobs).not.toHaveBeenCalled();
  });
});

describe('eventKindForUpdate', () => {
  it('reports "updated", not "completed", for a done-to-done save', () => {
    // Arrange: a naive `after.status === 'done'` check would misclassify a
    // re-save of an already-completed task as a new completion — the
    // morning briefing would then claim you finished the same task twice.
    const before = { status: 'done' };
    const after = { status: 'done' };

    // Act
    const kind = eventKindForUpdate(before, after);

    // Assert
    expect(kind).toBe('updated');
  });
});
