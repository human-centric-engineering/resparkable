/**
 * App erasure cleanup-hook registrations (GDPR Art. 17).
 *
 * **Fork-owned scaffold** — Sunrise ships this empty and does NOT change it
 * after release, so your edits here merge cleanly on upgrade (the stable
 * contract is this file's export, not its body). Treat it like the other
 * `lib/app/*` seams.
 *
 * Auto-wired: `getErasureCleanupHooks()` (`lib/privacy/erasure-hooks.ts`) calls
 * this once before its first read, in the module graph `eraseUser()` runs in.
 * Add `registerErasureCleanupHook({ name, cleanupExternal?, scrubInTransaction? })`
 * calls for app data the FK cascade cannot reach: object-storage blobs, search
 * documents, and PII left on rows your `ON DELETE SET NULL` tables keep.
 *
 * Must be synchronous — register here, do the async work inside the hook.
 *
 * Full guide + example: .context/privacy/data-erasure.md · CUSTOMIZATION.md §4
 */
import { registerResparkableErasureHook } from '@/lib/framework/resparkable/privacy/erasure';

export function initAppErasureHooks(): void {
  // Resparkable's unaccepted invites and stored document originals: the two
  // things its cascade cannot reach.
  //
  // Registered here rather than at boot because core runs this seam itself,
  // before the first read, in whatever process is erasing somebody. A boot-time
  // registration only exists in a process that booted the app, and a smoke
  // script or worker that calls `eraseUser()` directly would skip the hook with
  // nothing to say so. Static import for the same reason as `lib/app/jobs.ts`.
  // A host project adds the same two lines; see
  // `.context/framework/resparkable/install.md` §2.13.
  registerResparkableErasureHook();
}
