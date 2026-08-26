/**
 * Who wrote this — the person, or the system acting on their behalf.
 *
 * ## The question this answers, and why it needs answering
 *
 * The demand gate (`queue/drain.ts`) skips a background run when nothing has
 * changed in the brain since the last one, so an idle brain costs nothing. It
 * reads `ResparkableEvent`, and until this module existed it could never answer
 * "nothing changed" — because the background runs write events too. All four
 * workflows finish by recording a `review`; nightly triage also records every
 * thought it promotes and every task it creates. Each run therefore produced
 * the evidence that authorised the next one, on a brain nobody had touched,
 * and `wakeResparkableJobs` on the same path cleared dormancy for every other
 * kind as well.
 *
 * "Has anything changed?" was the wrong question. **"Has the person done
 * anything?"** is the right one, and answering it needs to know who wrote the
 * row.
 *
 * ## Why AsyncLocalStorage rather than a parameter
 *
 * Threading a flag from the capability layer through the nine services that
 * record events would work, and would be one forgotten argument away from
 * silently reopening the hole — with no error, no failing test, and a bill as
 * the only symptom. Authorship is ambient: it is a property of *how this call
 * arrived*, not of what any individual writer is doing, and every writer
 * between the entry point and the row would be passing it along unchanged.
 *
 * So it is set once, at the one place every capability call passes through, and
 * read once, at the one place every event is written. A background writer added
 * later is marked correctly without its author knowing this file exists — which
 * is the only property that makes this robust rather than merely correct today.
 *
 * `AsyncLocalStorage` survives `await`, which is what makes a single wrap at
 * the entry point cover an arbitrarily deep async call tree beneath it.
 *
 * ## What is NOT system-authored
 *
 * A capability invoked from **chat** is the person acting, through an agent —
 * they asked for it, in the moment, and it should absolutely wake a dormant
 * brain and count for the gate. The discriminator is therefore
 * `CapabilityContext.workflowExecutionId`, which core sets only for a dispatch
 * from a workflow step, and not "was this an agent?".
 */

import { AsyncLocalStorage } from 'node:async_hooks';

/** user | system. Mirrors `ResparkableEvent.source`. */
export type ResparkableEventSource = 'user' | 'system';

interface AuthorshipStore {
  source: ResparkableEventSource;
}

/**
 * Module-scoped, and deliberately not `globalThis`-backed.
 *
 * Unlike the capability registry (resparkable#462), nothing here needs to cross
 * a realm: the store is written and read inside a single call tree, so a second
 * copy of this module in another realm simply has its own empty store and
 * reports `user` — the safe direction, and the same answer it would give for a
 * call that genuinely came from a person.
 */
const authorship = new AsyncLocalStorage<AuthorshipStore>();

/**
 * Run `fn` with everything it writes marked as system-authored.
 *
 * Called from `ResparkableCapability.execute` when the dispatch carries a
 * `workflowExecutionId`. Nesting is harmless — the inner store simply replaces
 * the outer one with the same value.
 */
export function runAsSystemAuthored<T>(fn: () => Promise<T>): Promise<T> {
  return authorship.run({ source: 'system' }, fn);
}

/**
 * Who is writing, right now.
 *
 * Defaults to `user` outside any wrap, and that default is the one to keep: a
 * genuine capture that was wrongly marked `system` would be invisible to the
 * gate and could leave someone without a briefing on the day they came back. A
 * background write wrongly marked `user` costs one extra run. Both are wrong;
 * only one is wrong in a direction the person would notice.
 */
export function currentEventSource(): ResparkableEventSource {
  return authorship.getStore()?.source ?? 'user';
}
