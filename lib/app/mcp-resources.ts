/**
 * App MCP resource-handler registrations.
 *
 * **Fork-owned scaffold** — Sunrise ships this empty and does NOT change it
 * after release, so your edits here merge cleanly on upgrade (the stable
 * contract is this file's export, not its body). Treat it like the other
 * `lib/app/*` seams.
 *
 * Auto-wired: `resource-registry.ts` calls this once before the first resource
 * dispatch and before the admin create route validates a new row (server
 * route-handler runtime) — the same realm both reads happen in, per the #462
 * split. Registering from `initApp()` would fill a map the MCP route never
 * reads.
 *
 * ## Why a resource rather than a tool
 *
 * MCP tools already have a fork seam (`lib/app/capabilities.ts`), and a read
 * path modelled as a tool works. It costs a tool call the host could have
 * avoided: a resource can be preloaded into context, subscribed to for
 * `updated` notifications, and kept out of a tool list that reads better when
 * it is all verbs. Register reads here and keep `lib/app/capabilities.ts` for
 * the things that write.
 *
 * @example
 * ```ts
 * import { registerMcpResourceHandler } from '@/lib/orchestration/mcp/resource-registry';
 * import { handleProjectPlan } from '@/lib/app/mcp/project-plan';
 *
 * export function initAppMcpResources(): void {
 *   registerMcpResourceHandler({
 *     resourceType: 'project_plan',
 *     uriScheme: 'hub',
 *     handler: handleProjectPlan,
 *   });
 * }
 * ```
 *
 * Then create the row (seed or `POST /api/v1/admin/orchestration/mcp/resources`)
 * with `uri: 'hub://projects/{id}/plan'` and `resourceType: 'project_plan'`.
 * Both the URI scheme and the type are checked against what you registered
 * here, so a row that could never dispatch is rejected at creation rather than
 * failing silently on first read.
 *
 * Rows still default to `isEnabled: false` and are still admin-created: this
 * seam widens what an admin can turn on, not who can turn it on.
 *
 * Full guide: CUSTOMIZATION.md §4 · .context/orchestration/mcp.md
 */
import { registerResparkableMcpResources } from '@/lib/framework/resparkable/mcp/resources';

export function initAppMcpResources(): void {
  // Resparkable's two brain resources, `resparkable://today` and
  // `resparkable://project/{slug}`. One call, not a pasted pair: Resparkable
  // owns the set, so a later release can add a third without every host project
  // editing this file.
  //
  // Static import on purpose, matching `lib/app/capabilities.ts`. This runs in
  // the server route-handler realm, from `resource-registry.ts` immediately
  // before the first read, and this repo IS the Resparkable tier so the path
  // always resolves. A host project adds the same two lines; see
  // `.context/framework/resparkable/install.md`.
  registerResparkableMcpResources();
}
