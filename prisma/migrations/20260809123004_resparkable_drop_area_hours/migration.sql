-- Drop the per-area weekly hour target and the space-wide weekly capacity.
--
-- WHY THIS EXISTS
--
-- Resparkable asked users to set a weekly time target per life Area
-- (`targetWeeklyMinutes`) and an overall weekly hour budget
-- (`weeklyCapacityMinutes`), then scored every task partly on whether the
-- target was met (`areaBalance`, a weighted factor in `priority/score.ts`) and
-- warned when targets summed past capacity. That is productivity-optimisation
-- framing, not reflection — see
-- `.context/framework/resparkable/design-principles.md`. The scorer no longer
-- has an `areaBalance` term, its weight is redistributed across the remaining
-- five factors (`lib/framework/resparkable/settings.ts`), and nothing in the
-- product asks for or displays either number any more. Dropping the columns
-- rather than leaving them unused avoids a schema that still promises a
-- feature the UI no longer offers.
--
-- No backfill: both columns are plain scalars with no downstream data that
-- needs preserving elsewhere, and no other column derives from them.

ALTER TABLE "framework_resparkable_area" DROP COLUMN "targetWeeklyMinutes";

ALTER TABLE "framework_resparkable_space" DROP COLUMN "weeklyCapacityMinutes";
