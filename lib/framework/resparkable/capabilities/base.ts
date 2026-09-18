/**
 * The shared parent of every Resparkable capability.
 *
 * Its whole job is to make the two things that must never be forgotten
 * impossible to forget:
 *
 *   1. **A capability without a user does nothing.** `CapabilityContext.userId`
 *      is `string | null` — null for a system-initiated run with no owner — and
 *      a tool that shrugged and read "everything" would be the largest leak in
 *      the product. Subclasses implement {@link ResparkableCapability.run}, which
 *      receives an already-minted `SpaceScope` and has no way to ask for another
 *      one. There is no code path from a subclass to an unscoped read.
 *   2. **The user id is never an argument.** It arrives from the session
 *      (`withAuth`), from the MCP key's owner, or from the schedule row's `scope`
 *      column on a background run — the three places the platform sets it — and
 *      never from the model. No `agent*Schema` in `validations.ts` has a `userId`
 *      or a `scope` field, and `.strict()` makes an attempt to add one a
 *      validation error rather than a silent drop. (The schedule route read
 *      `execution.userId` until Resparkable 0.8.0 made scheduled runs system-owned;
 *      see {@link requireResparkableSpace}.)
 *
 * **What this file cannot do for you: `redactProvenance`.** Every Resparkable
 * capability sets `processesPii = true` (a brain is nothing *but* PII), and the
 * dispatcher's check is `Object.getPrototypeOf(instance).hasOwnProperty(...)` —
 * an own-property test on the *immediate* prototype. An override inherited from
 * this class would not satisfy it, and the registration would throw at boot.
 * That is the right outcome: each capability persists different things onto the
 * durable audit row, and "what of this is safe to keep for ever" is a decision
 * per tool, not per tier. The helpers below make writing one a line or two.
 */

import {
  RESPARKABLE_SCHEDULE_SPACE_KEY,
  readResparkableScheduleSpaceId,
  spaceScope,
  type SpaceScope,
} from '@/lib/framework/resparkable/repo/space-scope';
import {
  BaseCapability,
  type ProvenanceRedaction,
} from '@/lib/orchestration/capabilities/base-capability';
import { runAsSystemAuthored } from '@/lib/framework/resparkable/services/authorship';
import { resolveActiveSpaceScope } from '@/lib/framework/resparkable/services/membership';
import type { CapabilityContext, CapabilityResult } from '@/lib/orchestration/capabilities/types';
import type { ProvenanceItem } from '@/lib/orchestration/provenance/types';
import { redactedString } from '@/lib/security/redact';

/**
 * Thrown by {@link requireResparkableSpace}. Caught in {@link ResparkableCapability.execute}
 * and turned into a structured result — a capability that threw would surface to
 * the model as an unhandled dispatcher error rather than as something it can
 * explain to the user.
 */
export class MissingResparkableUserError extends Error {
  constructor() {
    super('Resparkable capabilities require a user context');
    this.name = 'MissingResparkableUserError';
  }
}

/**
 * The one place a capability's `SpaceScope` comes from.
 *
 * The owner arrives by one of two platform-set routes, never from an LLM
 * argument — which is what makes this the trust boundary rather than a
 * convenience:
 *
 *   1. **`context.userId`** — `streamChat` sets it from the session, the MCP
 *      protocol handler from the API key's owner.
 *   2. **`context.scope[RESPARKABLE_SCHEDULE_OWNER_KEY]`** — a scheduled run. Since
 *      Resparkable 0.8.0 (resparkable#502) the scheduler writes `userId: null` on every
 *      execution, so a background run reaches here system-owned and route 1 is
 *      empty. The owner travels on the schedule row's `scope` column instead;
 *      see {@link RESPARKABLE_SCHEDULE_OWNER_KEY} for why that column and what it
 *      costs.
 *
 * **Order matters, and this is the safe direction.** `context.userId` wins when
 * both are present. A session-authenticated turn is the stronger claim, so a
 * stale or mismatched scope on some future row cannot redirect a live user's
 * capability at another brain — the fallback only ever fills a gap.
 *
 * ## What phase 47 changed, and what it deliberately did not
 *
 * The two routes used to produce the same kind of value by accident: a person's
 * user id and their space key were the same string. From phase 46 they are not,
 * and a capability invoked in a group workspace has to read that workspace or
 * the agent layer answers questions about the wrong brain (§23.9). Sparkey is a
 * permanent pane, so this cannot wait for a later phase: the moment a member
 * opens a group space the agent layer is live.
 *
 * So route 1 gained a space, and it **resolves** rather than trusts it. The
 * space arrives as `ChatRequest.scope`, which core routes through `hintScope`
 * and names a hint because a consumer request body can set it. Membership
 * decides, on every turn, and the actor is still the session's.
 *
 * What did NOT change: **no capability accepts a space as an argument.** Every
 * `agent*Schema` is `.strict()` and none has such a field, for the same reason
 * none has a user id — a workspace named by a model is a workspace named by
 * whatever text the model has just read. `capabilities/scope.test.ts` sweeps
 * every handler for it.
 *
 * The other half of §23.9 is accepted rather than solved: inside one group, a
 * member's text can now reach another member's agent turn. That is a real
 * prompt-injection surface and it is not closable, because a shared brain whose
 * shared agent cannot read it is not a shared brain. §18.7's mitigation is the
 * one that applies: the agents reading group content have no destructive
 * capabilities bound, asserted at the seed level.
 *
 * Exported so a capability that needs the scope before validating (none do
 * today) can reach it directly; the base class calls it for everything else.
 */
export async function requireResparkableSpace(context: CapabilityContext): Promise<SpaceScope> {
  // ── Route 1: a person is acting, through an agent ──────────────────────────
  //
  // The actor is verified (`context.userId` comes from the session, never from
  // a model or a request body). The space is NOT: `ChatRequest.scope` reaches
  // capabilities through `hintScope`, which core names a hint precisely because
  // a consumer request body can set it. So it is resolved rather than trusted,
  // and `resolveActiveSpaceScope` reads membership and returns nothing for a
  // space this person is not in.
  //
  // That read is the price of a shared brain, and it is one indexed lookup on
  // `@@unique([groupId, userId])`, skipped entirely when there is no hint —
  // which is every turn for everybody in no group.
  //
  // **The new key only, and not `readResparkableScheduleSpaceId`.** That reader
  // also accepts the legacy `resparkableUserId`, which is right for a
  // pre-migration schedule row and wrong here: a stale schedule scope carrying
  // somebody else's user id would then be read as a space target for a live
  // turn, and the turn would fail rather than be ignored. The old code treated
  // `scope` as a fallback for a missing owner only, and that precedence is
  // preserved by reading a key the legacy carrier cannot spell.
  if (context.userId) {
    const hinted = context.scope?.[RESPARKABLE_SCHEDULE_SPACE_KEY];
    const spaceTarget = typeof hinted === 'string' && hinted.length > 0 ? hinted : null;

    const scope = await resolveActiveSpaceScope(context.userId, spaceTarget);
    // A hint naming a space they are not in resolves to nothing, and this is
    // the same refusal a missing owner gets rather than a quiet fallback to
    // their personal brain. Falling back would mean a model that read
    // "use workspace spc_x" in a document could silently redirect a turn, and
    // the person would see an answer about their own notes with no sign it had
    // been aimed elsewhere first.
    if (!scope) throw new MissingResparkableUserError();
    return scope;
  }

  // ── Route 2: nobody is watching ────────────────────────────────────────────
  //
  // A scheduled run arrives system-owned (`userId: null`, resparkable#502), and
  // its space travels on `AiWorkflowSchedule.scope`, which is admin-written and
  // stamped onto the execution. There is no actor to check membership against,
  // so the carrier IS the authority here, exactly as it was before phase 47.
  //
  // The tightening this wants and does not yet have is a
  // `context.scopeIsAuthoritative` check, which is the field core provides to
  // tell a platform-written carrier from a consumer-supplied one. It is not
  // added blind: getting it wrong silently stops every 04:30 run, and it needs
  // a test proving the scheduler path sets the flag before it can be trusted to
  // gate on it.
  const carried = readResparkableScheduleSpaceId(context.scope);
  if (carried) return spaceScope(carried);

  throw new MissingResparkableUserError();
}

/**
 * Is this call happening with nobody watching?
 *
 * **`workflowExecutionId` is the discriminator, not "is there an agent".** A
 * capability invoked from chat is the person acting *through* an agent — they
 * typed the question and are reading the answer — while a capability invoked
 * beneath a workflow step is a 03:00 cron with an LLM on the other end and no
 * owner in the room.
 *
 * The same predicate governs two unrelated things, and that is deliberate: the
 * authorship wrap in {@link ResparkableCapability.execute} (so a background run's
 * own output cannot wake the demand gate) and `excludeSensitive` on
 * `searchResparkable` (so a background run cannot read a note about someone's
 * health into a `ResparkableReview` body, which is shareable — plan §13). Two
 * copies of `Boolean(context.workflowExecutionId)` would eventually disagree
 * about what "background" means, and one of the two disagreements is a leak.
 */
export function isUnattendedRun(context: CapabilityContext): boolean {
  return Boolean(context.workflowExecutionId);
}

/**
 * The entity types a brain source can point at. Matches the tier's own
 * vocabulary rather than importing from validations — a provenance reference is
 * a display string, and coupling it to the Zod enum would make widening one a
 * breaking change to the other.
 */
export type ResparkableSourceType = string;

/**
 * Build a `sources` array for a capability's returned data.
 *
 * The engine lifts `output.sources` off a `tool_call` step onto the trace entry
 * (`lib/orchestration/provenance/types.ts`), which is what turns "the agent
 * suggested this" into "the agent suggested this because of these four notes" in
 * the approval and trace UI. The source *kind* is `knowledge_base`: core's enum
 * is a closed set whose members are a considered API decision, and the user's
 * own corpus is the closest true member — it is retrieved evidence surfaced into
 * the prompt, not the model's parametric knowledge. `reference` carries
 * `type:id` so a reader can find the row.
 *
 * Confidence tracks the retrieval score rather than being asserted: a hit at
 * 0.9 similarity and one scraping the floor are not equally good evidence, and a
 * flat `high` on both would make the pill decorative.
 */
export function brainSources(
  hits: readonly {
    entityType: ResparkableSourceType;
    id: string;
    score?: number;
    snippet?: string | null;
  }[]
): ProvenanceItem[] {
  return hits.slice(0, 64).map((hit) => {
    const item: ProvenanceItem = {
      source: 'knowledge_base',
      confidence: confidenceFor(hit.score),
      reference: `${hit.entityType}:${hit.id}`,
    };
    // A snippet is the excerpt that matched; skip it when there isn't one rather
    // than persisting an empty string the UI would render as a blank pill.
    const snippet = hit.snippet?.trim();
    if (snippet) item.snippet = snippet.slice(0, 400);
    return item;
  });
}

function confidenceFor(score: number | undefined): ProvenanceItem['confidence'] {
  if (score === undefined) return 'medium';
  if (score >= 0.7) return 'high';
  if (score >= 0.45) return 'medium';
  return 'low';
}

/**
 * Mask the free-text keys of an argument object, keep the structural ones.
 *
 * The line this draws is the one that matters for a brain: **prose out,
 * structure in.** A status, a horizon, a due date and a foreign key say what
 * happened and are worth keeping for ever; a title, a note body and a rationale
 * are the user's own words about their work, their health or the people around
 * them. Those are already stored in `framework_resparkable_*`, which erasure
 * reaches; persisting them onto `AiMessage.provenance` would put a second
 * permanent copy somewhere it does not.
 *
 * Keys absent from `args` stay absent — a masked key that was never sent would
 * make the audit row claim a field was supplied.
 */
export function maskFreeText<T extends object>(
  args: T,
  freeTextKeys: readonly (keyof T & string)[]
): Record<string, unknown> {
  const masked: Record<string, unknown> = Object.fromEntries(Object.entries(args));
  for (const key of freeTextKeys) {
    const value = masked[key];
    if (typeof value !== 'string') continue;
    masked[key] = redactedString(`${key}, ${value.length} chars`);
  }
  return masked;
}

/**
 * The audit-row shape for a capability whose *arguments* are safe to keep but
 * whose *result* is the user's own prose.
 *
 * Keeps the args verbatim (an id, a horizon — the "what was asked" an auditor
 * needs) and replaces the result with a sentinel plus a summary, so the row
 * records that something came back without copying the text into a second
 * durable store outside the brain's own tables.
 */
export function auditArgsKeepShape(args: unknown, summary: string): ProvenanceRedaction {
  return { args, resultPreview: JSON.stringify({ redacted: redactedString(summary) }) };
}

/**
 * Base class for the fourteen.
 *
 * Subclasses implement `run(args, scope, context)`. `execute` is final in intent
 * — overriding it would skip the scope resolution, which is the only thing this
 * class exists to guarantee.
 */
export abstract class ResparkableCapability<TArgs, TData> extends BaseCapability<TArgs, TData> {
  /**
   * Always true, and not a judgement call: a second brain holds free text about
   * the user's work, their health, their clients and the people in their life.
   * Every subclass therefore owes the dispatcher a `redactProvenance` override
   * (see the file header for why it cannot be inherited).
   */
  readonly processesPii = true;

  /**
   * Resolve the owner, mark the authorship, then delegate.
   *
   * The `catch` is narrow on purpose: a missing user is an expected condition
   * with a message worth showing, while anything else is a real fault and
   * belongs in the dispatcher's error path where it gets logged rather than
   * flattened into a tool result.
   *
   * **The authorship wrap is why this method is final in intent.** Every event
   * written beneath a workflow step has to be marked as system-authored, or the
   * demand gate reads a background run's own output as a reason to run again —
   * which is how an idle brain ends up billed nightly, silently, for ever (see
   * `services/authorship.ts`). Doing it here rather than in each writer means a
   * capability added later is covered without its author knowing: this is the
   * one place every capability call in the tier passes through.
   *
   * `workflowExecutionId` is the discriminator, not "is there an agent". A
   * capability invoked from **chat** is the person acting through an agent —
   * they asked for it — and must still wake a dormant brain.
   */
  async execute(args: TArgs, context: CapabilityContext): Promise<CapabilityResult<TData>> {
    let scope: SpaceScope;
    try {
      scope = await requireResparkableSpace(context);
    } catch (error) {
      if (!(error instanceof MissingResparkableUserError)) throw error;
      return this.error(
        'This tool reads and writes one person’s notes, and this run has no owner. It cannot be used from a system-initiated run.',
        'no_user_context'
      );
    }

    if (isUnattendedRun(context)) {
      return runAsSystemAuthored(() => this.run(args, scope, context));
    }
    return this.run(args, scope, context);
  }

  protected abstract run(
    args: TArgs,
    scope: SpaceScope,
    context: CapabilityContext
  ): Promise<CapabilityResult<TData>>;
}
