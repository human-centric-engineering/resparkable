/**
 * The slugs of the four background workflows, and nothing else.
 *
 * A file of its own because four different layers need these strings —
 * `workflows/definitions.ts` to declare the workflows, `queue/handlers.ts` to
 * pull their triggers, `jobs.ts` to know which executions are billable, and the
 * "regenerate my briefing" route to queue one on demand — and until phase 56
 * they lived in `schedules/ensure.ts`, which meant every one of those importers
 * pulled in the per-user cron machinery to read a constant.
 *
 * That machinery is gone (the queue's `dueAt` replaced it, see
 * `queue/kinds.ts`) and the slugs stayed, which is exactly what
 * `phase-56-plan.md` §8 says should happen: the workflows are unchanged, only
 * what pulls the trigger moved. Keeping them in a leaf module with no imports
 * also keeps the tier's import graph shallow, which is not a stylistic point
 * here — `schedules/ensure.ts` documented a real cycle it had to be written
 * around, and a constants file cannot be part of one.
 *
 * The `resparkable-` prefix is load-bearing rather than cosmetic: it is the only
 * thing distinguishing a workflow this tier owns from a host project's own in a
 * shared table, and `repo/schedules.ts` and the phase-56 migration both filter
 * on it.
 */
export const RESPARKABLE_SCHEDULED_WORKFLOWS = {
  nightlyTriage: 'resparkable-nightly-triage',
  morningBriefing: 'resparkable-morning-briefing',
  weeklyReview: 'resparkable-weekly-review',
  horizonCheck: 'resparkable-horizon-check',
} as const;
