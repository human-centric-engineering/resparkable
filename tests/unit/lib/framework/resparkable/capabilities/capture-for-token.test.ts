/**
 * Unit Tests: `resparkable_capture_for_token`.
 *
 * The one capability in the tier that does not trust `context.spaceId` — see
 * the class's own header for why. That inversion is what this file exists to
 * pin down: everywhere else, "who is this for" is a platform guarantee before
 * `run()` is ever reached; here it is two checks the capability makes itself,
 * and getting either wrong means either a stranger's inbox item lands in the
 * wrong brain or a legitimate one is silently dropped.
 *
 * The argument shape is the raw Postmark-adapter payload nested under
 * `trigger`, not a flattened one — see `agentCaptureForTokenSchema`'s header
 * comment for why `tool_call` steps receive `ctx.inputData` verbatim rather
 * than template-interpolated args.
 *
 * Test Coverage:
 * - `context.spaceId` is never read — the owner comes from `trigger.mailboxHash` alone
 * - An unknown token captures nothing and never reaches the contact lookup
 * - A `from.email` that doesn't match the resolved owner's email captures nothing
 * - An unverified account email refuses the message even if the address matches
 * - The match is case-insensitive (mail clients vary case; humans do too)
 * - A successful capture uses `source: 'email'` and the Postmark `messageId` as
 *   the dedupe key
 * - `strippedTextReply` wins over `textBody` when both are present
 * - A subject, when present, is prefixed onto the captured content
 * - An empty body (no strippedTextReply, no textBody) is refused before any lookup
 * - Provenance redacts the token, address and body; keeps the structural id
 *
 * @see lib/framework/resparkable/capabilities/capture-for-token.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/framework/resparkable/services/space', () => ({
  findSpaceByInboxToken: vi.fn(),
}));
vi.mock('@/lib/framework/resparkable/repo/owner-contact', () => ({ findOwnerContact: vi.fn() }));
vi.mock('@/lib/framework/resparkable/services/capture', () => ({ captureThought: vi.fn() }));

import { ResparkableCaptureForTokenCapability } from '@/lib/framework/resparkable/capabilities/capture-for-token';
import { findOwnerContact } from '@/lib/framework/resparkable/repo/owner-contact';
import { captureThought } from '@/lib/framework/resparkable/services/capture';
import { findSpaceByInboxToken } from '@/lib/framework/resparkable/services/space';
import type { CapabilityContext } from '@/lib/orchestration/capabilities/types';

const mockedSpace = vi.mocked(findSpaceByInboxToken);
const mockedContact = vi.mocked(findOwnerContact);
const mockedCapture = vi.mocked(captureThought);

const TOKEN = 'a'.repeat(32);

/** A workflow-driven context carrying a *different* userId than the space owner — the point being that it must never be consulted. */
const CONTEXT: CapabilityContext = { userId: 'someone_else', agentId: 'workflow:wf_1' };

function capability() {
  return new ResparkableCaptureForTokenCapability();
}

function args(trigger: Partial<Record<string, unknown>> = {}) {
  return capability().validate({
    trigger: {
      from: { email: 'owner@example.com' },
      mailboxHash: TOKEN,
      messageId: 'msg_123',
      strippedTextReply: 'Remember to renew the domain',
      ...trigger,
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedSpace.mockResolvedValue({ id: 'space_1', spaceId: 'user_owner' } as never);
  mockedContact.mockResolvedValue({
    email: 'owner@example.com',
    name: 'Owner',
    emailVerified: true,
  });
  mockedCapture.mockResolvedValue({
    thought: { id: 'thought_1', createdAt: new Date('2026-01-01T00:00:00Z') } as never,
    deduped: false,
  });
});

describe('resparkable_capture_for_token — owner resolution', () => {
  it('resolves the owner from trigger.mailboxHash, never from context.spaceId', async () => {
    const cap = capability();

    await cap.execute(args(), CONTEXT);

    expect(mockedSpace).toHaveBeenCalledWith(TOKEN);
    // The capture lands on the *space's* owner, not the context's.
    expect(mockedCapture).toHaveBeenCalledWith(
      expect.objectContaining({ spaceId: 'user_owner' }),
      expect.anything()
    );
  });

  it('runs even when context.spaceId is null — the platform guard other capabilities need does not apply here', async () => {
    const cap = capability();

    const result = await cap.execute(args(), { userId: null, agentId: 'workflow:wf_1' });

    expect(result.success).toBe(true);
  });

  it('refuses an unknown inbox token and never reaches the contact lookup', async () => {
    mockedSpace.mockResolvedValue(null);
    const cap = capability();

    const result = await cap.execute(args(), CONTEXT);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('unknown_inbox_token');
    expect(mockedContact).not.toHaveBeenCalled();
    expect(mockedCapture).not.toHaveBeenCalled();
  });
});

describe('resparkable_capture_for_token — sender verification', () => {
  it('refuses when From does not match the resolved owner’s email', async () => {
    const cap = capability();

    const result = await cap.execute(args({ from: { email: 'stranger@example.com' } }), CONTEXT);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('sender_mismatch');
    expect(mockedCapture).not.toHaveBeenCalled();
  });

  it('refuses when the account email is unverified, even if the address matches', async () => {
    mockedContact.mockResolvedValue({
      email: 'owner@example.com',
      name: 'Owner',
      emailVerified: false,
    });
    const cap = capability();

    const result = await cap.execute(args(), CONTEXT);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('sender_mismatch');
    expect(mockedCapture).not.toHaveBeenCalled();
  });

  it('refuses when the account is gone (contact lookup returns null)', async () => {
    mockedContact.mockResolvedValue(null);
    const cap = capability();

    const result = await cap.execute(args(), CONTEXT);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('sender_mismatch');
  });

  it('matches case-insensitively', async () => {
    const cap = capability();

    const result = await cap.execute(args({ from: { email: 'OWNER@EXAMPLE.COM' } }), CONTEXT);

    expect(result.success).toBe(true);
  });
});

describe('resparkable_capture_for_token — what gets captured', () => {
  it('captures with source: email and the Postmark messageId as the dedupe key', async () => {
    const cap = capability();

    await cap.execute(
      args({ strippedTextReply: 'Renew the domain', messageId: 'msg_abc' }),
      CONTEXT
    );

    expect(mockedCapture).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        content: 'Renew the domain',
        source: 'email',
        externalId: 'msg_abc',
      })
    );
  });

  it('prefers strippedTextReply over textBody when both are present', async () => {
    const cap = capability();

    await cap.execute(
      args({ strippedTextReply: 'Just the reply', textBody: 'Just the reply\n\n> quoted history' }),
      CONTEXT
    );

    expect(mockedCapture).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ content: 'Just the reply' })
    );
  });

  it('falls back to textBody when there is no stripped reply (a fresh message, not a reply)', async () => {
    const cap = capability();

    await cap.execute(
      args({ strippedTextReply: undefined, textBody: 'A brand new thought' }),
      CONTEXT
    );

    expect(mockedCapture).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ content: 'A brand new thought' })
    );
  });

  it('prefixes the subject onto the captured content when present', async () => {
    const cap = capability();

    await cap.execute(
      args({ subject: 'Domain renewal', strippedTextReply: 'Renew before Friday' }),
      CONTEXT
    );

    expect(mockedCapture).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ content: 'Domain renewal\n\nRenew before Friday' })
    );
  });

  it('reports the deduped flag from the underlying capture', async () => {
    mockedCapture.mockResolvedValue({
      thought: { id: 'thought_1', createdAt: new Date('2026-01-01T00:00:00Z') } as never,
      deduped: true,
    });
    const cap = capability();

    const result = await cap.execute(args(), CONTEXT);

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ deduped: true });
  });

  it('refuses an empty body before any lookup runs', async () => {
    const cap = capability();

    const result = await cap.execute(
      args({ strippedTextReply: undefined, textBody: undefined }),
      CONTEXT
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('empty_body');
    expect(mockedSpace).not.toHaveBeenCalled();
  });
});

describe('resparkable_capture_for_token — what it cannot be made to accept', () => {
  /**
   * A smuggled top-level `userId` is harmless rather than a validation error —
   * `ctx.inputData` is platform-constructed (`{ trigger: <adapter payload> }`),
   * not attacker-shaped, so there is nothing to defend against by rejecting
   * extra keys. What matters is that the field is never *read*: the owner
   * always comes from `trigger.mailboxHash`, asserted in the "owner
   * resolution" block above.
   */
  it('ignores an extraneous top-level field rather than rejecting the payload', () => {
    const cap = capability();

    expect(() =>
      cap.validate({
        trigger: {
          from: { email: 'owner@example.com' },
          mailboxHash: TOKEN,
          messageId: 'm1',
          strippedTextReply: 'hi',
        },
        spaceId: 'attacker_supplied',
      })
    ).not.toThrow();
  });

  it('rejects a payload missing the required trigger fields', () => {
    const cap = capability();

    expect(() => cap.validate({ trigger: { subject: 'no from, no mailboxHash' } })).toThrow();
  });
});

describe('resparkable_capture_for_token — provenance', () => {
  it('redacts the token, address and body; keeps the structural messageId', () => {
    const cap = capability();
    const parsed = args({ subject: 'Domain renewal', strippedTextReply: 'Renew before Friday' });

    const redaction = cap.redactProvenance(parsed, {
      success: true,
      data: { id: 'thought_1', deduped: false, capturedAt: '2026-01-01T00:00:00.000Z' },
    });

    const serialised = JSON.stringify(redaction.args);
    expect(serialised).not.toContain('Renew before Friday');
    expect(serialised).not.toContain('Domain renewal');
    expect(serialised).not.toContain(TOKEN);
    expect(serialised).not.toContain('owner@example.com');
    expect(redaction.args).toMatchObject({ messageId: 'msg_123' });
  });

  it('declares processesPii, restated because this class bypasses ResparkableCapability', () => {
    expect(capability().processesPii).toBe(true);
  });
});
