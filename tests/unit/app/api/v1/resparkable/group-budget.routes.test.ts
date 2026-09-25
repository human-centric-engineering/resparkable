/**
 * Test 13k: the budget refuses before it spends (§23.12, phase 50).
 *
 * Asserted at the routes, with the **real** pre-flight and the real workspace
 * resolution, and counted by provider calls: `streamChat` and `ideate` are the
 * calls that spend, so "refused" means neither was invoked. Inspecting the
 * pre-flight's configuration would prove the rule is written down; counting
 * the calls proves it holds.
 *
 * What is mocked is only the storage underneath: the credit account and
 * ledger reads (`repo/billing`), and the membership row (`repo/groups`).
 *
 * The "never falls back to the member's own balance" half is asserted by the
 * accounts that were read and debited: exactly one, the group's, and never a
 * scope whose space is the member's personal one.
 *
 * @see lib/framework/resparkable/services/billing.ts
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

vi.mock('@/lib/orchestration/chat', () => ({ streamChat: vi.fn() }));
vi.mock('@/lib/framework/resparkable/services/ideate', () => ({ ideate: vi.fn() }));
vi.mock('@/lib/framework/resparkable/repo/groups', () => ({ findMembershipBySpace: vi.fn() }));
vi.mock('@/lib/framework/resparkable/services/space', () => ({ ensureResparkableSpace: vi.fn() }));
vi.mock('@/lib/framework/resparkable/repo/billing', () => ({
  ensureCreditAccount: vi.fn(),
  findCreditAccount: vi.fn(),
  applyLedgerEntryWithBalance: vi.fn(),
  sumMemberSpendSince: vi.fn(),
}));
vi.mock('@/lib/framework/resparkable/repo/billing-settings', () => ({
  findResparkableBillingSettings: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/lib/logging/context', () => ({
  getRequestId: vi.fn().mockResolvedValue('req_1'),
  getVisitorId: vi.fn().mockResolvedValue('vis_1'),
}));

import { POST as chatPOST } from '@/app/api/v1/resparkable/chat/stream/route';
import { POST as ideatePOST } from '@/app/api/v1/resparkable/ideate/route';
import { RESPARKABLE_AGENT_SLUGS } from '@/lib/framework/resparkable/agents';
import {
  applyLedgerEntryWithBalance,
  ensureCreditAccount,
  sumMemberSpendSince,
} from '@/lib/framework/resparkable/repo/billing';
import { findMembershipBySpace } from '@/lib/framework/resparkable/repo/groups';
import { ideate } from '@/lib/framework/resparkable/services/ideate';
import { streamChat } from '@/lib/orchestration/chat';

const GROUP_SPACE = 'spc_group';
const SESSION = { user: { id: 'user_m' }, session: { userId: 'user_m' } };

function membership(overrides: Record<string, unknown> = {}) {
  const at = new Date('2026-09-01T10:00:00.000Z');
  return {
    id: 'mem_1',
    groupId: 'grp_1',
    userId: 'user_m',
    role: 'member',
    invitedByUserId: null,
    soleAdminNotifiedAt: null,
    dailyCreditCap: null,
    joinedAt: at,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

function request(path: string, body: unknown): Request {
  return {
    url: `http://localhost:3000/api/v1/resparkable/${path}?space=${GROUP_SPACE}`,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve(body),
    signal: new AbortController().signal,
  } as unknown as Request;
}

type Handler = (...args: unknown[]) => Promise<Response>;
const chat = () =>
  (chatPOST as unknown as Handler)(
    request('chat/stream', { message: 'hello', agentSlug: RESPARKABLE_AGENT_SLUGS.companion }),
    SESSION,
    {}
  );
const ideateCall = () =>
  (ideatePOST as unknown as Handler)(
    request('ideate', { seedType: 'project', seedId: 'clx0000000000000000000000' }),
    SESSION,
    {}
  );

/** Every space whose account the request read or wrote. */
function accountsTouched(): string[] {
  return [
    ...vi.mocked(ensureCreditAccount).mock.calls.map(([scope]) => scope.spaceId),
    ...vi.mocked(applyLedgerEntryWithBalance).mock.calls.map(([scope]) => scope.spaceId),
  ];
}

async function* doneEvent(): AsyncGenerator<unknown> {
  yield { type: 'start', conversationId: 'conv_1', messageId: 'msg_1' };
  yield { type: 'done', tokenUsage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0.5 };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(findMembershipBySpace).mockResolvedValue(membership() as never);
  vi.mocked(ensureCreditAccount).mockResolvedValue({ id: 'acct_g', balanceCredits: 10 } as never);
  vi.mocked(sumMemberSpendSince).mockResolvedValue(0);
  vi.mocked(applyLedgerEntryWithBalance).mockResolvedValue({
    entry: { id: 'ledger_1' },
    balanceAfter: 8,
  } as never);
  vi.mocked(streamChat).mockReturnValue(doneEvent() as never);
});

describe('test 13k: an empty group balance', () => {
  beforeEach(() => {
    vi.mocked(ensureCreditAccount).mockResolvedValue({ id: 'acct_g', balanceCredits: 0 } as never);
  });

  it('refuses a chat turn with zero provider calls and never touches the member’s own account', async () => {
    const response = await chat();

    expect(response.status).toBe(402);
    expect(streamChat).not.toHaveBeenCalled();
    expect(accountsTouched()).toEqual([GROUP_SPACE]);
  });

  it('refuses ideate the same way', async () => {
    const response = await ideateCall();

    expect(response.status).toBe(402);
    expect(ideate).not.toHaveBeenCalled();
    expect(accountsTouched()).toEqual([GROUP_SPACE]);
  });
});

describe('test 13k: a member at their daily cap', () => {
  it('is refused before the provider call, with a message that is about them', async () => {
    vi.mocked(findMembershipBySpace).mockResolvedValue(membership({ dailyCreditCap: 3 }) as never);
    vi.mocked(sumMemberSpendSince).mockResolvedValue(3);

    const response = await chat();
    const payload = await response.json();

    expect(response.status).toBe(402);
    expect(payload.error.code).toBe('DAILY_CREDIT_CAP_REACHED');
    expect(streamChat).not.toHaveBeenCalled();
  });
});

describe('test 13k: a viewer', () => {
  it('is refused every billed action, whatever the balance', async () => {
    vi.mocked(findMembershipBySpace).mockResolvedValue(membership({ role: 'viewer' }) as never);

    expect((await chat()).status).toBe(403);
    expect((await ideateCall()).status).toBe(403);
    expect(streamChat).not.toHaveBeenCalled();
    expect(ideate).not.toHaveBeenCalled();
    expect(applyLedgerEntryWithBalance).not.toHaveBeenCalled();
  });
});

describe('a group turn that can pay', () => {
  it('debits the group, attributed to the member who spent', async () => {
    const response = await chat();
    // Drain the stream: the debit is written when `done` passes through.
    await response.text();

    expect(streamChat).toHaveBeenCalledTimes(1);
    const [scope] = vi.mocked(applyLedgerEntryWithBalance).mock.calls[0] ?? [];
    expect(scope).toMatchObject({ spaceId: GROUP_SPACE, actorUserId: 'user_m' });
    expect(accountsTouched().every((spaceId) => spaceId === GROUP_SPACE)).toBe(true);
  });
});
