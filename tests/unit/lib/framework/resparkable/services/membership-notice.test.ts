/**
 * Unit Tests: the "your membership changed" email (phase 58, §23.13).
 *
 * Sent only when somebody else did it, never thrown, never logged with an
 * address.
 *
 * @see lib/framework/resparkable/services/membership-notice.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/framework/resparkable/repo/owner-contact', () => ({ findOwnerContact: vi.fn() }));
vi.mock('@/lib/email/send', () => ({ sendEmail: vi.fn() }));
vi.mock('@/lib/logging', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

import { sendEmail } from '@/lib/email/send';
import { findOwnerContact } from '@/lib/framework/resparkable/repo/owner-contact';
import { sendMembershipChangedNotice } from '@/lib/framework/resparkable/services/membership-notice';
import { logger } from '@/lib/logging';

const SUBJECT = { email: 'priya@example.com', name: 'Priya', emailVerified: true };
const ADMIN = { email: 'sam@example.com', name: 'Sam', emailVerified: true };

function notice(kind: 'role_changed' | 'removed' | 'join_approved') {
  const change =
    kind === 'role_changed'
      ? ({ kind, from: 'member', to: 'viewer' } as const)
      : kind === 'removed'
        ? ({ kind } as const)
        : ({ kind, role: 'member' } as const);
  return {
    groupId: 'grp_1',
    groupName: 'Study group',
    actorUserId: 'user_sam',
    subjectUserId: 'user_priya',
    change,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(findOwnerContact).mockImplementation(async (scope) =>
    scope.spaceId === 'user_priya' ? SUBJECT : ADMIN
  );
  vi.mocked(sendEmail).mockResolvedValue({ success: true } as never);
});

describe('sendMembershipChangedNotice', () => {
  it.each([
    ['role_changed', 'Your role in Study group has changed'],
    ['removed', 'You have been removed from Study group'],
    ['join_approved', 'You have joined Study group'],
  ] as const)('emails the person affected for %s', async (kind, subject) => {
    await sendMembershipChangedNotice(notice(kind));

    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'priya@example.com', subject })
    );
  });

  it('never emails somebody about their own act', async () => {
    await sendMembershipChangedNotice({ ...notice('removed'), actorUserId: 'user_priya' });

    expect(findOwnerContact).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('sends nothing when the person has no address to send to', async () => {
    vi.mocked(findOwnerContact).mockResolvedValue(null);

    await sendMembershipChangedNotice(notice('removed'));

    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('logs an undelivered email by kind, without an address', async () => {
    vi.mocked(sendEmail).mockResolvedValue({ success: false } as never);

    await sendMembershipChangedNotice(notice('removed'));

    expect(logger.warn).toHaveBeenCalledWith('Resparkable membership notice not delivered', {
      groupId: 'grp_1',
      kind: 'removed',
    });
  });

  it('never throws, because the change already happened', async () => {
    vi.mocked(sendEmail).mockRejectedValue(new Error('provider down'));

    await expect(sendMembershipChangedNotice(notice('role_changed'))).resolves.toBeUndefined();
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain('@example.com');
  });
});
