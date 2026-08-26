/**
 * Resparkable-declared server environment variables.
 *
 * Resparkable exports this schema from its own tier; the **host** merges it into
 * `appEnvSchema` in `lib/app/env.ts` with one line (see
 * `.context/framework/resparkable/install.md`). Resparkable deliberately does not own
 * `lib/app/env.ts` — that file is the *leaf* seam, and the host wants it for
 * its own variables too.
 *
 * `lib/env.ts` folds `appEnvSchema` into the same fail-fast startup parse as
 * the core variables, and rejects any key that collides with a core one — so
 * every key here must stay `RESPARKABLE_`-prefixed.
 *
 * **Every Resparkable variable is optional with a working default.** A host that
 * merges this schema and sets nothing must still boot: the module is installed
 * feature-by-feature across phases, and a required variable would turn "I
 * haven't reached that phase yet" into a startup crash.
 *
 * Variables arrive with the phase that reads them, not before:
 *   - `RESPARKABLE_INBOX_DOMAIN` — email-to-inbox capture (Release 1, phase 9)
 *   - `RESPARKABLE_GIT_ALLOWED_HOSTS` — git-remote allowlist (Release 4, phase 19)
 *   - `RESPARKABLE_WORKER_MODE` — job-queue topology (Release 1.5, phase 56)
 */
import { z } from 'zod';

export const resparkableEnvSchema = z.object({
  /**
   * Who drains the job queue: the maintenance tick, or standalone workers.
   *
   * `tick` (the default, and what you get by not setting this) drains a few
   * jobs inside the 60-second maintenance tick. One container, no extra
   * process, correct for anything up to a few thousand brains.
   *
   * `external` stops the tick draining, for an install running
   * `npm run framework:resparkable:worker` containers. Set it on the **web**
   * containers, not on the workers.
   *
   * **Both settings are correct; only one is faster.** The lease that makes
   * concurrent draining safe lives in the database, so a web container and six
   * workers all draining at once claim disjoint batches rather than racing —
   * leaving this unset on a scaled install costs contention, never double runs.
   * It is a throughput knob, which is why it has a working default and no
   * validation beyond the two names.
   *
   * `jobs.ts` reads `process.env` directly rather than going through the parsed
   * schema, because `registerResparkableJobs` is called lazily by core in
   * whichever realm the tick runs in. Declared here anyway so the variable is
   * documented in one place and a host merging this schema sees it.
   */
  RESPARKABLE_WORKER_MODE: z.enum(['tick', 'external']).optional(),
});

export type ResparkableEnv = z.infer<typeof resparkableEnvSchema>;
