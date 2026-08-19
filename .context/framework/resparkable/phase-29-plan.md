# Phase 29 — billing foundation

**Status: scoped, 2026-08-17. Not yet built.** This is the working doc for
Release 6's first phase (`plan.md` §15 row 29, detailed in §20) — schema,
migration and attribution plumbing for `ResparkableCreditAccount` /
`ResparkableCreditLedgerEntry` / `ResparkableBillingSettings`. Phase 30
(Instruct mode) depends on this landing first, per §15's own sequencing note:
Instruct mode is the highest-volume consumer of the ledger, so the pre-flight
balance check has to exist before the feature that would otherwise run for
free.

Phase 29's deliverable, from `plan.md` §15 row 29: **billing foundation** —
`ResparkableCreditAccount` + `ResparkableCreditLedgerEntry` +
`ResparkableBillingSettings` + migration; cost attribution wired into the chat
route, the per-user scheduled jobs and the on-demand buttons (briefing
regenerate, reindex, ideate); pre-flight hard-block on zero balance; admin
billing page. Verifiable by: grant credits to a test user; a chat turn's
ledger debit matches that turn's summed `AiCostLog.totalCostUsd` plus the
configured service charge; a zero-balance user's next model-backed call is
refused before any provider request is made.

Like phases 7 and 9, this plan needed correcting before it could be built —
§20's attribution paragraph turns out to describe one mechanism where the
codebase actually has three, and one of the two seams it points to doesn't
exist the way it's described. Those corrections are §2 below, verified
against source (`streaming-handler.ts`, `ideate.ts`, `hooks/registry.ts`)
rather than inferred from the plan's own account of itself.

---

## 1. Schema — `prisma/schema/framework-resparkable.prisma`

```prisma
model ResparkableCreditAccount {
  id             String   @id @default(cuid())
  userId         String   @unique
  balanceCredits Float    @default(0)
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  space ResparkableSpace @relation(fields: [userId], references: [userId], onDelete: Cascade)

  @@map("framework_resparkable_credit_account")
}

model ResparkableCreditLedgerEntry {
  id     String @id @default(cuid())
  userId String

  /// admin_grant | agent_spend | refund
  kind             String @db.VarChar(16)
  creditsDelta     Float
  tokenCostUsd     Float?
  serviceChargeUsd Float?
  totalUsd         Float?

  /// Soft references, no FK — tier-boundary pattern (transfer.md), consistent
  /// with every other cross-table reference this plan uses.
  relatedConversationId      String?
  relatedWorkflowExecutionId String?
  relatedCostLogId           String?

  note              String?  @db.VarChar(500)
  createdByAdminId  String? // admin_grant only
  createdAt         DateTime @default(now())

  space ResparkableSpace @relation(fields: [userId], references: [userId], onDelete: Cascade)

  @@index([userId, createdAt])
  /// Idempotency guard for Site B's tick-poll (§2b) — a repeat pass over an
  /// already-billed execution hits this constraint instead of double-charging.
  /// Nullable, so admin_grant/refund rows (no execution id) are unconstrained.
  @@unique([kind, relatedWorkflowExecutionId])
  @@map("framework_resparkable_credit_ledger_entry")
}

model ResparkableBillingSettings {
  id                        String   @id @default(cuid())
  slug                      String   @unique @default("global")
  creditsPerUsd             Float    @default(1)
  serviceChargePercent      Float    @default(0)
  costVisibleToUsersDefault Boolean  @default(true)
  currencyLabel             String   @default("credits") @db.VarChar(32)
  newUserGrantCredits       Float    @default(0)
  createdAt                 DateTime @default(now())
  updatedAt                 DateTime @updatedAt

  @@map("framework_resparkable_billing_settings")
}
```

- `ResparkableCreditAccount`/`Entry` use the same `space ResparkableSpace
@relation(..., onDelete: Cascade)` shape as every other D1 table
  (`ResparkableArea`, `ResparkableTask`, …) — created inside
  `ensureResparkableSpace()` alongside the space row itself
  (`lib/framework/resparkable/services/space.ts`), same
  idempotent-under-concurrency pattern already documented there.
- `ResparkableBillingSettings` mirrors `ResparkableSettings`'s `slug: 'global'`
  singleton exactly (`framework-resparkable.prisma:929`) — same repo-helper
  shape (`findResparkableBillingSettings` / `upsertResparkableBillingSettings`),
  same `resolveX()` + `DEFAULT_X` pattern as `resolveDocumentOriginals` /
  `DEFAULT_DOCUMENT_ORIGINALS` in `lib/framework/resparkable/settings.ts`.
- **No new drift probes.** The six existing probes guard pgvector HNSW
  indexes, generated `tsvector` columns, and the D1 cascade check — raw-SQL
  objects Prisma can't represent. These three tables are plain relational
  shapes with standard FKs and B-tree indexes, fully expressible in Prisma;
  `migrate dev` won't emit a DROP for anything here.

## 2. Attribution — three sites, and where `plan.md` §20 needed correcting

### 2a. Site A — chat turns: simpler than the plan says, once the `done` event is used

§20 says to "sum that turn's `AiCostLog` rows by `conversationId`" — that's
wrong as written: `conversationId` spans the whole conversation, not one turn,
so summing by it on every turn re-bills every prior turn as well. What
actually solves this is already flowing through the wire and needs no query at
all — `streamChat`'s `done` event (`types/orchestration.ts:875`) carries
`tokenUsage` and `costUsd` computed **per-turn**
(`lib/orchestration/chat/streaming-handler.ts:2708-2714`).

The gap: `app/api/v1/resparkable/chat/stream/route.ts` currently pipes
`streamChat(...)` straight into `sseResponse()` with no inspection. Phase 29
wraps that async iterable — forward each event to SSE unchanged, and when a
`done` event passes through, write the `agent_spend` ledger row straight from
its `costUsd`/`tokenUsage`. Pre-flight balance check goes immediately before
the `streamChat(...)` call, after `ensureResparkableSpace()`.

### 2b. Site B — scheduled and queued workflows: the plan's fallback mechanism is right, its named seam is not

Covers the five per-user schedules (§6) plus `briefing/regenerate` — confirmed
these share one code path: `regenerate`'s route
(`app/api/v1/resparkable/briefing/regenerate/route.ts`) calls
`queueResparkableWorkflowRun()`, the exact function a real schedule tick uses,
returning an `executionId` for an `AiWorkflowExecution` the maintenance tick
processes later. Nothing in the request is waiting on it.

§20 doesn't name a mechanism for this beyond "at the point
`registerResparkableJobs()`'s pass finishes that user's run" — plausible, but I
checked whether the platform's event-hook system could push a completion
callback instead, since that would be less code. **It can't**: `emitHookEvent()`
(`lib/orchestration/hooks/registry.ts:17`) only dispatches to admin-configured
`AiEventHook` rows via outbound HTTP webhook — there is no in-process listener
registry, confirmed by reading the dispatcher. `workflow.completed`'s emitted
payload (`orchestration-engine.ts:668-674`) does carry exactly what's needed
(`executionId`, `userId`, `tokensUsed`, `costUsd`) — but only to a webhook URL
an admin configured, not to arbitrary in-process code. Building on it would
mean Resparkable creating a self-addressed `AiEventHook` row and eating an
HTTP round-trip plus a 3-attempt retry ceiling for what is, structurally,
financial data — worse than a poll.

So: extend Resparkable's own existing per-tick job
(`lib/framework/resparkable/jobs.ts`, registered via `registerAppJob`, already
running on a timer for the connection sweep) with a second pass — find
resparkable-slug `AiWorkflowExecution` rows in a terminal state with no
matching ledger entry, sum `AiCostLog` by `workflowExecutionId` (unique per
run, no double-count risk), write the entry. The `@@unique([kind,
relatedWorkflowExecutionId])` constraint from §1 is what makes a repeat pass
safe — a second attempt over an already-billed execution is a no-op, not a
duplicate charge.

### 2c. Site C — synchronous on-demand compute with no correlation id

`ideate()` (`lib/framework/resparkable/services/ideate.ts:263`) calls
`logCost()` directly with only `agentId` and a `metadata.feature` tag — no
`conversationId`, no `workflowExecutionId` to join against later. `reindex`
does not call `logCost` at all in the paths checked, so it may not be a
billable site at all — verify at implementation time rather than assume it
needs the same treatment.

Cheapest fix, mirroring what `streaming-handler.ts` already does for chat:
have `ideate()` return `{ tokenUsage, costUsd }` alongside its result, and have
the route write the ledger entry immediately after `await ideate(...)`
resolves, in the same request — no polling, no join, no new correlation id
needed.

**Net effect on §20**: three sites, three different mechanisms (SSE-event tap
/ tick-poll / return-value-in-request), not the one uniform "read what
`AiCostLog` already logged" story the plan implies. Worth keeping this
distinction visible so whoever builds Site B doesn't go looking for a
hook-event integration that isn't there.

## 3. Pre-flight block

- **Sites A and C** (a request is waiting): check
  `ResparkableCreditAccount.balanceCredits <= 0` before dispatch, refuse
  before any provider call is made. Per risk 20a, an estimate shown in the
  refusal message is advisory only — the debit that actually happens is
  always computed from real `AiCostLog`/`done`-event numbers, never the
  estimate that gated it.
- **Site B** (nothing is waiting): the block has to live in the tick job
  itself — skip queuing/running a user's scheduled workflow at zero balance,
  and surface that state somewhere visible (the existing stale-briefing UI
  path — "your briefing didn't run" — is the template to extend rather than
  invent a new one).
- Deterministic capabilities (`resparkable_reprioritise` etc.) aren't gated at
  all — no model call, nothing to block.

## 4. Admin allocation

Extends the existing singleton page/route rather than adding a new surface: a
**Billing** tab on `/admin/resparkable/settings`
(`app/admin/resparkable/settings/page.tsx`), same `GET`/`PATCH` shape as
`app/api/v1/admin/resparkable/settings/route.ts` for
`ResparkableBillingSettings`, plus a per-user balance table with a "grant
credits" action (amount + note → one `admin_grant` ledger row) at a new route,
e.g. `app/api/v1/admin/resparkable/billing/grants/route.ts`, `withAdminAuth`.

## 5. Privacy — two concrete edits, not hypothetical

This tier has its own completeness guards, separate from core's —
`lib/privacy/export-sources.ts` cannot see `framework-resparkable.prisma` at
all, which is why every existing Resparkable model is hand-listed as
`HANDLED_OUTSIDE_MANIFEST` in `tests/unit/lib/privacy/export-sources.test.ts`.

- **Export**: add `ResparkableCreditAccount` and `ResparkableCreditLedgerEntry`
  to `RESPARKABLE_SUBJECT_SOURCES` in
  `lib/framework/resparkable/repo/subject-export.ts` — both hold financial
  history about the subject. `ResparkableBillingSettings` is excluded on the
  same "global singleton, no `userId`" grounds `ResparkableSettings` already
  documents there.
- **Erasure — risk 20b, a real decision, not a formality.** Both new tables
  hang off `ResparkableSpace` via the same D1 relation as everything else, so
  they cascade-delete automatically, no extra code, consistent with the rest
  of the tier. The tension: that also deletes the record of what a
  since-deleted user was charged, which an admin might need for a dispute.
  **Recommendation: cascade anyway.** Consistent with the tier's one
  invariant — erase removes everything, no exception to remember — and with
  `CLAUDE.md`'s own default for personal-data FKs. The schedule-row precedent
  (`lib/framework/resparkable/erasure.ts`) shows what a `SetNull` exception
  actually costs: a dedicated cleanup hook, a name-prefix filter, its own
  test. If dispute-record retention turns out to matter in practice, solve it
  with a separate admin-side export taken _before_ an erasure runs, not by
  carving an exception into the ledger's cascade.

## 6. Sequencing / verification checklist

1. Migration + `npm run db:drift-check` — expect green, no new probes.
2. `ensureResparkableSpace()` creates the credit account row alongside the
   space row.
3. Ledger write path per site, with the Site-B idempotency test: run the tick
   pass twice against the same completed execution, assert exactly one
   ledger row.
4. Pre-flight block test: zero balance → the next chat/ideate call is refused
   before any provider request fires — assert via a spy that the provider
   client is never called, not just that the response is an error.
5. §16.6 risk 20a: pre-flight compares balance against an estimate; the
   actual debit always matches real `AiCostLog`/`done` numbers even when they
   diverge from the estimate.
6. Erasure: erase a user with ledger history → both tables gone via cascade,
   confirmed against `scripts/smoke/erasure.ts`'s pattern.
7. `tests/unit/lib/framework/resparkable/privacy/subject-export.test.ts` goes
   green once both models are added to the manifest.
8. Admin grant flow: grant credits → balance increases → a subsequently
   blocked action succeeds.

## 7. Deliberately deferred

- **Real purchase flow.** §20 is explicit: v1 is "pretend billing" — admin
  grants only. A payments integration is its own future plan item, not scoped
  here.
- **`resolvePoolEntitlements()` unification.** §18.10 flags this ledger and
  Cross-Pollination's cadence-allowance concept as a different axis (dollar
  spend vs. matching-cadence throttle) and explicitly does not merge them.
  Noted here so the two don't drift apart by accident if Release 6 ships
  before Release 5.
- **Per-user `costVisibleToUsersDefault` override.** §20 ships one global
  on/off switch; a per-user override is out of scope for this phase.

## 8. Known issues, found during implementation review, deferred to a later phase

Unlike §7 (scope decisions made before the phase was built), everything below
was found by running `/pr-gates` against the finished branch (a security
review plus two independent `/code-review` passes at high effort) and
verified against the shipped code, not inferred from the design doc. None of
it blocked merging v1. All of it should be read before starting the next
billing-related phase, so a later change does not silently re-introduce one
of these while fixing another.

### 8a. Scheduled workflows have no pre-flight balance gate

The four calendar-scheduled workflows (nightly triage, morning briefing,
weekly review, horizon check) and `briefing/regenerate` keep being queued and
run at zero or negative balance, forever. `services/billing.ts` already
exports `hasPositiveBalance()` with a doc comment saying it exists for "the
Site B tick job's queue-skip check," but nothing calls it. Site B's tick pass
(`jobs.ts`) only records the ledger debit after a run is already terminal, so
the spend always happens before it is ever gated.

**Accepted for v1** (decision made 2026-08-18, during `/pr-gates` review):
this is the same trade-off already documented in the phase's own commit
message. v1 is admin-grant-only with no self-serve top-up, so there is no
abuse vector, only an admin-visible negative balance as a backstop. Wiring a
gate in without touching core's `scheduler.ts` would mean toggling
`AiWorkflowSchedule.isEnabled` from Resparkable's own tick job, which needs a
new column to distinguish "disabled because the balance ran out" from
"disabled because the user turned it off" (see the erasure-hook and
schedule-row precedents `repo/schedules.ts` already carries for how much a
similar exception costs). A real design decision, not a quick patch.

### 8b. `assertPositiveBalance` / `recordAgentSpend` is a check-then-act race

The two functions are not wrapped in a single transaction or reservation.
Two concurrent requests from the same user (two tabs, a double-click) can
both read a positive balance and both pass the pre-flight check before
either has debited anything, so both proceed and can drive the balance
arbitrarily negative. Unlike 8a, this was not called out anywhere as a known
v1 gap before this review found it.

**Accepted for v1** (decision made 2026-08-18): same backstop reasoning as
8a: admin-grant-only balances, bounded blast radius, a negative balance is
visible and admin-correctable. A real fix needs a reservation/lock step
(e.g. debit an estimate at pre-flight time and reconcile to the real cost
after) or a DB-level constraint, which is a genuine design decision for
whoever picks this phase up next, not a bug fix.

### 8c. `resparkable_ideate`, the chat capability, has a fully unmetered spend path

Distinct from Site C (the `/ideate` HTTP route, which is billed correctly).
`lib/framework/resparkable/capabilities/ideate.ts` lets a chat agent call the
same costed `ideate()` function as a tool mid-conversation. `CapabilityResult`
carries no cost field, and `streaming-handler.ts`'s own doc comment (around
line 1086) says capabilities that make their own LLM calls are not counted
toward the per-turn cost, so that spend never reaches the `done` event's
`costUsd` and is never debited. This is a fourth attribution site the phase
29 plan never named, found by the second `/code-review` pass, outside this
branch's diff (the capability file was not touched by this phase).

**To do in a later phase**: bill this the same way Site C's route does,
after `ideate()` resolves inside the capability's `run()`, record the spend
against the calling user's `OwnerScope`. The capability layer does not
currently carry an `OwnerScope`, only a `CapabilityContext`; resolving one
from it (mirroring `requireResparkableUser`, see `repo/owner-scope.ts`) is
part of the work.

### 8d. Core `streaming-handler.ts` under-bills chat turns (upstream, not Resparkable-owned)

Three related bugs in `lib/orchestration/chat/streaming-handler.ts`, all
upstream of Site A's tap and all real gaps between what a turn actually costs
and what the `done` event reports as `costUsd`, the number `tapChatSpend`
debits:

- **`buildDoneEvent` (~line 2701) only reflects the last tool-loop
  iteration's usage.** `turnCostUsd` accumulates cost across every iteration
  of a multi-tool-call turn (line ~1638), but `buildDoneEvent` is only ever
  passed that iteration's own `usage`, never the accumulated total. A turn
  that calls three tools gets billed for one of the three calls.
- **`buildDoneEvent` excludes `sideEffectModels`' cost.** Side-effect calls
  (knowledge-base search, the rolling conversation summariser) carry their
  own `costUsd`, attached to the event as metadata only, never folded into
  the event's own `costUsd`.
- **Several exit paths skip the `done` event entirely, after cost was
  already logged.** The mid-loop per-turn budget cap (~line 1721-1728), the
  monthly budget cap, `tool_loop_cap`, and the catch-all `internal_error`
  path all `return` without ever yielding `done`, even when a `logCost()`
  call for that turn's real, already-incurred cost happened moments earlier
  in the same function. `tapChatSpend` only debits on `done`, so that spend
  is never billed at all, not even partially.

This file is core/platform-owned, not `lib/framework/resparkable/`, so it is
outside what this fork edits directly (see `CLAUDE.md`'s fork-tier rules).
**To do in a later phase**: file a `sunrise-asks.md` row and an upstream
issue per that file's own process, then decide whether Resparkable carries a
local workaround (e.g. Site A reading a cumulative-cost field instead of
`costUsd`, if core adds one) in the meantime.

### 8e. Admin billing accounts table has no working pagination past 50 users

`listCreditAccountsForAdmin` defaults to 50 rows and accepts a `cursor`, but
`app/api/v1/admin/resparkable/billing/accounts/route.ts` never returns a
next-cursor and the admin settings page never supplies one. On a deployment
with 51 or more users, everyone past the 50th (ordered by email) is
permanently unreachable for a credit grant from this screen. **To do in a
later phase**: surface `nextCursor`/`hasMore` from the route and add a "load
more" control to `CreditAccountsTable`, once a deployment's user count makes
it worth building rather than a one-off admin DB query.

### 8f. Site B's billing pass has no persisted cursor, only a bounded window

`findRecentTerminalResparkableExecutions` always takes the newest 100
terminal, resparkable-slug executions system-wide, ordered newest-first (see
its own doc comment for why newest-first, not oldest-first). This is
self-correcting under normal volume, but if more than 100 resparkable-slug
executions go terminal within one 6-hour tick window (a maintenance outage,
or genuinely high scale), older unbilled ones can be pushed below rank 100 by
newer completions and never appear in a later tick's window again. There is
no persisted cursor to prevent this, because there is no Resparkable-writable
cursor column on the platform-owned `AiWorkflowExecution` table. Low
likelihood at current expected scale; worth a real cursor (a small
Resparkable-owned table mapping the last-billed `updatedAt` per tick, say) if
volume ever approaches the 100/6h ceiling.

### 8g. `tapChatSpend` awaits the ledger write before forwarding `done`

`recordAgentSpend`'s transactional write happens inside the `for await` loop
before the `done` frame is yielded onward to `sseResponse`, where the
pre-phase-29 code forwarded every event with no side-channel I/O in between.
Under DB contention this could delay the client's `done` frame by the
ledger write's duration. Deliberate: the alternative (fire-and-forget the
debit, yield `done` immediately) risks losing a debit silently if the process
exits between yielding `done` and the write completing, and chat spend has no
backstop reconciliation the way Site B does for workflow executions. Revisit
only if this becomes measurable, user-visible latency.
