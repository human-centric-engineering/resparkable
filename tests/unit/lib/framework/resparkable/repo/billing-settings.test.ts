/**
 * Unit Tests: the billing-settings repo, the singleton `ResparkableBillingSettings`
 * row (Phase 29). Same shape and the same property that matters as
 * `repo/settings.test.ts`: every read and write keys on the fixed `global`
 * slug, never on anything caller-supplied.
 *
 * @see lib/framework/resparkable/repo/billing-settings.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const findUnique = vi.fn();
const upsert = vi.fn();

vi.mock('@/lib/db/client', () => ({
  prisma: {
    resparkableBillingSettings: {
      findUnique: (...args: unknown[]) => findUnique(...args),
      upsert: (...args: unknown[]) => upsert(...args),
    },
  },
}));

import {
  findResparkableBillingSettings,
  RESPARKABLE_BILLING_SETTINGS_SLUG,
  upsertResparkableBillingSettings,
} from '@/lib/framework/resparkable/repo/billing-settings';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('RESPARKABLE_BILLING_SETTINGS_SLUG', () => {
  it('is the literal "global"', () => {
    expect(RESPARKABLE_BILLING_SETTINGS_SLUG).toBe('global');
  });
});

describe('findResparkableBillingSettings', () => {
  it('reads by the global slug', async () => {
    findUnique.mockResolvedValue(null);

    await findResparkableBillingSettings();

    expect(findUnique).toHaveBeenCalledWith({
      where: { slug: RESPARKABLE_BILLING_SETTINGS_SLUG },
    });
  });

  it('returns null on a fresh install rather than throwing', async () => {
    findUnique.mockResolvedValue(null);

    await expect(findResparkableBillingSettings()).resolves.toBeNull();
  });
});

describe('upsertResparkableBillingSettings', () => {
  it('targets the global slug on both the create and the update branch', async () => {
    upsert.mockResolvedValue({ slug: 'global', creditsPerUsd: 2 });

    await upsertResparkableBillingSettings({ creditsPerUsd: 2 });

    expect(upsert).toHaveBeenCalledWith({
      where: { slug: RESPARKABLE_BILLING_SETTINGS_SLUG },
      create: { slug: RESPARKABLE_BILLING_SETTINGS_SLUG, creditsPerUsd: 2 },
      update: { creditsPerUsd: 2 },
    });
  });

  /**
   * REGRESSION: same class of bug `repo/settings.test.ts` guards against.
   * The trusted slug must spread LAST in `create`, so a smuggled `slug` in
   * the write payload cannot create a second, orphaned settings row.
   */
  it('the create target cannot be overridden by a smuggled slug in data', async () => {
    upsert.mockResolvedValue({ slug: 'global' });

    await upsertResparkableBillingSettings({
      creditsPerUsd: 2,
      slug: 'attacker-owned',
    } as never);

    const call = upsert.mock.calls[0]?.[0];
    expect(call.create.slug).toBe(RESPARKABLE_BILLING_SETTINGS_SLUG);
    expect(call.where).toEqual({ slug: RESPARKABLE_BILLING_SETTINGS_SLUG });
  });
});
