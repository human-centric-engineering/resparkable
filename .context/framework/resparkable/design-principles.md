# Design principles

Resparkable is a **reflection and understanding tool, not an optimisation
tool.** This file exists because that distinction used to be implicit — and an
implicit principle gets eroded one reasonable-looking feature at a time. This
is the explicit version, and the record of the one place it was violated and
then corrected.

## What changed, and why

Through phase 10, `ResparkableArea` carried a `targetWeeklyMinutes` column —
a weekly hour quota per life domain (Health, Career…) — and
`ResparkableSpace` carried `weeklyCapacityMinutes`, an overall weekly hour
budget. Together they drove:

- **`areaBalance`**, 15% of every task's `priorityScore` in
  `priority/score.ts`: `clamp(1 - minutesThisWeekInArea / targetWeeklyMinutes, 0, 1)`.
  An area you hadn't logged time against that week floated its tasks above a
  hot work project.
- A **capacity meter** on the dashboard ("6h of 40h planned"), an
  over-capacity warning on the Areas page, and a "hours a week you actually
  have" settings field.
- A **stale-digest section** ("Areas with no time logged") that treated an
  area nobody had booked time against as a thing to be questioned.
- An **"AREA BALANCE"** block in the LLM chat context, reporting each area's
  minutes-this-week against its target, and naming the "most neglected" one.

All of it was removed in one pass rather than hidden behind a flag or left
dormant with the schema columns still in place. The reasoning: a wrong value
in `targetWeeklyMinutes` was invisible by design (`area-form.tsx`'s own
former doc comment said so — too high and an area's tasks sat at the top
permanently, too low and it silently stopped mattering), and the mechanism's
entire premise — that a life domain earns attention by having logged hours
against it — is a productivity-optimisation frame, not a reflection one. A
kill switch would have left the frame intact and merely unused; deleting the
columns, the formula term, and the copy is what actually retires it. See
`plan.md` §10 for the formula as it stands now, and the migration
`20260809123004_resparkable_drop_area_hours` for the schema change.

## The rule going forward

**Nothing in Resparkable asks a person to quantify their life in units of
time, and nothing scores a life domain, goal, or task by how much time was or
wasn't spent on it.** Concretely, before adding a field or a scorer factor,
check it against these:

- **No hour targets, quotas, or budgets** on Areas, Goals, or anything else a
  person names for themselves. `ResparkableSpace` has no capacity setting to
  compare anything against.
- **No "neglected" framing.** Nothing in the product tells a person that a
  part of their life or a goal they hold is being insufficiently attended to,
  computed from a clock. The stale digest asks about projects, goals and
  people going quiet — activity-shaped questions with a human "still live?"
  answer — deliberately not about Areas, which have no activity signal to
  ask that question from.
- **Time blocks stay descriptive, not evaluative.** `ResparkableTimeBlock`
  still exists — blocking out a day is a legitimate planning act, and
  `effortFit` still compares a task's estimate to the day's largest free gap.
  Tagging a block with an Area is an optional category for your own later
  reference, not an input to any weekly total, warning, or score.
  `sumMinutesByArea` was deleted along with its only callers; if a future
  change wants "minutes this week per area" back, that is exactly the
  question this document says no to.
- **A field earns its place by helping someone understand or say something,
  not by feeding a formula.** `ResparkableArea.description` is the model:
  free text, no shape, prompted with "why this matters right now" rather
  than "what belongs in here" — see `area-form.tsx`.

## What this does not rule out

Deadlines, `dueAt`, goal target dates, and project momentum all stay — they
describe commitments and real dates a person set for themselves, not a
capacity to be filled. The five remaining scorer factors
(`urgency`, `goalAlignment`, `projectMomentum`, `effortFit`, `staleness`) are
unchanged in kind, only reweighted to sum to 1 after `areaBalance`'s removal.
Prioritisation itself is not the thing this document objects to — a
deterministic ranking of what to do next is still useful. What it rules out
is any of that ranking being driven by a manufactured quota over a part of
someone's life.
