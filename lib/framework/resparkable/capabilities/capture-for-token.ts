/**
 * `resparkable_capture_for_token` — the front door for inbound email.
 *
 * ## The one capability that does not trust `context.userId`
 *
 * Every other capability in the tier is unreachable without a resolved owner —
 * `ResparkableCapability.execute()` (`capabilities/base.ts`) guarantees that
 * before `run()` is ever called, and it is "the only thing this class exists to
 * guarantee." This capability cannot use it: a Postmark webhook has no session
 * and no MCP key, so there is no `context.userId` to resolve. It extends the
 * platform's `BaseCapability` directly instead and resolves its own owner from
 * `args.trigger.mailboxHash` — the one deliberate exception `plan.md` §8 calls
 * out.
 *
 * ## Why `args` is the raw trigger payload, not a flat `{ inboxToken, from, … }`
 *
 * See `agentCaptureForTokenSchema`'s own header — short version: `tool_call` is
 * the one step type with no template interpolation, so
 * `resparkable-capture-intake`'s step declares no `args`, and the engine falls
 * through to handing this capability `ctx.inputData` verbatim
 * (`{ trigger: <Postmark's normalised payload> }`).
 *
 * ## Two checks stand in for the session this capability doesn't have
 *
 *   1. **`mailboxHash` resolves to a space.** It carries the `+token` half of
 *      `brain+<token>@<domain>` — a 32-character bearer credential
 *      (`ResparkableSpace.inboxToken`) unknown to anyone but its owner.
 *   2. **`from.email` matches that owner's own verified account email**, case-
 *      insensitively. Postmark's webhook authenticates *Postmark* (Basic auth,
 *      `postmark.ts`), not the sender — anyone who learns the address can send
 *      to it, so this is the check that turns "an email arrived" into "an email
 *      arrived from the account holder."
 *
 * Failing either returns a structured error and captures nothing. There is no
 * partial-trust path.
 *
 * ## Not bound to any chat-reachable agent, and exposed over nothing else
 *
 * This capability is bound only to the intake agent
 * (`004-agent-capabilities.ts`), which is not in `RESPARKABLE_CHAT_AGENT_SLUGS`
 * — so no chat surface ever advertises it as a callable tool — and has no
 * `McpExposedTool` row, so MCP cannot reach it either (§7b's default-deny). The
 * only caller is the `tool_call` step in `resparkable-capture-intake`
 * (`workflows/definitions.ts`), which — like every `tool_call` step —
 * dispatches under a synthetic `workflow:${workflowId}` id, not a real agent's,
 * so the binding is a documentation and provenance boundary, not what actually
 * gates the dispatch. See `capture-channels.md` for the full picture.
 */

import { BaseCapability } from '@/lib/orchestration/capabilities/base-capability';
import type { ProvenanceRedaction } from '@/lib/orchestration/capabilities/base-capability';
import type {
  CapabilityContext,
  CapabilityFunctionDefinition,
  CapabilityResult,
} from '@/lib/orchestration/capabilities/types';
import {
  resparkableCapabilitySpec,
  RESPARKABLE_CAPABILITY_SLUGS,
} from '@/lib/framework/resparkable/capabilities/catalogue';
import { spaceScope } from '@/lib/framework/resparkable/repo/space-scope';
import { findOwnerContact } from '@/lib/framework/resparkable/repo/owner-contact';
import { captureThought } from '@/lib/framework/resparkable/services/capture';
import { findSpaceByInboxToken } from '@/lib/framework/resparkable/services/space';
import {
  agentCaptureForTokenSchema,
  type AgentCaptureForTokenInput,
} from '@/lib/framework/resparkable/validations';
import { logger } from '@/lib/logging';
import { maskEmail, redactedString } from '@/lib/security/redact';

const spec = resparkableCapabilitySpec(RESPARKABLE_CAPABILITY_SLUGS.captureForToken);

export interface CaptureForTokenResult {
  id: string;
  deduped: boolean;
  capturedAt: string;
}

/**
 * The five fields this capability actually reads, pulled out of the wire
 * shape once so `execute` and `redactProvenance` don't each repeat the
 * `strippedTextReply || textBody` fallback or the trim/subject logic.
 */
interface ParsedIntake {
  inboxToken: string;
  from: string;
  subject: string | undefined;
  text: string;
  messageId: string;
}

function parseIntake(args: AgentCaptureForTokenInput): ParsedIntake {
  const { trigger } = args;
  const subject = trigger.subject?.trim();
  return {
    inboxToken: trigger.mailboxHash.trim(),
    from: trigger.from.email.trim(),
    subject: subject ? subject : undefined,
    // Prefer the reply with quoted history stripped; fall back to the raw body
    // for a fresh message (Postmark only populates strippedTextReply on a reply).
    text: (trigger.strippedTextReply?.trim() || trigger.textBody?.trim() || '').slice(0, 100_000),
    messageId: trigger.messageId.trim(),
  };
}

export class ResparkableCaptureForTokenCapability extends BaseCapability<
  AgentCaptureForTokenInput,
  CaptureForTokenResult
> {
  readonly slug = spec.slug;
  readonly functionDefinition: CapabilityFunctionDefinition = spec.functionDefinition;
  protected readonly schema = agentCaptureForTokenSchema;
  /**
   * `ResparkableCapability` sets this for every other capability in the tier; this
   * one extends `BaseCapability` directly (see the file header) and so has to
   * restate it. An inbound email's address and body are exactly the free-text
   * PII the flag exists to flag.
   */
  readonly processesPii = true;

  /**
   * Every field here is either an attacker-reachable credential (`mailboxHash`),
   * an address (`from`), or the sender's own free text (`subject`, body) — the
   * same class of content `ResparkableCaptureCapability.redactProvenance` masks,
   * for the same reason: it is already stored in `ResparkableThought`, inside the
   * erasure cascade, and a second copy on `AiMessage.provenance` would sit
   * outside it. `messageId` is kept verbatim — it is Postmark's opaque id, not
   * anyone's content, and an auditor needs it to correlate a capture with the
   * webhook delivery that produced it.
   */
  redactProvenance(
    args: AgentCaptureForTokenInput,
    result: CapabilityResult<CaptureForTokenResult>
  ): ProvenanceRedaction {
    const parsed = parseIntake(args);
    return {
      args: {
        inboxToken: redactedString('bearer token'),
        from: maskEmail(parsed.from),
        ...(parsed.subject
          ? { subject: redactedString(`subject, ${parsed.subject.length} chars`) }
          : {}),
        text: redactedString(`body, ${parsed.text.length} chars`),
        messageId: parsed.messageId,
      },
      resultPreview: JSON.stringify(result),
    };
  }

  /**
   * Ignores `context.userId` entirely — see the file header. `context` is kept
   * in the signature only because `BaseCapability.execute` requires it; nothing
   * here reads it.
   */
  async execute(
    args: AgentCaptureForTokenInput,
    _context: CapabilityContext
  ): Promise<CapabilityResult<CaptureForTokenResult>> {
    const parsed = parseIntake(args);

    if (!parsed.text) {
      return this.error(
        'The message had no readable text. The message was not captured.',
        'empty_body'
      );
    }

    const space = await findSpaceByInboxToken(parsed.inboxToken);
    if (!space) {
      logger.warn('Resparkable inbound capture — unknown inbox token', {
        messageId: parsed.messageId,
      });
      return this.error(
        'This inbox token does not match any account. The message was not captured.',
        'unknown_inbox_token'
      );
    }

    const scope = spaceScope(space.spaceId);
    const contact = await findOwnerContact(scope);

    if (!contact?.emailVerified || contact.email.toLowerCase() !== parsed.from.toLowerCase()) {
      logger.warn('Resparkable inbound capture — sender did not match the account', {
        messageId: parsed.messageId,
        userId: space.spaceId,
      });
      return this.error(
        'The sender did not match the account’s verified email. The message was not captured.',
        'sender_mismatch'
      );
    }

    const content = parsed.subject ? `${parsed.subject}\n\n${parsed.text}` : parsed.text;

    const { thought, deduped } = await captureThought(scope, {
      content,
      source: 'email',
      externalId: parsed.messageId,
    });

    logger.info('Resparkable inbound capture', {
      userId: space.spaceId,
      deduped,
    });

    return this.success({
      id: thought.id,
      deduped,
      capturedAt: thought.createdAt.toISOString(),
    });
  }
}
