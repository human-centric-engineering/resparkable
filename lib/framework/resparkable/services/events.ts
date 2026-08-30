/**
 * Activity-log writes.
 *
 * **An event must never fail a user's mutation.** The log exists so the weekly
 * review can say what moved and the briefing can lead with what you finished —
 * valuable, but not worth turning a successful "task completed" into a 500
 * because the log insert lost a race. So every write here is best-effort and
 * failures are logged, not thrown.
 *
 * That asymmetry is deliberate and worth stating: this is the one place in
 * Resparkable where a failed DB write is swallowed.
 *
 * It is also where the chat context block is invalidated (phase 6c), where an
 * event's **authorship** is resolved, and where a dormant brain is woken
 * (phase 56). Every mutation in the tier records an event, so doing all three
 * here means no service can forget — including ones written after this file.
 * See `context/invalidate.ts`, `services/authorship.ts` and `queue/enqueue.ts`.
 */

import { logger } from '@/lib/logging';
import { invalidateResparkableContext } from '@/lib/framework/resparkable/context/invalidate';
import {
  insertEvent,
  type ResparkableEventKind,
  type RecordEventInput,
} from '@/lib/framework/resparkable/repo/events';
import type { SpaceScope } from '@/lib/framework/resparkable/repo/space-scope';
import { currentEventSource } from '@/lib/framework/resparkable/services/authorship';
import { wakeResparkableJobs } from '@/lib/framework/resparkable/queue/enqueue';

export type { ResparkableEventKind };

/**
 * Append an event, swallowing failures.
 *
 * Awaited rather than fire-and-forget: on serverless the process can freeze the
 * moment the response is returned, and a floating promise is simply lost
 * (the same trap as the unawaited `sendEmail` regression in the contact route).
 * The insert is a single indexed write — paying for it inline is cheaper than
 * an activity log with holes in it.
 */
export async function recordResparkableEvent(
  scope: SpaceScope,
  input: RecordEventInput
): Promise<void> {
  // Before the write, not after: the cache drop is what stops an agent
  // confidently reporting a task the person finished a minute ago, and it must
  // happen even on the branch where the log insert loses a race. It is a
  // synchronous `Map.delete` — there is nothing to fail and nothing to await.
  invalidateResparkableContext(scope.spaceId);

  // Resolved here rather than taken from the caller: authorship is a property
  // of how this call arrived, and every service between the entry point and
  // this line would only be passing it along unchanged. See `authorship.ts`.
  const source = currentEventSource();

  try {
    await insertEvent(scope, { ...input, source });
  } catch (error) {
    logger.warn('Resparkable event write failed', {
      kind: input.kind,
      entityType: input.entityType,
      entityId: input.entityId,
      error: error instanceof Error ? error.message : String(error),
    });
    // Return rather than fall through. The wake below pulls every due time
    // forward on the strength of this event — and an event that failed to write
    // is one the demand gate will never be able to see, so waking on it would
    // schedule work to look for a change that is not recorded anywhere. The
    // comment below used to claim this ordering while the code ran the wake
    // unconditionally.
    return;
  }

  // Phase 56's demand gate: background work on a brain nobody has touched backs
  // off to weekly, and **any write pulls it straight back in**. This is that
  // write, which is why the wake lives here rather than in each of the twenty
  // services that mutate something — the event log is the one thing they all
  // already go through.
  //
  // On an active brain it is a single indexed UPDATE that matches zero rows, so
  // the cost on the common path is one index probe. Awaited for the same reason
  // the insert above is: a floating promise on serverless is simply lost when
  // the response returns, and a wake that silently did not happen leaves
  // somebody's first day back without a briefing.
  //
  // After a SUCCESSFUL insert — see the early return above.
  //
  // **Only for the person's own writes.** A background run recording its own
  // output must not pull every due time forward and clear `dormantSince`: that
  // is the run authorising its own successor, and it re-arms every OTHER kind
  // as well. Waking is the mirror of the demand gate and has to read the same
  // signal, or a brain nobody has touched never goes quiet.
  if (source === 'user') await wakeResparkableJobs(scope.spaceId);
}

/**
 * Map a mutation to the event kind that describes it.
 *
 * `completed` is not just "an update that set status to done" — it is the event
 * the morning briefing reads to answer "what did you actually finish this
 * week", so it has to be recorded distinctly from an ordinary edit (§6).
 */
export function eventKindForUpdate(
  before: { status?: string | null },
  after: { status?: string | null }
): ResparkableEventKind {
  if (after.status === 'done' && before.status !== 'done') return 'completed';
  return 'updated';
}

/**
 * The `{ statusFrom, statusTo }` payload for a status move, or nothing.
 *
 * `kind: 'updated'` covers every edit — a rename, a new note, a changed due date —
 * so the kind alone cannot tell a board how long a card has sat in its column.
 * This is the one extra key that makes that answerable, written only when the
 * status actually changed so the presence of `statusTo` *is* the signal
 * (`findLatestStatusChanges` filters on it).
 *
 * Ids and enum values only. The activity log deliberately takes no free-form
 * content — an event that outlives the row it describes must not carry its text.
 */
export function statusChangeMetadata(
  before: { status?: string | null },
  after: { status?: string | null }
): { statusFrom: string; statusTo: string } | undefined {
  if (!after.status || after.status === before.status) return undefined;
  return { statusFrom: before.status ?? 'unknown', statusTo: after.status };
}
