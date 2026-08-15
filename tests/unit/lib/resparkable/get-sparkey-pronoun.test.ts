/**
 * Unit Tests: getSparkeyPronoun — server-only read of the Sparkey pronoun preference.
 *
 * Mirrors the mocking approach used for `readResparkable`
 * (tests/unit/lib/framework/resparkable/ui/server-read.test.ts): `@/lib/api/server-fetch`
 * is mocked at the module boundary, and the real Zod validation in
 * `get-sparkey-pronoun.ts` runs unmocked. Every failure mode must resolve to
 * `DEFAULT_SPARKEY_PRONOUN` — never throw — since this is called from pages
 * that must render regardless of a preferences-fetch hiccup.
 *
 * @see lib/resparkable/get-sparkey-pronoun.ts
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@/lib/api/server-fetch', () => ({
  serverFetch: vi.fn(),
  parseApiResponse: vi.fn(),
}));

vi.mock('@/lib/logging', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import { getSparkeyPronoun } from '@/lib/resparkable/get-sparkey-pronoun';

function fakeResponse(overrides: { ok: boolean; status: number }) {
  return { ok: overrides.ok, status: overrides.status } as unknown as Response;
}

describe('getSparkeyPronoun', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the stored pronoun on a successful, valid response', async () => {
    vi.mocked(serverFetch).mockResolvedValue(fakeResponse({ ok: true, status: 200 }));
    vi.mocked(parseApiResponse).mockResolvedValue({
      success: true,
      data: {
        email: { marketing: false, productUpdates: true, securityAlerts: true },
        sparkey: { pronoun: 'she' },
      },
    });

    await expect(getSparkeyPronoun()).resolves.toBe('she');
  });

  it('falls back to "it" and logs a warning on a non-OK response', async () => {
    vi.mocked(serverFetch).mockResolvedValue(fakeResponse({ ok: false, status: 500 }));

    await expect(getSparkeyPronoun()).resolves.toBe('it');
    expect(logger.warn).toHaveBeenCalledWith(
      'Sparkey pronoun preference read failed',
      expect.objectContaining({ status: 500 })
    );
  });

  it('falls back to "it" when the envelope is not a success envelope', async () => {
    vi.mocked(serverFetch).mockResolvedValue(fakeResponse({ ok: true, status: 200 }));
    vi.mocked(parseApiResponse).mockResolvedValue({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'nope' },
    });

    await expect(getSparkeyPronoun()).resolves.toBe('it');
    expect(logger.warn).toHaveBeenCalledWith(
      'Sparkey pronoun preference read: not a success envelope'
    );
  });

  it('falls back to "it" when the payload fails schema validation', async () => {
    vi.mocked(serverFetch).mockResolvedValue(fakeResponse({ ok: true, status: 200 }));
    vi.mocked(parseApiResponse).mockResolvedValue({
      success: true,
      data: { unexpected_key: 42 },
    });

    await expect(getSparkeyPronoun()).resolves.toBe('it');
    expect(logger.warn).toHaveBeenCalledWith(
      'Sparkey pronoun preference read: payload did not match schema'
    );
  });

  it('falls back to "it" and logs an error when the fetch throws', async () => {
    vi.mocked(serverFetch).mockRejectedValue(new Error('network down'));

    await expect(getSparkeyPronoun()).resolves.toBe('it');
    expect(logger.error).toHaveBeenCalledWith(
      'Sparkey pronoun preference read threw',
      expect.any(Error)
    );
  });
});
