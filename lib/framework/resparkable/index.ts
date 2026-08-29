/**
 * Resparkable — framework-tier entry point.
 *
 * This is the single module a host Resparkable project boots. `lib/app/bootstrap.ts`
 * imports it **dynamically** (`await import('@/lib/framework/resparkable')`) so that
 * a project without `lib/framework/` still builds — a *static* framework
 * specifier is resolved at `next build` and would break that project's build.
 * See CUSTOMIZATION.md §4 · the reserved `/framework` fork tier.
 *
 * `initResparkable()` runs once per server process, inside the try/catch
 * `instrumentation.ts` wraps around `initApp()`. Two consequences:
 *   - It must be **idempotent** — a re-import in a new process re-runs it.
 *   - It must not throw for recoverable conditions. A throw here is logged and
 *     swallowed by instrumentation, so Resparkable would be silently half-booted.
 *
 * Boot work belongs here only when it must happen before the first request
 * (registry registrations, schedule assurance). Anything derivable per-request
 * stays lazy.
 *
 * Resparkable then delegates to `initLeafApp()` in `lib/app/leaf-bootstrap.ts` —
 * the boot hook Resparkable re-exposes to the leaf forks built *on* Resparkable, so
 * they never have to contend with a host project over `lib/app/bootstrap.ts`.
 *
 * Registration order is deliberate: Resparkable's own registrations land first, so
 * a leaf fork can override or extend them from `initLeafApp()`.
 */
import { initLeafApp } from '@/lib/app/leaf-bootstrap';
import { registerResparkableErasureHook } from '@/lib/framework/resparkable/privacy/erasure';
import { registerBuiltInCapabilities } from '@/lib/orchestration/capabilities';
import { logger } from '@/lib/logging';

export async function initResparkable(): Promise<void> {
  // Context contributors and jobs are NOT registered here. Core re-initialises
  // each of those from its own consumer in the request realm (`buildContext`,
  // `app-jobs.ts:93`), so they are wired through their `lib/app/*` seams
  // instead — which is what makes them survive the instrumentation/route module
  // split (resparkable#462).
  //
  // **Capabilities used to be in that list, and the reasoning had a hole.**
  // Core's re-init is `registerBuiltInCapabilities()`, and it is called by the
  // chat handler, the MCP tool registry, `getCapabilityDefinitions()` and the
  // `agent_call` executor — but NOT by `executors/tool-call.ts`, which
  // dispatches straight into the registry. resparkable#462 made that registry a
  // `globalThis` singleton so a registration crosses realms, but the "have I
  // registered yet" guards (`registry.ts:78-80`) are ordinary module-scoped
  // booleans, so the registry is only ever filled when something *calls* the
  // initialiser.
  //
  // Nothing does, on a process that has served no chat, agent or MCP request.
  // So the scheduler firing a workflow of `tool_call` steps hits an empty
  // registry and every step fails with `unknown_capability` — which is all four
  // Resparkable background workflows, at 03:15 and 04:30, on a server that has been
  // quiet all night. The failure is likeliest exactly when it matters.
  //
  // Calling it here fills the shared registry at boot, before any tick. Safe to
  // call, and cheap: it is guarded by those booleans, `capabilityDispatcher.register`
  // is idempotent by key, and after the first call it costs one boolean check.
  // It also pulls in core's built-ins *and* Resparkable's own, because the function
  // runs `initAppCapabilities()` on the way through — so this is a complete fix
  // rather than one that covers only the tier's half.
  //
  // Interim: the real fix is one line in core's `tool-call.ts`, matching its
  // sibling `agent-call.ts:484`. Filed as resparkable#537; ask #31 in
  // `.context/framework/resparkable/sunrise-asks.md`. Remove this call when it lands
  // — leaving it would be harmless, but it would be dead weight at boot.
  registerBuiltInCapabilities();

  // **The erasure hook is back, for a different reason than it left.**
  //
  // It was deleted in phase 56 and the deletion was right: it existed because
  // `AiWorkflowSchedule.createdBy` is `onDelete: SetNull`, so an erased
  // person's four schedule rows survived them with a live `nextRunAt`, firing
  // for ever against a brain that no longer existed. The queue removed those
  // rows — `ResparkableJob` hangs off `ResparkableSpace`, so erasure became the
  // D1 cascade again: one FK, no code, no realm problem.
  //
  // Release 2 phase 14 brings back two things a cascade genuinely cannot do:
  // an **unaccepted invite**, which is addressed by email and so has no foreign
  // key to hang off, and **stored document originals**, which are object
  // storage and cannot enlist in a database transaction.
  //
  // The realm caveat the old comment recorded still stands and is worth
  // keeping: `lib/privacy/erasure-hooks.ts` is a plain module-scoped Map, so a
  // boot-time registration may not be present in the erasure request's realm
  // (sunrise#462 fixed exactly this for the contributor and capability
  // registries and did not reach this one; ask #34). What has changed is how
  // much rides on it. Every accepted grant and every comment an erased person
  // wrote is covered by a hand-written `ON DELETE CASCADE` — probes B8 and B9 —
  // which is a database constraint and cannot fail to run. This hook covers the
  // residue, and `lib/framework/resparkable/privacy/erasure.ts` says so at the
  // top rather than implying it is the whole of Art. 17.
  registerResparkableErasureHook();

  logger.debug('Resparkable framework tier booted');

  await initLeafApp();
}

export { resparkableEnvSchema } from '@/lib/framework/resparkable/env';
