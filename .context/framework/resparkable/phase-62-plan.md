# Phase 62: who pays, and the group's books

**Scoped 2026-10-19.** The specification is [`plan.md`](./plan.md) §23.12's second
amendment (2026-09-25) and §23.14 q7 to q10, and it stays the specification. This
document is the design: what the phase decides, where it departs from the plan
and why, and what it deliberately does not do. Where this document and §23.12
disagree, §23.12 wins and this document is wrong.

Acceptance: test 13n; 13h and 13m still pass unchanged.

Decisions dated 2026-10-19 were settled with the user while this document was written.

## What phase 50 already left for this phase

- One account per space: `ResparkableCreditAccount` (`spaceId @unique`). A group
  space's account is the group's pool, and it is the only account a group run
  reads today.
- Every ledger row says who started it (`createdByUserId`), and an operational
  run (the weekly digest, billed by the queue's pass) is already written with
  `authorUserId: null`. So "operational versus activity" needs no new record.
- `assertCanSpend(scope)` refuses before the provider call: viewers, an empty
  pool, a member at their `dailyCreditCap`. `recordAgentSpend(scope, …)` debits
  the scope's one account afterwards and fires the two admin alerts.
- `transferCreditsToGroup` moves credits from a person's own balance into the
  pool in one transaction and refuses rather than overdraws. It is the only
  route from a personal balance into a group today, and every person who uses
  it does so on purpose.
- `getGroupBudget` gives admins per-person spend and contributions over 30 days,
  keyed by raw user id. This is the table the books replace.
- Group deletion and erasure cascade the group space, and the pool goes with it.
  **Today a deleted group's balance simply disappears.**
- `ResparkableGroupAuditEntry` (phase 58) already records `budget_changed`,
  `member_cap_changed` and `topped_up`.

## The one rule everything else follows from

**No charge for a group run ever reads a personal balance.** Every charge in a
group space comes from an account that lives inside the group: the pool, or a
member's own group balance (new in this phase). A personal balance reaches a
group in exactly three ways, each one a transfer the person makes or agreed to
in advance, and each its own ledger row they can see:

1. a top-up into the pool (phase 50),
2. a top-up into their own group balance (new),
3. an automatic top-up into their own group balance, up to a monthly amount
   they set themselves and can withdraw (new, decision 6).

This is phase 50's "never fall back to a member's own balance", generalised. It
answers §23.14 q9's "never a personal balance" and q10's "who pays operational
costs" with one sentence: the payer pays from the money they hold in the group.

## Decision 1: a member's group balance, held on the membership row

Two new columns on `ResparkableGroupMember`:

- `balanceCredits Float @default(0)`: money this person has put into the group
  for their own costs and has not yet spent. **Theirs.** It can go negative,
  which is a debt to the group (decision 5).
- `allowanceRemainingCredits Float @default(0)`: how much of the **pool** this
  person may still spend, when the group carves allowances from the pool
  (decision 3). **Not money**, only a limit on the pool. Never credited back.

On the membership row rather than a second `ResparkableCreditAccount` per
member, because a member's group balance cannot outlive the membership: leaving
settles it (decision 7) and the row goes. A separate account table would need its
own cascade, its own erasure path and its own drift probe for one number.

The ledger gains `memberUserId String?`: **whose group balance this row moves.**
`null` means the pool (in a group space) or the person's own account (in a
personal space). `createdByUserId` still means who started it. The two differ on
purpose: in an equal split, one person's chat turn writes a row against every
member's balance. Hand-written FK to `"user"("id")` `ON DELETE SetNull`, covered by
probe B11 like every other person column on this table. New index
`[spaceId, memberUserId, createdAt]`. The Art. 15 export of the ledger includes
rows where `memberUserId` is the subject as well as rows they authored.

## Decision 2: the settings, and how few of them there are

On `ResparkableGroup`, every one defaulting to what phase 50 does today, so the
migration changes no group's behaviour:

| Column                   | Values                                | Default  |
| ------------------------ | ------------------------------------- | -------- |
| `seatPriceAdminCredits`  | ≥ 0                                   | `0`      |
| `seatPriceMemberCredits` | ≥ 0                                   | `0`      |
| `seatPriceViewerCredits` | ≥ 0                                   | `0`      |
| `operationalCostsPaidBy` | `pool` · `one_admin` · `admins_split` | `pool`   |
| `operationalPayerUserId` | a current admin, when `one_admin`     | `null`   |
| `activityCostsPaidBy`    | `pool` · `equal_split` · `allowance`  | `pool`   |
| `allowanceSource`        | `carved` · `filled`, when `allowance` | `carved` |
| `shortfallPolicy`        | `debt` · `suspend`                    | `debt`   |

Per member, set by an admin: `allowanceCredits Float?` (monthly, decision 3).
Per member, set **by the member and nobody else**: `autoTopUpMonthlyCredits
Float?` and `autoTopUpUsedCredits Float @default(0)` (decision 6).

**Departure from the plan: "the founder" is not a separate option.** §23.14 q10
lists the founder, a chosen admin, or the admins split. The founder is not
recorded anywhere after creation (the group row has no founder column, and the
founder may since have stopped being an admin), and a founder who is no longer an
admin paying the group's running costs is a setting nobody would choose. So the
founder is offered as the preselected admin in `one_admin`, and is otherwise an
admin like any other. One fewer value, the same choices.

Every change writes `budget_changed` to the audit log with the old and new value,
and every member can see the current settings on the group page (§23.12: "the
setting is shown to every member").

**Decided 2026-10-19:** a change to who pays takes effect **at the start of the next
month**, not at once. A member who joined a group where the pool paid for their
chats should not find their own balance charged the next morning. It also settles
an edge the immediate version cannot: a workflow run that starts under one setting
and is billed by the queue's pass under another. A pending change is shown to
every member with the date it starts. Seat prices follow the same rule.

## Decision 3: activity costs, three ways

`resolveCharge(scope, { kind: 'activity' | 'operational' })` replaces the
account-picking half of `assertCanSpend`. It runs before the provider call,
returns a **charge plan**, and `recordAgentSpend` takes that plan and nothing
else. The plan names one source, chosen from the settings, and an empty source is
a refusal. The plan is never re-chosen because a source ran dry.

- **`pool`.** Today's behaviour, unchanged. The plan is the pool. Empty pool:
  refused with today's message.
- **`allowance`, carved.** The plan is the pool, limited by the member's
  `allowanceRemainingCredits`. The admin sets `allowanceCredits` per member; at
  each month's start it is **added** to the remaining figure, so unused allowance
  rolls over (q7). Refused when the remaining figure or the pool is empty. A
  carved allowance is a limit on the group's money and is never credited back.
- **`allowance`, filled.** The plan is the member's own `balanceCredits`. The
  member fills it; `allowanceCredits`, if the admin sets one, is the most the
  member may spend in the group in a month (a monthly cap like `dailyCreditCap`,
  read off the ledger since the month began). Unused money rolls over because it
  is a balance. Refused when the balance is empty.
- **`equal_split`.** The pre-flight checks only the person starting the run: not
  suspended (decision 5), balance above zero. Afterwards the cost is divided into
  equal shares over every joined **admin and member** (not viewers, who cannot
  start a billed run), and each share is debited from that person's
  `balanceCredits`. One `UPDATE … WHERE groupId = $1 AND joinedAt IS NOT NULL AND
role IN ('admin','member')` and one `createMany` inside one transaction, the
  member count read inside it, so a split is never seen half-written (q8) and
  somebody joining mid-split is either in all of it or none. The last share takes
  the rounding remainder so the shares add up to the cost exactly.

`dailyCreditCap` stays, in every mode, as the blast-radius limit it already is.

**Seats are paid from the member's own balance** in every mode, including
`pool`. A seat price above zero is therefore what tells a group's members they
need a group balance.

## Decision 4: operational costs

The digest is today's only operational cost. `resolveCharge(…, 'operational')`:

- `pool`: the pool, as today.
- `one_admin`: `operationalPayerUserId`'s own group balance.
- `admins_split`: an equal split over joined admins, by decision 3's split.

The queue's gate (`hasPositiveBalance`) asks the same resolver, so a digest whose
payer cannot pay is skipped rather than run and refused.

**When the chosen payer leaves, is removed, is erased or stops being an admin**,
the setting falls back to `pool` in the same transaction, writes an audit entry,
and the admins are emailed. That email is §23.13's third permitted kind (the
admin-only budget alerts), a new `GroupBudgetAlertKind` and not a fourth email.

## Decision 5: when somebody cannot pay their share

A shortfall can only happen **after** a run, because a run's cost is not known
until it ends: an equal split where somebody's balance was already low, a seat
charged at the start of the month, or a run that cost more than was left. The
pre-flight can only refuse the person starting the run.

- **`debt`.** The balance goes negative. The person keeps using the group. Their
  next top-up, by hand or automatic, pays the debt first.
- **`suspend`.** The balance goes negative and the person is suspended until it
  is back at zero or above. Suspension is derived (`balanceCredits < 0` and the
  policy is `suspend`), never stored, so paying the debt lifts it with no second
  write.

In both cases the debit happens. A run that has already cost money is never
"refused" afterwards, and a split is never part-paid.

**Decided 2026-10-19:** suspended means **cannot start anything that costs credits**. The
person can still open the workspace, read, write notes and comment, because those
cost nothing and the content is partly theirs. Locking somebody out of what they
wrote over a few credits is a heavier penalty than the debt.

## Decision 6: the monthly cycle and automatic top-ups

**One cycle per group**, starting on the day of the month the group was created
(the 29th, 30th and 31st fold to the 28th), at 00:00 in the group's timezone. A
new gated job kind `group_cycle` on phase 56's queue, one row per group, `dueAt`
the next start. At each start, in one transaction per group:

1. pending setting changes take effect (decision 2),
2. carved allowances are added to `allowanceRemainingCredits`,
3. `autoTopUpUsedCredits` resets to zero,
4. each joined member is charged their role's seat price from their own balance,
   with decision 5 applying to anybody who cannot cover it.

The gate skips a group with every seat price at zero and no carved allowances, so
a group that uses none of this costs one indexed read a month.

**Joining mid-month** pays the seat for the days left in the month, from the
person's own credits, as an explicit step in the join or invite flow that shows
the price before they accept. That one-off payment is the second kind of
top-up in the one rule above, so joining a priced group is never a charge taken without asking. A role
change takes the new price from the next month. A seat is not refunded on
leaving: the month was held.

**Automatic top-up (q7).** A member sets a monthly amount, and only the member can
set or withdraw it. When their group balance falls to zero or below (in the
pre-flight, or after a debit), up to that month's unused amount moves from their
personal balance into their group balance through `transferCreditsToGroup`'s
refuse-rather-than-overdraw path, as one ledger row. It never moves more than the
member agreed in a month, and never anything without that agreement. In a carved
group the same move goes into the pool and raises the member's
`allowanceRemainingCredits` by the same amount: that money is then a contribution
to the group like any other pool top-up.

## Decision 7: leaving, removal, erasure and deletion

Settled inside the same transaction as the leave, removal, erasure or delete
(q7):

- **A positive group balance goes back** to the person's own balance: a
  `credit_back` row on each side.
- **A carved allowance is not money** and goes nowhere.
- **Seats are not refunded.**
- **Erasure** credits back to an account that is deleted in the same
  transaction, so in practice the money leaves with the person, exactly as their
  personal balance does. The group-side row stays, unattributed.
- **The pool on leaving** stays with the group. A top-up into the pool was a gift
  to the group (phase 50's own words), and dividing it up on every departure is
  the settlement problem §23.12 set out to avoid.

**The pool when a group is deleted (decided 2026-10-19)** goes back to the
current members in proportion to what each of them put into the pool over the
group's life (their `transfer_in` rows, including automatic top-ups in a carved
group), never more than they put in. Anything left over, for example credits an
operator granted, is closed off with a ledger row and goes nowhere. This answers
"what a member's share of a pool is on refund" with a figure every member can
check against the books.

**A debt when somebody leaves (decided 2026-10-19).** The leave screen shows the
debt and offers to pay it from the person's own credits. A debt is never taken
from a personal balance without the person choosing to.

**An unpaid debt becomes the group's, never the operator's.** The credits behind
a debt were real model costs the operator has already paid for, so cancelling a
debt outright would leave the operator out of pocket. Instead, leaving without
paying moves the debt onto the pool: a `debt_absorbed` row on each side, the
person's balance back to zero, the pool down by the same amount, and the whole
group able to see it in the books. Removal and erasure do the same, since
neither can wait for the person. If that takes the pool below zero, everything
the pool pays for is refused (the existing empty-pool refusal, which already
treats zero and below alike, and the digest's gate skips it) until somebody tops
it up.

**A group cannot be deleted while it owes credits.** Deletion first credits back
positive member balances and moves any remaining debts onto the pool, inside the
transaction. If the pool is then below zero, the delete is refused with the
amount, and the delete screen offers the admin the choice to pay it from their
own credits. The one case that cannot be refused is the last member erasing
their account, which deletes the group with it: there the shortfall is closed
off with a ledger row and a warning in the log. It is bounded by what one
group's members could run up before the pre-flight stopped them, and it is the
only route by which the operator absorbs a group's debt.

## Decision 8: the books

`GET /api/v1/resparkable/groups/[id]/books?weeks=` for **every joined member,
viewers included**, replacing the admin-only table in `getGroupBudget`. Weeks run
Monday to Sunday in the group's timezone, default the last 12.

Rows: per week, per category, per person, in credits. Categories:

- seats,
- operational costs (`createdByUserId` null),
- shared activity costs (the pool, or a split),
- own activity costs (a member's own balance),
- top-ups, by hand and automatic,
- credit-backs, and debts the group took over.

People are named from the account names the members routes already return,
never by address. Somebody no longer in the group shows as "a former member",
whether they left or were erased.

**What the books never contain**, asserted by 13n against the rendered page:
counts of items written, tasks finished or messages sent, any figure derived
from them, and any ordering by them. **People are listed by name, not by
amount**, so the books do not become a league table of spenders either. The
digest (13h) and the feed (13m) are untouched.

Admin-only controls (caps, alerts, settings) stay admin-only. Each member's own
figures (balance, allowance left, automatic top-up used this month) are shown to
that member.

## Known edges, accepted

- **A workflow run billed after its starter has left.** The queue's billing pass
  finds no membership to charge, and bills the pool. That is a switch of account,
  but not on an empty balance, and the alternative is a run nobody pays for.
  Short-lived, like phase 50's erasure gap.
- **Floating-point credits.** The ledger keeps exact figures and the screens
  round, as today. A split's last share absorbing the remainder is what keeps the
  sum exact.

## What this phase does not do

- **Real money.** Credits still come from an operator's grant or the new-user
  grant. Paying for credits is §18.10's forward note, not this phase.
- **Seat refunds, proration on role change, and per-member billing dates.**
- **Charging viewers for activity.** A viewer still cannot start a billed run.
- **Debt collection.** A debt the group took over is recorded in the books, not
  pursued, and does not follow the person into another group or back into this
  one.
- **Phase 64** (comments in the agent's context).

## Commit order

1. Migration: the group settings, the member columns, `memberUserId` on the
   ledger, B11 coverage, the export manifest. No behaviour change.
2. `resolveCharge` and the three activity modes; `recordAgentSpend` taking a plan;
   the equal split's single transaction; shortfall and suspension.
3. Operational modes, the payer fallback and its alert.
4. `group_cycle`: seats, carved allowances, automatic top-ups, joining mid-month.
5. Leaving, removal, erasure and deletion settling balances.
6. The books route and page; the old admin table removed.
7. Test 13n end to end; 13h and 13m re-run unchanged.
