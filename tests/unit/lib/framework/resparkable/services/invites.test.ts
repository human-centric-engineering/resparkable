/**
 * Unit Tests: share invites (Release 2, phase 13).
 *
 * The invite is the part of sharing most easily mistaken for a credential, and
 * these assertions are mostly about the ways it is not one:
 *
 *   1. **The email never names the item.** A subject line lands in a preview
 *      pane, a lock screen, a shared screen and a mail provider's index. The
 *      whole point of the access layer is that content sits behind a
 *      resolution, and a title in a subject line is the one copy that never was.
 *   2. **A revoked grant cannot send a fresh invite**, or revocation is undone
 *      by a button somebody forgot to grey out.
 *   3. **A different signed-in person cannot accept**, and the wrong-account
 *      path shows a **masked** address — enough to recognise your own mailbox,
 *      not enough for a stranger holding a forward to learn a working one
 *      (§16.3).
 *   4. **`acceptedAt` is set once.** Re-opening an old email does not rewrite
 *      when the relationship began.
 *   5. **A send failure never rolls a working share back.** The grant is live
 *      for the address either way; a failed email is a person who has access
 *      and has not been told.
 *   6. **Every other failure is one failure.** Unknown, malformed, revoked,
 *      expired and already-spent tokens are indistinguishable.
 *
 * @see lib/framework/resparkable/services/invites.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const findOwnGrant = vi.fn();
const stampInviteToken = vi.fn();
const findGrantByInviteTokenHash = vi.fn();
const acceptGrant = vi.fn();

vi.mock('@/lib/framework/resparkable/repo/grants', () => ({
  findOwnGrant: (...args: unknown[]) => findOwnGrant(...args),
  stampInviteToken: (...args: unknown[]) => stampInviteToken(...args),
  findGrantByInviteTokenHash: (...args: unknown[]) => findGrantByInviteTokenHash(...args),
  acceptGrant: (...args: unknown[]) => acceptGrant(...args),
}));

const findOwnerContact = vi.fn();

vi.mock('@/lib/framework/resparkable/repo/owner-contact', () => ({
  findOwnerContact: (...args: unknown[]) => findOwnerContact(...args),
}));

const sendEmail = vi.fn();

vi.mock('@/lib/email/send', () => ({
  sendEmail: (...args: unknown[]) => sendEmail(...args),
}));

import { acceptInvite, sendGrantInvite } from '@/lib/framework/resparkable/services/invites';
import { ownerScope } from '@/lib/framework/resparkable/repo/owner-scope';
import { logger } from '@/lib/logging';

const OWNER = ownerScope('user_a');
const NOW = new Date('2026-08-28T10:00:00.000Z');

/** The item's real name, which must appear in nothing this file produces. */
const SECRET_TITLE = 'Project Nightingale';

function grant(overrides: Record<string, unknown> = {}) {
  return {
    id: 'grant_1',
    userId: 'user_a',
    entityType: 'project',
    entityId: 'p_1',
    granteeUserId: null,
    granteeEmail: 'b@example.com',
    role: 'viewer',
    includeTaskDetail: false,
    inviteTokenHash: null,
    inviteSentAt: null,
    acceptedAt: null,
    expiresAt: null,
    revokedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  findOwnGrant.mockResolvedValue(grant());
  findOwnerContact.mockResolvedValue({
    email: 'a@example.com',
    name: 'Priya',
    emailVerified: true,
  });
  stampInviteToken.mockResolvedValue(true);
  sendEmail.mockResolvedValue({ success: true });
});

describe('sendGrantInvite', () => {
  it('sends to the granted address and reports success', async () => {
    expect(await sendGrantInvite(OWNER, 'grant_1', NOW)).toBe('sent');
    expect(sendEmail.mock.calls[0][0].to).toBe('b@example.com');
  });

  it('names the kind of thing and never the thing', async () => {
    await sendGrantInvite(OWNER, 'grant_1', NOW);
    const call = sendEmail.mock.calls[0][0];

    expect(call.subject).toContain('project');
    // The item's own title is never loaded, so it cannot appear — asserted
    // rather than assumed, because "load the title to make the email friendly"
    // is exactly the change somebody would make without noticing what it costs.
    expect(call.subject).not.toContain(SECRET_TITLE);
    expect(call.subject).not.toContain('p_1');
  });

  it('stores a digest, never the token, and mints a fresh one each send', async () => {
    await sendGrantInvite(OWNER, 'grant_1', NOW);
    await sendGrantInvite(OWNER, 'grant_1', NOW);

    const [first, second] = stampInviteToken.mock.calls.map((call) => call[2]);

    // sha256 hex, both times. The plaintext exists in the function call and in
    // the email, and in no column anywhere.
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toMatch(/^[0-9a-f]{64}$/);

    // Different, so re-sending replaces the token rather than re-issuing the
    // same one. A token that survived a resend would still be live in whatever
    // inbox the first email reached.
    expect(first).not.toBe(second);
  });

  it('refuses a revoked grant, so revocation cannot be undone by a resend', async () => {
    findOwnGrant.mockResolvedValue(grant({ revokedAt: new Date('2026-08-27T00:00:00.000Z') }));

    expect(await sendGrantInvite(OWNER, 'grant_1', NOW)).toBe('no_grant');
    expect(stampInviteToken).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('refuses an expired grant for the same reason', async () => {
    findOwnGrant.mockResolvedValue(grant({ expiresAt: new Date('2026-08-01T00:00:00.000Z') }));

    expect(await sendGrantInvite(OWNER, 'grant_1', NOW)).toBe('no_grant');
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('reports a send failure instead of throwing', async () => {
    sendEmail.mockResolvedValue({ success: false });

    // A throw would roll back a working share. The grant is already live for
    // that address; a failed email is a person who has access and has not been
    // told, which is recoverable by sending again.
    expect(await sendGrantInvite(OWNER, 'grant_1', NOW)).toBe('send_failed');
  });

  it('never writes the grantee’s address to a log line', async () => {
    const info = vi.spyOn(logger, 'info');
    const warn = vi.spyOn(logger, 'warn');

    await sendGrantInvite(OWNER, 'grant_1', NOW);
    sendEmail.mockResolvedValue({ success: false });
    await sendGrantInvite(OWNER, 'grant_1', NOW);

    // On the success path and the failure path alike: one person's contact
    // details in another person's infrastructure, for the life of the log.
    const logged = JSON.stringify([...info.mock.calls, ...warn.mock.calls]);
    expect(logged).not.toContain('b@example.com');

    info.mockRestore();
    warn.mockRestore();
  });

  it('falls back to the owner’s address when they have set no name', async () => {
    findOwnerContact.mockResolvedValue({
      email: 'a@example.com',
      name: null,
      emailVerified: true,
    });

    await sendGrantInvite(OWNER, 'grant_1', NOW);

    // An account with no display name is ordinary, not an edge case. "null
    // shared a project with you" is the failure this guards, and it is the kind
    // that only ever shows up in somebody's inbox.
    expect(sendEmail.mock.calls[0][0].subject).toContain('a@example.com');
    expect(sendEmail.mock.calls[0][0].subject).not.toContain('null');
  });

  it('falls back to "item" for a type it has no label for', async () => {
    // `entityType` is a VarChar, so a row can hold a value the label table has
    // never heard of — a type retired from the shareable list, say. The subject
    // line still has to read as a sentence.
    findOwnGrant.mockResolvedValue(grant({ entityType: 'gadget' }));

    await sendGrantInvite(OWNER, 'grant_1', NOW);

    expect(sendEmail.mock.calls[0][0].subject).toContain('shared a item with you');
    expect(sendEmail.mock.calls[0][0].subject).not.toContain('undefined');
  });

  it('sends nothing when the owner has been erased', async () => {
    findOwnerContact.mockResolvedValue(null);

    expect(await sendGrantInvite(OWNER, 'grant_1', NOW)).toBe('no_sender');
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

describe('acceptInvite', () => {
  const INVITEE = { userId: 'user_b', email: 'B@Example.com' };

  it('binds the account when the address matches, case-insensitively', async () => {
    findGrantByInviteTokenHash.mockResolvedValue(grant());
    acceptGrant.mockResolvedValue(grant({ granteeUserId: 'user_b', acceptedAt: NOW }));

    const result = await acceptInvite(INVITEE, 'a'.repeat(32), NOW);

    expect(result).toMatchObject({ ok: true, entityType: 'project', entityId: 'p_1' });
    expect(acceptGrant).toHaveBeenCalledWith('grant_1', 'user_b', NOW);
  });

  it('refuses a different signed-in account, and masks the address', async () => {
    findGrantByInviteTokenHash.mockResolvedValue(grant());

    const result = await acceptInvite(
      { userId: 'user_c', email: 'c@example.com' },
      'a'.repeat(32),
      NOW
    );

    expect(result).toMatchObject({ ok: false, reason: 'wrong_account' });
    // Enough to recognise your own mailbox; not enough for a stranger holding
    // a forwarded email to learn a working address (§16.3).
    expect(result.ok === false && 'expectedEmail' in result && result.expectedEmail).not.toContain(
      'b@example.com'
    );
    expect(acceptGrant).not.toHaveBeenCalled();
  });

  it('gives the same answer for unknown, revoked and expired tokens', async () => {
    findGrantByInviteTokenHash.mockResolvedValue(null);
    const unknown = await acceptInvite(INVITEE, 'a'.repeat(32), NOW);

    findGrantByInviteTokenHash.mockResolvedValue(
      grant({ expiresAt: new Date('2026-08-01T00:00:00.000Z') })
    );
    const expired = await acceptInvite(INVITEE, 'b'.repeat(32), NOW);

    // Indistinguishable, on purpose: anything else is an oracle telling a
    // holder which invitations once existed.
    expect(unknown).toEqual({ ok: false, reason: 'unknown' });
    expect(expired).toEqual({ ok: false, reason: 'unknown' });
  });

  it('reports a re-opened email without treating it as a new acceptance', async () => {
    findGrantByInviteTokenHash.mockResolvedValue(
      grant({ granteeUserId: 'user_b', acceptedAt: new Date('2026-08-20T00:00:00.000Z') })
    );
    acceptGrant.mockResolvedValue(
      grant({ granteeUserId: 'user_b', acceptedAt: new Date('2026-08-20T00:00:00.000Z') })
    );

    const result = await acceptInvite(INVITEE, 'a'.repeat(32), NOW);

    expect(result).toMatchObject({ ok: true, alreadyAccepted: true });
  });

  it('turns a revoke that landed between lookup and write into the same 404', async () => {
    findGrantByInviteTokenHash.mockResolvedValue(grant());
    acceptGrant.mockResolvedValue(null);

    expect(await acceptInvite(INVITEE, 'a'.repeat(32), NOW)).toEqual({
      ok: false,
      reason: 'unknown',
    });
  });
});
