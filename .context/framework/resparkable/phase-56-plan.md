# Phase 56 — the job queue

**Status: BUILT, 2026-08-26.** Scoped 2026-08-25; this is the working doc for
decision **S6** in [`scale.md`](./scale.md), the largest item in Release 1.5
(`plan.md` §15). It resolved the question that blocked Release 1.5 from being
buildable: **who owns per-user scheduled work.**

> ## What shipped, and the three places it does not match this document
>
> The design below is what was built, with three deliberate departures. They are
> recorded here rather than quietly folded in, because each one is a correction
> to an argument this document makes, and a reader who trusts §7 or §6 without
> reading this box will be wrong about how the system behaves.
>
> **1. The demand gate is asked BEFORE the run, not on completion (§7).** As
> written, the gate costs one billed do-nothing run per dormant period per
> brain: the run happens, discovers nothing had changed, and only _then_ defers
> the next one. At weekly backoff that is roughly four worthless charges a month
> per idle brain — and it fails this document's own assertion 5, which asks for
> **zero** LLM calls across a simulated month. The pre-flight version asks the
> identical question against the identical index and spends nothing. It is the
> only version under which §7's own rule ("never debit a person's balance for a
> run that cannot produce anything") is actually true.
>
> **2. S8 is an anti-join, not a completion hook (§6).** "The run that spent the
> money is the thing that bills for it" cannot be implemented as written,
> because the job does not run the workflow — it writes a `PENDING`
> `AiWorkflowExecution` and returns, and the engine runs it minutes later on the
> tick. The job has no cost to report at the moment it completes. What the
> phrase was reaching for is "no cursor to fall behind", and that is achieved
> instead by selecting terminal executions with **no ledger row**, oldest-first:
> an execution leaves the candidate set the moment it is billed, permanently, so
> the set only ever shrinks and `limit` becomes a per-pass bound rather than a
> window. The 150-completions-in-one-window regression (assertion 6) is fixed;
> the mechanism is different.
>
> **3. No new drift probe (§8).** The plan asks for a probe on "the partial
> index backing the claim query". The claim's predicate is `now()`-relative, so
> there is no time-independent subset to make partial — the index that shipped
> is an ordinary composite `(dueAt, leaseExpiresAt)`, which Prisma _can_ model.
> That inverts the reasoning: drift probes exist for objects that
> `prisma migrate dev` would silently drop because it cannot represent them, and
> this one it would recreate. Adding a probe for it would be a probe that cannot fail.
>
> Two smaller decisions worth knowing: `retention` is deliberately **not**
> demand-gated (the calendar drives it, not activity, so gating it would stop it
> working for exactly the dormant brains whose data most needs ageing out), and
> `reindex` runs every **fifteen minutes** rather than nightly, because it is
> what makes a captured thought findable by meaning and an overnight gap is one
> a person notices.
>
> Assertion 10 (row count invariant under workspace creation) is not yet
> testable: `plan.md` §24 is not built. The table is owner-keyed up front
> precisely so it will pass without a migration when §24 arrives.
>
> **Where it lives.** `queue/kinds.ts` (vocabulary, cadence, gating),
> `repo/jobs.ts` (the `SKIP LOCKED` claim and the settles), `queue/handlers.ts`
> (what each kind does), `queue/drain.ts` (claim → gate → run → settle),
> `queue/enqueue.ts` (enqueue, wake, backfill net), `jobs.ts` (the tick),
> `scripts/framework/resparkable/worker.ts` (the standalone loop). Migration
> `20260826090000_resparkable_job_queue`. Verified by
> `npm run framework:resparkable:smoke-queue`.

Phase 56's deliverable: **one durable job queue for every piece of per-user
background work, drained by parallel workers until empty, with the worker loop
runnable either inside the maintenance tick or as its own process.** Verifiable
by: 5,000 seeded brains complete a full rotation of every job kind inside one
hour, with no schedule row per user anywhere in the system, and with an idle
brain consuming zero LLM calls across a simulated month.

> **Coupled to §23 (Groups) and §24 (Workspaces), both scoped the same day.**
> Those sections rename `ResparkableSpace.userId` to `spaceId` across all 21
> satellite tables (phase 45) and add `ownerUserId`, and §24's **W2** requires
> scheduled work to be **per owner with a fan-out over that owner's live
> workspaces**, so the row count stays invariant as workspaces multiply. This
> phase satisfies W2 up front rather than being migrated into it: see §3's
> owner-keying note. Phase 45 must include `framework_resparkable_job` in its
> rename sweep.

> **Numbering.** Phase 30 is Instruct mode. Phases are allocated to 55, so this
> work takes 56 and Release 1.5's remaining items take 57 onward. An earlier
> note in conversation called this "phase 30"; that was wrong.

---

## 1. The decision this settles

The scheduler ceiling is `take: 50` at
`lib/orchestration/scheduling/scheduler.ts:250`. It is a hardcoded constant in a
**Sunrise-owned core file** with no env override and no seam, and Resparkable's
portability contract is that it never edits a core file. Three options:

|     | Shape                                                 | Verdict                                                                           |
| --- | ----------------------------------------------------- | --------------------------------------------------------------------------------- |
| A   | File an upstream ask to make `take` configurable      | Necessary but **not sufficient**, and puts Release 1.5 on someone else's timeline |
| B   | Resparkable owns its own dispatcher for per-user work | **Chosen**                                                                        |
| C   | B now, A filed alongside so other forks benefit       | **Also chosen**                                                                   |

**Why B, and why it is not a land-grab.** Raising `take` fixes throughput and
leaves the deeper mismatch untouched. The platform scheduler is built for
**org-level cron rows**, and four separate facts say so:

1. **One row per user per workflow.** At 100k users that is 400,000
   `AiWorkflowSchedule` rows, each carrying a stored cron expression that must
   be created on signup, corrected after every DST change, and deleted on
   erasure. Resparkable already pays for all three: `schedules/ensure.ts`'s
   drift-correction pass and `deleteOrphanedResparkableSchedules()` exist for
   no other reason.
2. **`#502` made scheduled executions system-owned** (`userId: null`), because
   `AiWorkflowExecution.userId` is `onDelete: Cascade` and naming an operator
   meant erasing them destroyed the org's whole run history. Correct for
   org-level cron. It left Resparkable smuggling the owner through
   `AiWorkflowSchedule.scope` (ask #29, sunrise#532). That is a workaround for a
   shape mismatch, not a seam being used as intended.
3. **Resparkable already won this argument once.** Ask #1 argued that continuous
   per-user sweeps do not belong on the workflow scheduler because a cron field
   is the wrong shape for them, and got `registerAppJob` (#469). The same
   argument extends to per-user _scheduled_ work without modification.
4. **It keeps the work inside the tier.** No core edit, no upstream dependency,
   and the module stays installable by checklist.

Ask C is still filed, as the throughput observation on its own: a fork with
genuinely org-level cron at volume will hit `take: 50` too, and the finding is
worth more upstream than in this file.

---

## 2. The one idea that makes the rest fall out

**Store `dueAt`, not a cron string.**

`AiWorkflowSchedule` stores a cron expression per row, which is why it needs a
correction pass: the user moves timezone or the clocks change, and every stored
string is now subtly wrong, silently, in a job that runs before dawn.

If instead each row stores **the next moment this work is due**, computed from
the user's timezone at the moment the previous run finished, there is nothing to
drift. DST is handled for free because the next `dueAt` is always calculated
against the offset in force when it is calculated.

That single change deletes `ensureResparkableSchedules`'s entire drift-repair
half, and with it the reason the schedule pass had to ride the sweep rotation at
all.

---

## 3. Schema — `prisma/schema/framework-resparkable.prisma`

```prisma
/// The one queue. Every piece of per-user background work is a row here.
///
/// ONE ROW PER USER PER KIND, not one per occurrence. `dueAt` moves forward on
/// completion, so the table is bounded at (brains × kinds) and a backlog makes
/// rows LATE, never numerous. At 100k users × 7 kinds that is 700k rows, which
/// is small, indexed, and does not grow when the workers fall behind.
///
/// Contrast `AiWorkflowSchedule`, which this replaces for Resparkable's own
/// work: that table stores a cron string per row and therefore needs a
/// correction pass after every DST change. `dueAt` is computed from the
/// owner's timezone at completion, so there is nothing to correct (§2).
model ResparkableJob {
  id String @id @default(cuid())

  /// **Keyed on the OWNER, not the space.** Today those are the same thing, so
  /// this costs nothing. Under §24 (Workspaces) they diverge, and W2 requires
  /// the row count to stay invariant as a person acquires workspaces: one
  /// `triage` job per person whose run fans out over their live spaces, not one
  /// per space. Keying on the space would put the largest queue in the system
  /// on the wrong side of that requirement and force a second migration.
  ///
  /// Renamed by §23's phase 45 with the other satellites: it relates to the
  /// space today because a space is an owner; afterwards it relates to
  /// `ownerUserId`.
  userId String

  /// triage | briefing | weekly_review | horizon_check | sweep | retention | reindex
  ///
  /// The per-space kinds (sweep, retention, reindex) fan out inside the run;
  /// the four workflow kinds fan out by queueing one execution per live space.
  kind String @db.VarChar(24)

  /// The next moment this work is due. The queue is `dueAt <= now()`.
  dueAt DateTime

  /// Lease, not a boolean flag. A worker that dies mid-job must not pin the
  /// row forever, so reclaim is `leaseExpiresAt < now()` rather than a
  /// separate reaper deciding what "stuck" means.
  leasedBy       String?   @db.VarChar(64)
  leaseExpiresAt DateTime?

  /// Consecutive failures. Feeds exponential backoff on `dueAt` and, past the
  /// cap, marks the row dormant rather than retrying forever at cost.
  attempts   Int       @default(0)
  lastRunAt  DateTime?
  lastError  String?   @db.Text

  /// Demand gating (S7 / §24 W3). Set when a completed run found nothing had
  /// changed; cleared by the next write to that brain. A dormant row is still
  /// claimed, just far less often — never deleted, because a deleted row is
  /// one that never comes back when the person returns.
  dormantSince DateTime?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  /// D1: the cascade path.
  space ResparkableSpace @relation(fields: [userId], references: [userId], onDelete: Cascade)

  /// Idempotent enqueue: "make sure this owner has a triage job" is an upsert.
  /// Owner-keyed, so it stays one row per kind however many workspaces they
  /// hold (§24 W2).
  @@unique([userId, kind])
  /// The claim query, and the only index it needs.
  @@index([dueAt, leaseExpiresAt])
  @@map("framework_resparkable_job")
}
```

`ResparkableSpace.lastSweptAt` and its index are dropped in the same migration.
The rotation cursor it implemented is what this table replaces, and leaving it
behind would give two answers to "when was this brain last worked on".

---

## 4. The claim — `SELECT … FOR UPDATE SKIP LOCKED`

```sql
UPDATE "framework_resparkable_job" SET
  "leasedBy" = $worker, "leaseExpiresAt" = now() + interval '10 minutes'
WHERE "id" IN (
  SELECT "id" FROM "framework_resparkable_job"
  WHERE "dueAt" <= now()
    AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" < now())
  ORDER BY "dueAt" ASC
  LIMIT $batch
  FOR UPDATE SKIP LOCKED
)
RETURNING *;
```

`SKIP LOCKED` is the whole reason this scales where the platform scheduler does
not. The existing scheduler uses an **optimistic lock** on `nextRunAt`: every
worker reads the same 50 rows, all but one loses the update race, and the losers
did their read for nothing. That is fine at one instance and wasteful at ten.
`SKIP LOCKED` hands each worker a _disjoint_ batch in one statement, so adding
workers adds throughput linearly instead of adding contention.

This lives in `repo/jobs.ts` as raw SQL, which is the second file in the tier to
need it (the first is `repo/embeddings.ts`). Same rule applies: raw SQL only
inside `repo/**`, `userId` never interpolated.

---

## 5. The worker — a loop, not a process

This is the part that keeps the module portable.

**The drain function is the unit, and it takes a budget:**

```ts
drainResparkableJobs({ maxJobs, maxWallClockMs, concurrency }): Promise<DrainResult>
```

It is called from **two** places, and they are the same code:

| Caller                                                                 | Budget                          | For                                                                           |
| ---------------------------------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------- |
| `registerAppJob` on the 60s maintenance tick                           | small (a few jobs, ~20s)        | single-container installs, dev, and any deployment under a few thousand users |
| `npm run resparkable:worker` — a standalone Node entrypoint that loops | large, until the queue is empty | scaled installs running N worker containers                                   |

**Deployment topology becomes the operator's choice rather than the module's
requirement.** A fork that installs Resparkable for a team of thirty runs
nothing extra and is correct. A fork at 100k users runs six worker containers
and changes no code. That is the answer to the objection that S6 forces a
second process on every installer, and it is why the drain function is designed
as a bounded call rather than as a daemon.

`install.md` gains one section: when to run the worker, how many, and the single
env var that stops the tick from also draining (`RESPARKABLE_WORKER_MODE=external`)
so the two do not compete on a scaled install.

---

## 6. What moves onto the queue

Every ceiling in `scale.md` is a consumer of this one mechanism. That is the
point of doing it as one phase rather than four fixes.

| Was                                                | Ceiling             | Becomes                                                                                                                      |
| -------------------------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 4 × `AiWorkflowSchedule` rows per user, `take: 50` | ~5,000 users        | 4 job kinds, claimed by `SKIP LOCKED`                                                                                        |
| `SWEEP_BATCH = 4` per 6h                           | already broken      | `kind: 'sweep'`, one row per brain                                                                                           |
| retention, riding the sweep cursor                 | same                | `kind: 'retention'`                                                                                                          |
| `BILLING_BATCH = 100` newest-first (**S8**)        | ~100 users          | a hook on job completion. The run that spent the money is the thing that bills for it, so there is no cursor to fall behind. |
| **nothing at all** drains `indexedHash`            | broken from day one | `kind: 'reindex'`, calling the `reindexPending` that already exists and has never had a caller                               |

**S8 stops being a separate fix.** Once a completed job knows its own cost, the
6-hourly 100-row scan has nothing left to do. Three of Release 1.5's five rows
collapse into this phase.

The four scheduled workflows still run as workflows: the job's `run` queues an
`AiWorkflowExecution` the way `queueResparkableWorkflowRun()` already does, and
the engine is unchanged. **This phase replaces the trigger, not the executor.**

---

## 7. Demand gating — where S7 and §24's W3 land

`plan.md` §24 already carries **W3: "demand-driven per-workspace background
work, so an unopened workspace is not triaged nightly."** `scale.md`'s S7 is the
same idea reached from the cost side. They are one thing and this is where it
lives.

On completion, a job asks one indexed question: _has anything happened in this
brain since my last run?_ `ResparkableEvent` answers it in a single query
against `(userId, createdAt desc)`, which is an index that already exists.

- **Something changed** → next `dueAt` at the normal cadence.
- **Nothing changed** → stamp `dormantSince` and push `dueAt` out on a
  backoff, to a floor of about once a week.
- **Any write to the brain clears `dormantSince`** and pulls `dueAt` back in, so
  returning after three months costs one cycle, not thirteen.

**The spend is billed, so this is not cost-avoidance. It is thrift with someone
else's balance.** At 100k users the four nightly workflows are debited against
`ResparkableCreditAccount` (§20), so the platform is not eating the bill. That
makes the rule sharper rather than softer:

> **Never debit a person's balance for a run that cannot produce anything.**

A nightly triage over an inbox with nothing new in it reads the same notes,
calls the same model, writes the same "nothing to process" summary, and charges
for it. That is not a cheap run, it is a **worthless** one, and it is worse than
a cost problem: it is a charge the person would not agree to if asked.

So the gate is a correctness rule about billing, not a budget lever:

- **Something changed** → normal cadence. The person is paying for work that has
  something to work on.
- **Nothing changed** → no run, no debit. Stamp `dormantSince`, push `dueAt` out
  on a backoff to a floor of about a week.
- **Any write clears `dormantSince`** and pulls `dueAt` back in, so returning
  after three months costs one cycle.

The same principle governs everything else this phase touches, and it is the
reason the reindex job is worth having at all: `reindexPending`'s hash gate
means a queued row costs a **comparison**, not an embedding call, so draining
the queue nightly is close to free and only genuinely changed content is ever
paid for. **Both halves of that are the rule — spend on what changed, never on
what did not.** Any job kind added here later has to answer the same question
before it is allowed to call a model.

**The floor cadence is the one number wanting a human answer.** Set at weekly
here. Someone who captures nothing for a fortnight and then gets no Monday
briefing may read that as the product having given up on them, which is a
product judgement rather than an engineering one.

---

## 8. Erasure, drift and cutover

**Erasure.** `ResparkableJob.userId` cascades through `ResparkableSpace` like
every other tier table (D1). The existing isolation smoke script gains one
assertion. `deleteOrphanedResparkableSchedules()` is deleted along with the rows
it protected.

**Drift.** One new probe: the partial index backing the claim query. The claim
is raw SQL, so an index dropped underneath it degrades to a sequential scan over
the whole queue with no error, which is exactly the failure class probes B3 and
B6 exist for.

**Cutover.** One migration, three steps, in order:

1. Create `framework_resparkable_job`.
2. Backfill one row per kind per existing brain, `dueAt` computed from the
   brain's `timezone` and the static cadence spec.
3. Delete every `AiWorkflowSchedule` row whose workflow slug is a Resparkable
   slug.

Step 3 is the irreversible one and it happens **after** step 2 in the same
migration, so a brain is never in a state where neither mechanism owns it.
`RESPARKABLE_SCHEDULED_WORKFLOWS` stays as the slug list; only the trigger
changes.

---

## 9. Verification

| #   | Assertion                                                                                         | How                                                                  |
| --- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 1   | 5,000 seeded brains complete a full rotation of every kind inside an hour                         | seeded fleet, four workers, count completions                        |
| 2   | Ten concurrent workers claim disjoint batches, zero double-runs                                   | `SKIP LOCKED` under contention, assert on execution count            |
| 3   | A worker killed mid-job has its row reclaimed after the lease expires, not before                 | kill, advance the clock, assert one and only one re-run              |
| 4   | Queue depth is invariant under backlog                                                            | stall the workers, assert row count is unchanged and `dueAt` ages    |
| 5   | An idle brain consumes zero LLM calls across a simulated month                                    | provider-call count, per §24 test for W3                             |
| 6   | 150 executions terminating in one window all produce a ledger entry                               | the S8 regression, which the 100-row cursor failed                   |
| 7   | A captured thought is findable by meaning with no manual `POST /reindex`                          | the gap phase 9c names, closed by `kind: 'reindex'`                  |
| 8   | DST: a brain in a DST-observing timezone runs at the right local hour either side of a transition | no correction pass involved, which is the point of §2                |
| 9   | Erasure removes every job row for that brain                                                      | isolation smoke script                                               |
| 10  | Job-row count is invariant under workspace creation (§24 W2)                                      | create three workspaces for one owner, assert the count did not move |

Assertion 4 is the one that distinguishes this design from what it replaces. A
fixed-batch drain under backlog grows a queue; this one grows a _latency_. The
first is invisible until it is fatal, the second shows up on a graph.

---

## 10. What this phase deliberately does not do

- **It does not touch the workflow engine.** The four background workflows,
  their agents and their steps are unchanged. Only what pulls the trigger moves.
- **It does not implement S1 to S5.** Those are the vector-storage decisions and
  they are their own phase, sequenced before this one because they are DDL.
- **It does not add retries with a dead-letter queue.** `attempts` plus backoff
  plus dormancy covers the failure modes that exist. A DLQ is a thing to add
  when there is a failure it would have caught.
- **It does not make `registerAppJob` distributed.** That seam stays exactly as
  documented: in-process timing, safe for idempotent work. This phase's jobs are
  leased in the database, so they do not rely on it for correctness. Anything
  registered there later still must clear the same bar, and still gets no
  warning if it does not.
