/**
 * Route Tests: `GET /groups/[id]/audit` (phase 58, §23.13).
 *
 * @see app/api/v1/resparkable/groups/[id]/audit/route.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth/guards', () => ({
  withAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    async (request: unknown, session: unknown, context: unknown) => {
      const { handleAPIError } = await import('@/lib/api/errors');
      try {
        return await handler(request, session, context);
      } catch (error) {
        return handleAPIError(error);
      }
    },
}));
vi.mock('@/lib/framework/resparkable/services/group-audit', () => ({ listGroupAudit: vi.fn() }));

import { GET } from '@/app/api/v1/resparkable/groups/[id]/audit/route';
import { listGroupAudit } from '@/lib/framework/resparkable/services/group-audit';

const SESSION = { user: { id: 'user_me' }, session: { userId: 'user_me' } };

function invoke(): Promise<Response> {
  return (GET as unknown as (...args: unknown[]) => Promise<Response>)(
    new Request('http://localhost/api/v1/resparkable/groups/grp_1/audit'),
    SESSION,
    { params: Promise.resolve({ id: 'grp_1' }) }
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/v1/resparkable/groups/[id]/audit', () => {
  it('404s for somebody who is not in the group, saying nothing about it', async () => {
    vi.mocked(listGroupAudit).mockResolvedValue({ ok: false, reason: 'not_a_member' });

    expect((await invoke()).status).toBe(404);
  });

  it('returns the entries the reader may see, and says which view it is', async () => {
    vi.mocked(listGroupAudit).mockResolvedValue({ ok: true, scope: 'about_you', entries: [] });

    const response = await invoke();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(listGroupAudit).toHaveBeenCalledWith('user_me', 'grp_1');
    expect(body.meta).toMatchObject({ count: 0, scope: 'about_you' });
  });
});
