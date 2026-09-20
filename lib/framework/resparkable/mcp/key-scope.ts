/**
 * What shape of `McpApiKey.scope` Resparkable can actually read, and what
 * happens to a key carrying any other.
 *
 * ## The hole this closes
 *
 * `McpApiKey.scope` is an open `Json?` map. Core names no keys in it and reads
 * none: it re-validates the column against `mcpKeyScopeSchema` (a flat
 * string-to-string map, nothing more) and hands whatever survives to the
 * dispatcher as an authoritative carrier. So an admin minting a key by hand at
 * `/admin/orchestration/mcp/keys` can type any key name at all, and the column
 * will hold it.
 *
 * Resparkable reads exactly one key, `resparkableSpaceId`, and only through
 * `requireResparkableSpace()`. That leaves two ways for a well-meant key to go
 * wrong, and they fail very differently:
 *
 *   • **Wrong key name**, say `{ spaceId: 'spc_x' }`. The reader looks for
 *     `resparkableSpaceId`, finds nothing, and takes the no-hint path: the
 *     person's **default** workspace. The key works. Every capability runs. It
 *     just runs against the wrong brain, and a capture made through it lands in
 *     an inbox nobody was watching. Nothing anywhere says so, and the key looks
 *     correctly scoped in the admin list. This is the dangerous one.
 *   • **Right name, wrong value** (a slug rather than an id, or a space the
 *     person is not in). Membership resolution returns nothing and every call
 *     fails, but as `MissingResparkableUserError`, whose message reads "this
 *     capability needs a user" rather than "your key names a workspace you are
 *     not in". Correct refusal, useless diagnosis.
 *
 * So Resparkable states its own shape rather than leaving core's open map to be
 * read by inference. A carrier this tier cannot read is **refused**, with the
 * fix in the message. The wrong answer is not the expensive failure here; the
 * silently-plausible one is.
 *
 * ## The three readings
 *
 * | Carrier                              | Reading                                    |
 * | ------------------------------------ | ------------------------------------------ |
 * | `NULL` or `{}`                       | unscoped: acts in the person's default     |
 * | `{ resparkableSpaceId: <space id> }` | scoped: the only shape a person's key gets |
 * | anything else                        | unusable: the dispatch is refused          |
 *
 * `unscoped` stays usable deliberately. It is what every admin-minted service
 * key has carried since before this tier had workspaces, it resolves through
 * the same membership read as everything else, and breaking it would be a
 * change to keys that are working exactly as intended.
 *
 * ## The legacy carrier is unusable, and that is not an oversight
 *
 * `readResparkableScheduleSpaceId()` accepts `resparkableUserId` as well, for
 * the pre-phase-45 schedule rows it was written for. This classifier does not,
 * and a key carrying only that key is `unusable`.
 *
 * It is worth being exact about what that costs, because such a key does work
 * today: `requireResparkableSpace()` route 1 reads the new key **only**, so the
 * legacy value is ignored, the no-hint path runs, and the key lands in the
 * person's default workspace. On an install where that person has one
 * workspace, the default IS the space the admin meant. The key is right by
 * coincidence and would be wrong the moment they joined a group.
 *
 * Refusing it turns a coincidence into an error message naming the key to use.
 * That is the trade this whole module is: one admin PATCH now, against a class
 * of failure that otherwise surfaces as captures going quietly missing.
 *
 * ## Unattended runs pass through untouched
 *
 * A scheduled run's `AiWorkflowExecution.scope` is authoritative too, and it is
 * emphatically not this shape: it carries the schedule's own keys, both
 * spellings of the owner key among them. Classifying it would refuse it, and
 * refusing it stops every 04:30 briefing in the install at once. So the guard
 * asks {@link isUnattendedRun} first and classifies only what is left.
 *
 * `workflowExecutionId` is the discriminator rather than "did this come from
 * MCP", because there is no MCP marker on `CapabilityContext` and inventing one
 * would mean a core change. The two populations this has to tell apart are
 * "a key, acting for a person who is awake" and "a cron with nobody watching",
 * and that is the question `isUnattendedRun` already answers for two other
 * decisions in this tier.
 *
 * ## Where the guard is attached, and what happens if it is not
 *
 * `capabilities/index.ts`, on every Resparkable registration, through
 * `registerAppCapability(capability, { guard })`. A capability registered
 * without it is a capability a mis-scoped key can still reach, which is why
 * `key-scope-roster.test.ts` fails when one is missing rather than leaving that
 * to review.
 *
 * Core runs a guard after the per-agent binding gate and before the rate-limit
 * gate, so a refused dispatch consumes no rate token, and a guard that throws
 * fails **closed**. Both are core's behaviour, not this module's, and both are
 * the right way round for a guard whose job is to restrict.
 */

import { isUnattendedRun } from '@/lib/framework/resparkable/capabilities/base';
import { RESPARKABLE_SCHEDULE_SPACE_KEY } from '@/lib/framework/resparkable/repo/space-scope';
import { mcpKeyScopeSchema } from '@/lib/validations/mcp';
import type { CapabilityContext, CapabilityGuard } from '@/lib/orchestration/capabilities/types';

/**
 * How this tier reads one key's scope carrier.
 *
 * A discriminated union rather than a bare string, because two of the three
 * readings carry something the caller needs: the space a scoped key names, and
 * the key names that made an unusable one unusable. A caller that got back
 * `'unusable'` and had to re-derive the offending keys to write the message
 * would be classifying twice.
 */
export type ResparkableKeyScope =
  | { kind: 'unscoped' }
  | { kind: 'scoped'; spaceId: string }
  | { kind: 'unusable'; unknownKeys: string[] };

/**
 * Read a key's scope carrier the way this tier reads it.
 *
 * Takes the already-validated `Record<string, string>` core produces, not the
 * raw `Json?` column: by the time a carrier reaches a capability it has been
 * through `mcpKeyScopeSchema`, and a second parse here would be a second
 * definition of what a scope map is.
 *
 * **Every key is significant, not just the one this tier reads.** A carrier of
 * `{ resparkableSpaceId: 'spc_x', projectId: 'p1' }` is unusable rather than
 * scoped, even though the space is right there and readable. The extra key
 * means somebody believed it did something, and a scope map with an inert key
 * in it is a key whose minter and whose reader disagree about what it grants.
 * That disagreement is the failure this module exists to surface, so the
 * strict reading is the whole point rather than pedantry.
 */
export function classifyResparkableKeyScope(
  scope: Record<string, string> | null | undefined
): ResparkableKeyScope {
  if (!scope) return { kind: 'unscoped' };

  const keys = Object.keys(scope);
  if (keys.length === 0) return { kind: 'unscoped' };

  const unknownKeys = keys.filter((key) => key !== RESPARKABLE_SCHEDULE_SPACE_KEY).sort();
  if (unknownKeys.length > 0) return { kind: 'unusable', unknownKeys };

  // Only the known key is present. It still has to carry something: an empty
  // string would sail through `mcpKeyScopeSchema` and then resolve to no space
  // at all, which is the "right name, wrong value" failure with the least
  // informative value of all.
  const spaceId = scope[RESPARKABLE_SCHEDULE_SPACE_KEY];
  if (typeof spaceId !== 'string' || spaceId.length === 0) {
    return { kind: 'unusable', unknownKeys: [] };
  }

  return { kind: 'scoped', spaceId };
}

/**
 * The same reading, starting from the raw `Json?` column.
 *
 * Through `mcpKeyScopeSchema` first, exactly as `authenticateMcpRequest` does,
 * because that column is never used raw. The one place this differs from core:
 * a carrier that fails the parse is **unusable** here rather than unscoped.
 * Core drops a malformed scope and lets the key act unscoped, so a bad row
 * cannot lock a caller out of their own key; this tier is answering a different
 * question, "is this key one of ours, for this workspace", and the honest
 * answer about a carrier nobody can read is no.
 *
 * Used by the key service and by the erasure hook, so "a key this tier
 * considers its own" has one definition rather than two that drift.
 */
export function classifyStoredKeyScope(stored: unknown): ResparkableKeyScope {
  if (stored === null || stored === undefined) return { kind: 'unscoped' };

  const parsed = mcpKeyScopeSchema.safeParse(stored);
  if (!parsed.success) return { kind: 'unusable', unknownKeys: [] };

  return classifyResparkableKeyScope(parsed.data);
}

/**
 * The refusal message a caller sees, written for the person holding the key.
 *
 * Names the key to use and the keys that are wrong, and **no values**. The key
 * names came from the admin who minted the row, so returning them tells the
 * holder nothing they could not read off their own credential; the values could
 * be a space id belonging to somebody else's workspace, and core folds a
 * guard's `reason` into a client-facing message.
 */
export function unusableScopeReason(classification: {
  kind: 'unusable';
  unknownKeys: string[];
}): string {
  const fix = `this key's scope must be exactly { "${RESPARKABLE_SCHEDULE_SPACE_KEY}": "<workspace id>" }, or empty to act in your default workspace`;

  if (classification.unknownKeys.length === 0) {
    return `The workspace on this key is blank, so ${fix}. Generate a new key from Settings, or ask an administrator to correct this one.`;
  }

  const named = classification.unknownKeys.map((key) => `"${key}"`).join(', ');
  return `This key's scope names ${named}, which Resparkable does not read, so ${fix}. Generate a new key from Settings, or ask an administrator to correct this one.`;
}

/**
 * The guard attached to every Resparkable capability registration.
 *
 * Three ways through, and the order matters:
 *
 *   1. **Unattended runs pass**, before anything is classified. See the module
 *      comment: a schedule's carrier is authoritative and is not this shape.
 *   2. **A non-authoritative carrier passes.** `scopeIsAuthoritative` is absent
 *      for a chat turn's scope, which core routes through `hintScope` and calls
 *      a hint precisely because a consumer request body sets it.
 *      `requireResparkableSpace()` already re-resolves that hint against
 *      membership on every turn and refuses a space the person is not in, so
 *      there is nothing here for this guard to add. Classifying it would mean
 *      refusing a live turn over a value the person did not choose and cannot
 *      correct.
 *   3. **Everything else is classified**, which in practice is an MCP key.
 *
 * Synchronous on purpose. It reads two fields off an object, and a guard that
 * touched the database would put a query in front of every tool call this tier
 * serves.
 */
export const refuseUnusableResparkableScope: CapabilityGuard = (context: CapabilityContext) => {
  if (isUnattendedRun(context)) return { allow: true };
  if (!context.scopeIsAuthoritative) return { allow: true };

  const classification = classifyResparkableKeyScope(context.scope);
  if (classification.kind !== 'unusable') return { allow: true };

  return { allow: false, reason: unusableScopeReason(classification) };
};
