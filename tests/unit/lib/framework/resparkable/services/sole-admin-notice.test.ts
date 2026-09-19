/**
 * Unit Tests: the one-time email to a group's sole admin.
 *
 * What has to hold:
 *
 *   1. **Told once, and only once it went.** The flag is set after a
 *      successful send and not before, so a failed send is retried next pass
 *      rather than recorded as delivered.
 *   2. **One failure does not stop the rest.**
 *   3. **The email says what the group's setting will actually do**, and
 *      links to the group, where the setting lives.
 *   4. **No address in a log line.**
 *
 * @see lib/framework/resparkable/services/sole-admin-notice.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/framework/resparkable/repo/groups', () => ({
  listUnnotifiedSoleAdmins: vi.fn(),
  markSoleAdminNotified: vi.fn(),
}));
vi.mock('@/lib/email/send', () => ({
  sendEmail: vi.fn(),
}));
vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/components/resparkable/emails/sole-admin', () => ({
  SoleAdminEmail: vi.fn(() => null),
}));
vi.mock('@/lib/env', () => ({
  env: { NEXT_PUBLIC_APP_URL: 'https://app.example' },
}));

import { SoleAdminEmail } from '@/components/resparkable/emails/sole-admin';
import {
  listUnnotifiedSoleAdmins,
  markSoleAdminNotified,
} from '@/lib/framework/resparkable/repo/groups';
import { notifySoleAdmins } from '@/lib/framework/resparkable/services/sole-admin-notice';
import { sendEmail } from '@/lib/email/send';
import { logger } from '@/lib/logging';

const NOW = new Date('2026-09-19T10:00:00.000Z');

function admin(overrides: Record<string, unknown> = {}) {
  return {
    memberId: 'member_1',
    groupId: 'group_1',
    groupName: 'Study Group',
    viewersCanInheritAdmin: true,
    email: 'admin@example.com',
    name: 'Ada',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(sendEmail).mockResolvedValue({ success: true } as never);
});

describe('notifySoleAdmins', () => {
  it('emails each sole admin and records it only after the send', async () => {
    vi.mocked(listUnnotifiedSoleAdmins).mockResolvedValue([admin()]);

    const result = await notifySoleAdmins(5, NOW);

    expect(result).toEqual({ notified: 1, notifyFailed: 0 });
    expect(listUnnotifiedSoleAdmins).toHaveBeenCalledWith(5);
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'admin@example.com',
        subject: 'You are the only admin of Study Group',
      })
    );
    expect(markSoleAdminNotified).toHaveBeenCalledWith('member_1', NOW);
  });

  it('passes the group setting and an absolute link to the group into the email', async () => {
    vi.mocked(listUnnotifiedSoleAdmins).mockResolvedValue([
      admin({ viewersCanInheritAdmin: false }),
    ]);

    await notifySoleAdmins(5, NOW);

    expect(SoleAdminEmail).toHaveBeenCalledWith({
      groupName: 'Study Group',
      viewersCanInheritAdmin: false,
      groupUrl: 'https://app.example/resparkable/groups/group_1',
    });
  });

  it('does not record a send the provider refused, so the next pass retries it', async () => {
    vi.mocked(listUnnotifiedSoleAdmins).mockResolvedValue([admin()]);
    vi.mocked(sendEmail).mockResolvedValue({ success: false } as never);

    expect(await notifySoleAdmins(5, NOW)).toEqual({ notified: 0, notifyFailed: 1 });
    expect(markSoleAdminNotified).not.toHaveBeenCalled();
  });

  it('does not let one throwing send stop the rest, and logs no address', async () => {
    vi.mocked(listUnnotifiedSoleAdmins).mockResolvedValue([
      admin({ memberId: 'member_broken', groupId: 'group_broken' }),
      admin({ memberId: 'member_2', groupId: 'group_2', email: 'b@example.com' }),
    ]);
    vi.mocked(sendEmail)
      .mockRejectedValueOnce(new Error('Email system not configured'))
      .mockResolvedValueOnce({ success: true } as never);

    expect(await notifySoleAdmins(5, NOW)).toEqual({ notified: 1, notifyFailed: 1 });
    expect(markSoleAdminNotified).toHaveBeenCalledTimes(1);
    expect(markSoleAdminNotified).toHaveBeenCalledWith('member_2', NOW);
    expect(logger.warn).toHaveBeenCalledWith('Resparkable sole-admin notice failed for one group', {
      groupId: 'group_broken',
      error: 'Email system not configured',
    });
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain('@example.com');
  });

  it('sends nothing when nobody is waiting to be told', async () => {
    vi.mocked(listUnnotifiedSoleAdmins).mockResolvedValue([]);

    expect(await notifySoleAdmins()).toEqual({ notified: 0, notifyFailed: 0 });
    expect(sendEmail).not.toHaveBeenCalled();
  });
});
