# Scale — the hundreds-of-thousands-of-users target

> **Ambition, set 2026-08-25.** Resparkable is built to reach **hundreds of
> thousands of users on one deployment**. Not millions: at that point the
> answer is different infrastructure (sharded stores, a dedicated vector
> service, a real job platform), and getting there would be a good problem to
> have. But every foundation laid from here on must survive 100,000 to 500,000
> users without being rebuilt, and the ones already laid are audited against
> that number below.

This document is the audit and the decisions that follow from it. It was
written before Release 2 (Sharing) started, deliberately: the ceilings below
are all in the per-user background-compute layer, and retrofitting that layer
under live shared data is materially harder than fixing it now.

## The through-line

**The per-user data model scales. The per-user scheduled-compute model does
not.**

Every ceiling in this document is the same mistake in a different place: a
fixed-size batch draining a per-user queue on a single serial tick. Fifty
schedules per tick. Four brains per sweep. One hundred executions per billing
pass. Each constant was sized for roughly a dozen users, and each one fails at
a different order of magnitude, silently, with no error and no alarm.

Fixing that once, as a queue-and-workers foundation, fixes all of them.

## Where each foundation breaks

| Foundation                                     | Breaks at                                               | Symptom when it does                                                          |
| ---------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Billing pass (`BILLING_BATCH = 100`, 6-hourly) | **~100 active users**                                   | Workflow executions age out of the window unbilled. Revenue leak, no error.   |
| Workflow scheduler (`take: 50`, 60s tick)      | **~5,000–18,000 users**                                 | Scheduled workflows run late, then later. Briefings arrive at the wrong hour. |
| Sweep rotation (4 brains / 6h)                 | **already, past ~50 users**                             | Connection sweep, retention and schedule correction effectively stop running. |
| Exact vector search                            | **~10,000 chunks per user** (independent of user count) | One search reads 60+ MB. Per-user problem, not a fleet problem.               |
| Embedding table storage                        | **not a cliff, a cost curve**                           | ~800 GB at 100k users on current DDL; ~1.4 TB with the unused HNSW index.     |

## 1. The vector store

### What is right, and must not be traded away

`hybridSearchRows` is an **exact scan under `WHERE userId = $1`**
(`lib/framework/resparkable/repo/embeddings.ts`, and its own doc comment is
honest that this is not ANN). The consequence is the single most important
scale property the system has: **search cost is a function of one user's
corpus, not the corpus.** Adding the hundred-thousandth user does not slow
down the first user's search.

D5 and `OwnerScope` are what make that true and keep it true. Every query is
per-user with no cross-user join, enforced by a branded type plus an ESLint
boundary. This is the foundation that would have been most expensive to
retrofit and it is already in place.

### What does not survive

**Row size.** A `vector(1536)` is 6,152 bytes. With chunk text and the
generated `tsvector`, a row is roughly 8 KB. At a conservative 1,000 chunks per
user, 100,000 users is 100M rows and **~800 GB in one table**. A user with a
document library runs three to five times that.

**The HNSW index is read by nothing and costs roughly as much as the table.**
pgvector's HNSW stores a full copy of every vector in the index, so it is
another ~600 GB at 100k users, and it charges a graph traversal on every
insert. The query cannot use it: the distance pre-filter and the blended
`ORDER BY final_score` both defeat it, which `repo/embeddings.ts` already
documents. The GIN index on `embedding.searchVector` (probes B6/B7) is in the
same position, because `hybridSearchRows` carries no `@@` predicate.

Both are drift-probed as required objects (B3, B6, B7). Removing them is a
recorded decision, not a tidy-up. This document is that record.

### Decisions

**S1 — Store vectors as `halfvec`, not `vector`.** 2 bytes per dimension
instead of 4. Halves the table. pgvector supports it natively and the recall
cost on normalised OpenAI embeddings is negligible.

**S2 — Truncate embeddings to 1024 dimensions. Blocked on a prerequisite, and
deferred.** `text-embedding-3-small` is Matryoshka-trained, so a 1024-dim prefix
is a valid embedding rather than a lossy crop, and the platform embedder already
sends the OpenAI `dimensions` parameter when a model row is flagged
`schemaCompatible` (`lib/orchestration/knowledge/embedder.ts`). The mechanism
exists.

**What blocks it:** the dimension is a property of the _active model row_
(`AiProviderModel.dimensions`, seeded at 1536 by the **core** seed
`prisma/seeds/009-provider-models.ts`), and Resparkable resolves its embedder
through the same `getActiveEmbeddingModelSummary()` the platform knowledge base
uses. `ai_knowledge_chunk.embedding` is `vector(1536) NOT NULL`. Setting the
active model to 1024 would break the platform's own knowledge base, and the seed
that would have to change is a core file.

**The prerequisite** is Resparkable resolving its own embedding model instead of
sharing the platform's active one: its own `AiProviderModel` row, seeded from
`prisma/seeds/framework-resparkable/`, with its own dimension, and
`assertResparkableModelMatchesStoredVectors` checking against that row rather
than the global one. Real cost: a model swap becomes two decisions instead of
one. Worth paying at 100k users, not worth paying today.

**So S1 carries this alone for now.** `halfvec(1536)` halves the table with zero
coupling outside the tier: 800 GB → 400 GB. S2 takes it to 270 GB once the
prerequisite is paid for.

> **S1 must be decided before the corpus exists.** The column width is
> baked into the DDL and into `RESPARKABLE_EMBEDDING_DIMENSION`. Changing it at
> 100M rows is a full re-embed of every user's corpus, paid to the provider.
> `assertResparkableModelMatchesStoredVectors()` already exists to make that
> migration survivable, but survivable is not the same as cheap.

**S3 — Drop the HNSW index; keep probe B3 as a _forbidden_-object probe
instead of a required one.** It protects a future that the current query shape
cannot reach, and it costs roughly the size of the table to hold that option.
Re-create it at the same time as, and only as part of, the inner-CTE rewrite
(S4). The GIN index on `embedding.searchVector` goes the same way.

**S4 — Exact search is a per-user tier, not a global one.** Past roughly
10,000 chunks a single user's search reads 60+ MB and exact scan stops being
the right answer. The escape hatch is the one `repo/embeddings.ts` already
names: an inner index-usable CTE (`ORDER BY embedding <=> $1 LIMIT k`) feeding
the blend. It changes recall semantics, so it is a per-user switch made on
measured corpus size, not a flag day for everyone.

**S5 — Hash-partition `framework_resparkable_embedding` on `userId`.**
Declarative partitioning keeps per-user scans on small partitions, keeps
VACUUM and index maintenance tractable at 100M rows, and makes bulk erasure a
partition operation rather than a mass delete. Every query already leads with
`userId`, so partition pruning is automatic and no query changes.

## 2. Background compute — the real ceiling

### The scheduler saturates around 18,000 users, and clustering makes it worse

`lib/orchestration/scheduling/scheduler.ts` takes **50 due schedules per tick**
against a 60-second external cron. That is 72,000 executions per day for the
entire deployment.

Resparkable gives every user **four cron rows**
(`lib/framework/resparkable/schedules/ensure.ts`). At 100,000 users that is
400,000 rows in `AiWorkflowSchedule` and a demand of 400,000 executions per
day, against a supply of 72,000.

Saturation is therefore at roughly **18,000 users** on average rate. But the
schedules fire at 03:15, 04:30 and so on **in the user's local time**, so they
bunch into timezone bands. If 30% of users share a band, that hour needs
around eight times the average rate and the practical ceiling drops to
**around 5,000 users**.

Two further consequences:

- `drainEngine` is **fire-and-forget inside the web server process**. Fifty
  concurrent agent tool loops run alongside request handling, with no worker
  pool and no backpressure.
- **The economics.** Four agent workflows per user per day at 100,000 users is
  400,000 LLM workflow runs daily. At even $0.02 per run that is **$8,000 a
  day**, spent largely on users who did not open the app that week.

### The sweep rotation terminates in "never"

`lib/framework/resparkable/jobs.ts` sweeps four brains every six hours: sixteen
brains a day.

| Users   | One full rotation   |
| ------- | ------------------- |
| 12      | 1 day (as designed) |
| 5,000   | 10 months           |
| 100,000 | **17 years**        |

The connection sweep, the retention pass and the schedule-correction pass all
share that one cursor, so at scale none of them meaningfully runs. The job's
own doc comment says it "degrades gracefully rather than breaking: more users
means a longer rotation, not a longer tick." That is accurate, and the graceful
degradation terminates in never.

The batch constant cannot simply be raised, because the work is serial inside a
tick that has a 60-second budget shared with everything else.

`registerAppJob` is also explicitly **not** a distributed scheduler: last-run
times live in process memory, so N instances run each job N times per interval.
That is safe for the three idempotent passes on it today and is not a
foundation that non-idempotent work can be added to.

### Decisions

**S6 — Background work moves to a queue with parallel workers, off the web
process.** Designed in full in [`phase-56-plan.md`](./phase-56-plan.md), which
resolves the ownership question this decision left open: Resparkable owns its
own dispatcher rather than editing the core scheduler's `take: 50`. One durable job table (or an external queue), leased by workers that
are not the request-serving process. The three fixed-size batch constants
(`take: 50`, `SWEEP_BATCH = 4`, `BILLING_BATCH = 100`) all become "drain until
empty or budget exhausted", which is what makes them stop being ceilings.

**S7 — Scheduled per-user LLM work becomes demand-driven, not unconditional.**
Same idea as `plan.md` §24's **W3**, reached from the cost side rather than the
workspace side. One thing, and it lands in phase 56 §7.
"Every brain gets four LLM workflows every night" is the assumption that costs
$2.9M a year at target scale. Replace it with:

- skip a user's nightly pass when nothing has changed since their last run
  (`ResparkableEvent` already answers this in one indexed query);
- run triage deterministically first and invoke the model only on the items
  that a rule cannot resolve;
- make cadence a plan tier, so a paying user gets the nightly pass and a free
  user gets a weekly one.

The billing foundation (§20) already makes the spend chargeable. S7 is about
not spending it on absent users in the first place.

**S8 — Fix the billing window before anything else on this list.** It is the
one ceiling that has already been crossed. Window the billing pass by time
(`updatedAt > lastBilledAt`) rather than by a row count, or move billing to a
hook on execution completion. Newest-first-with-a-cap trades a stuck cursor
for silent revenue loss, and the cap is 100.

## 3. What is already ready

Worth stating plainly, because it is most of the platform tier:

- **`lib/db/client.ts`** builds one `PrismaClient` over a `pg` `Pool` with
  `DATABASE_POOL_MAX` configurable, and documents the transaction-pooler
  pattern (PgBouncer, Neon `-pooler`, Supabase `:6543`).
- **Rate limiting** has a Redis store behind `RATE_LIMIT_STORE=redis`
  (`lib/security/rate-limit-stores/redis.ts`), so multi-instance is a config
  change.
- **Storage** has S3 and Vercel Blob providers, not only local disk.
- **The scheduler's optimistic lock on `nextRunAt`** makes it multi-instance
  safe today.
- **D5, `OwnerScope` and the ESLint boundary.** The property that makes
  horizontal scale possible at all, in place before sharing exists.

**Multi-tenancy does not apply.** `.context/architecture/multi-tenancy.md` is
about several _organisations_ sharing one deployment. Resparkable is one user
per space: 100,000 users is 100,000 rows, not 100,000 tenants. No `Org` table,
no RLS retrofit, no `TENANCY_MODE` change.

## 4. Sequencing

S8 first, because it is the only ceiling already crossed. S1, S2 and S3 next,
because they are DDL and get more expensive with every row written. S6 before
Release 2, because sharing adds a second background consumer to a layer that
cannot serve the first. S4, S5 and S7 are real work but they degrade
predictably and can follow.

| #   | Decision                              | Urgency                                                                   |
| --- | ------------------------------------- | ------------------------------------------------------------------------- |
| S8  | Time-window the billing pass          | **Now.** Already leaking.                                                 |
| S1  | `halfvec` instead of `vector`         | **Before the corpus grows.** DDL.                                         |
| S2  | 1024 dimensions instead of 1536       | **Deferred.** Needs Resparkable to own its own embedding model row first. |
| S3  | Drop the unused HNSW and GIN indexes  | With S1/S2, same migration                                                |
| S6  | Queue and workers for background work | **Before Release 2**                                                      |
| S7  | Demand-driven scheduled LLM work      | Before paid launch                                                        |
| S5  | Hash-partition the embedding table    | Before ~10M rows                                                          |
| S4  | Per-user inner-CTE search tier        | Before the first 10k-chunk user                                           |
