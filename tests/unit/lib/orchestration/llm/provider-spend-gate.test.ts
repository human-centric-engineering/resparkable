/**
 * The call-time spend gate, wired into the provider manager (§110 t-788).
 *
 * Every vendor-reaching call on a manager-built provider is held to the org's
 * and the global monthly cap inside the Proxy, beside the eligibility gate.
 * These tests drive the manager directly, as `provider-call-gate.test.ts`
 * does, so a refusal here is the Proxy's: no chat pre-check, workflow step or
 * evaluation had a chance to stop the call first. That is the point of the
 * gate: those other callers never checked the caps at all.
 *
 * @see lib/orchestration/llm/spend-caps.ts — assertWithinSpendCaps
 * @see lib/orchestration/llm/provider-manager.ts — withInFlightTracking
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockMode = vi.hoisted(() => ({ value: 'single' }));
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: new Proxy(actual.env, {
      get: (target, key) =>
        key === 'TENANCY_MODE' ? mockMode.value : (Reflect.get(target, key) as unknown),
    }),
  };
});

const db = vi.hoisted(() => ({
  aiProviderConfig: { findFirst: vi.fn(), findMany: vi.fn() },
  aiCostLog: { aggregate: vi.fn() },
  aiOrchestrationSettings: { findUnique: vi.fn() },
  org: { findUnique: vi.fn() },
}));
vi.mock('@/lib/db/client', () => ({ prisma: db }));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  clearCache,
  getProvider,
  getProviderWithFallbacks,
  isLocalProvider,
  registerProviderInstance,
} from '@/lib/orchestration/llm/provider-manager';
import { resetProviderEligibility } from '@/lib/orchestration/llm/provider-eligibility';
import { isRequestFault, type LlmProvider } from '@/lib/orchestration/llm/provider';
import { resetAllBreakers } from '@/lib/orchestration/llm/circuit-breaker';
import { __resetInFlightCountersForTests } from '@/lib/orchestration/llm/in-flight-counter';
import { forgetOrgProviderPolicy } from '@/lib/orchestration/llm/org-provider-policy';
import { SpendCapExceededError, forgetSpendCaps } from '@/lib/orchestration/llm/spend-caps';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';

/** A provider whose every vendor method is a spy. */
function fakeProvider(name: string, isLocal: boolean) {
  const chat = vi
    .fn()
    .mockResolvedValue({ content: 'ok', usage: { inputTokens: 1, outputTokens: 1 } });
  const streamOpened = vi.fn();
  const embedMany = vi.fn().mockResolvedValue({ embeddings: [[0.1]] });
  const listModels = vi.fn().mockResolvedValue([]);
  const provider: LlmProvider = {
    name,
    isLocal,
    chat,
    chatStream: (): AsyncIterable<never> => {
      streamOpened();
      return (async function* () {
        yield* [];
      })();
    },
    embed: vi.fn().mockResolvedValue([0.1]),
    embedMany,
    transcribe: vi.fn().mockResolvedValue({ text: '' }),
    listModels,
    testConnection: vi.fn().mockResolvedValue({ ok: true, models: [] }),
  };
  return { provider, chat, streamOpened, embedMany, listModels };
}

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _chunk of stream) {
    // nothing
  }
}

/** Put the install org (the one org at `single`) at `spent` against a cap of `cap`. */
function installOrgAt(spent: number, cap: number | null) {
  db.org.findUnique.mockResolvedValue({
    settings: cap === null ? null : { quotas: { monthlyBudgetUsd: cap } },
  });
  db.aiCostLog.aggregate.mockResolvedValue({ _sum: { totalCostUsd: spent } });
}

beforeEach(() => {
  vi.clearAllMocks();
  clearCache();
  forgetOrgProviderPolicy();
  forgetSpendCaps();
  resetProviderEligibility();
  resetAllBreakers();
  __resetInFlightCountersForTests();
  mockMode.value = 'single';
  db.aiOrchestrationSettings.findUnique.mockResolvedValue({ globalMonthlyBudgetUsd: null });
  installOrgAt(0, null);
});

describe('the provider manager holds every gated call to the spend caps', () => {
  it('refuses a paid chat call over the org cap before it reaches the vendor', async () => {
    const paid = fakeProvider('paid', false);
    registerProviderInstance('paid', paid.provider);
    installOrgAt(120, 100);

    const provider = await getProvider('paid');
    const err = await provider.chat([], { model: 'm' }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SpendCapExceededError);
    expect(isRequestFault(err)).toBe(true);
    expect(paid.chat).not.toHaveBeenCalled(); // test-review:accept no_arg_called — refused before the vendor
  });

  it('refuses a paid stream before it is opened', async () => {
    const paid = fakeProvider('paid', false);
    registerProviderInstance('paid', paid.provider);
    db.aiOrchestrationSettings.findUnique.mockResolvedValue({ globalMonthlyBudgetUsd: 50 });
    installOrgAt(50, null);

    const provider = await getProvider('paid');

    await expect(drain(provider.chatStream([], { model: 'm' }))).rejects.toMatchObject({
      code: 'global_budget_exceeded',
    });
    expect(paid.streamOpened).not.toHaveBeenCalled(); // test-review:accept no_arg_called — no connection opened
  });

  it('refuses paid embeddings too: ingestion spends against the same cap', async () => {
    const paid = fakeProvider('paid', false);
    registerProviderInstance('paid', paid.provider);
    installOrgAt(10, 10);

    const provider = await getProvider('paid');

    await expect(provider.embedMany!(['a'], { model: 'e' })).rejects.toBeInstanceOf(
      SpendCapExceededError
    );
    expect(paid.embedMany).not.toHaveBeenCalled(); // test-review:accept no_arg_called — refused before the vendor
  });

  it('lets a local provider through over the cap, even a cap of 0', async () => {
    const local = fakeProvider('local', true);
    registerProviderInstance('local', local.provider);
    installOrgAt(0, 0);

    const provider = await getProvider('local');
    await provider.chat([], { model: 'm' });
    await drain(provider.chatStream([], { model: 'm' }));

    expect(local.chat).toHaveBeenCalledTimes(1);
    expect(local.streamOpened).toHaveBeenCalledTimes(1);
  });

  it('lets a paid call through under the cap', async () => {
    const paid = fakeProvider('paid', false);
    registerProviderInstance('paid', paid.provider);
    installOrgAt(99, 100);

    const provider = await getProvider('paid');
    await provider.chat([], { model: 'm' });

    expect(paid.chat).toHaveBeenCalledTimes(1);
    expect(db.org.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: INSTALL_ORG_ID } })
    );
  });

  it('leaves the ungated admin metadata calls alone', async () => {
    const paid = fakeProvider('paid', false);
    registerProviderInstance('paid', paid.provider);
    installOrgAt(500, 100);

    const provider = await getProvider('paid');
    await provider.listModels();

    expect(paid.listModels).toHaveBeenCalledTimes(1);
  });
});

describe('isLocalProvider', () => {
  it('reports a registered provider as it describes itself', async () => {
    registerProviderInstance('local', fakeProvider('local', true).provider);
    registerProviderInstance('paid', fakeProvider('paid', false).provider);

    await expect(isLocalProvider('local')).resolves.toBe(true);
    await expect(isLocalProvider('paid')).resolves.toBe(false);
  });

  it('treats a provider it cannot resolve as paid', async () => {
    db.aiProviderConfig.findFirst.mockResolvedValue(null);

    await expect(isLocalProvider('nowhere')).resolves.toBe(false);
  });

  it("reads the row's flag, so a local row whose credential cannot be resolved is still local", async () => {
    // Building this client would fail (an anthropic row with no key); reading
    // the flag builds nothing and asks no credential resolver.
    db.aiProviderConfig.findFirst.mockResolvedValueOnce({
      isLocal: true,
      providerType: 'anthropic',
    });

    await expect(isLocalProvider('local-proxy')).resolves.toBe(true);
    expect(db.aiProviderConfig.findFirst).toHaveBeenCalledWith({
      where: { slug: 'local-proxy' },
      select: { isLocal: true, providerType: true },
    });
  });

  it('matches a slug before a name, as the manager does', async () => {
    db.aiProviderConfig.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ isLocal: true, providerType: 'openai-compatible' });

    await expect(isLocalProvider('Local Ollama')).resolves.toBe(true);
    expect(db.aiProviderConfig.findFirst).toHaveBeenLastCalledWith({
      where: { name: 'Local Ollama' },
      select: { isLocal: true, providerType: true },
    });
  });

  it('never calls a Voyage row local: its flag only allows a loopback baseUrl', async () => {
    db.aiProviderConfig.findFirst.mockResolvedValueOnce({ isLocal: true, providerType: 'voyage' });

    await expect(isLocalProvider('voyage')).resolves.toBe(false);
  });
});

describe('getProviderWithFallbacks under a reached cap', () => {
  beforeEach(() => {
    registerProviderInstance('paid', fakeProvider('paid', false).provider);
    registerProviderInstance('paid-2', fakeProvider('paid-2', false).provider);
    registerProviderInstance('local', fakeProvider('local', true).provider);
  });

  it('passes over a paid primary the caps refuse to a local fallback', async () => {
    installOrgAt(120, 100);

    const { usedSlug, provider } = await getProviderWithFallbacks('paid', ['paid-2', 'local']);

    expect(usedSlug).toBe('local');
    expect(provider.isLocal).toBe(true);
  });

  it('answers with the cap when no candidate is local, not a retriable exhaustion', async () => {
    installOrgAt(120, 100);

    const err = await getProviderWithFallbacks('paid', ['paid-2']).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SpendCapExceededError);
    expect(err).toMatchObject({ code: 'org_budget_exceeded', retriable: false });
  });

  it('keeps the paid primary under the cap', async () => {
    installOrgAt(10, 100);

    const { usedSlug } = await getProviderWithFallbacks('paid', ['local']);

    expect(usedSlug).toBe('paid');
  });
});
