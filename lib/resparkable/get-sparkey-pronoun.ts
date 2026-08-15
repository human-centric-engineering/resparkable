/**
 * Server-only read of the current user's Sparkey pronoun preference.
 *
 * Called only by the handful of server pages that actually render Sparkey
 * pronoun copy (`goals`, `areas`, `/resparkable/settings`) — deliberately not
 * from a shared layout. A layout-level fetch would run on every protected
 * page load, including the many pages that never mention Sparkey, and would
 * duplicate the preferences fetch that `/resparkable/settings` already makes
 * for its own reasons. Reads through the preferences API rather than Prisma
 * directly, matching `lib/framework/resparkable/ui/server-read.ts`.
 */

import { serverFetch, parseApiResponse } from '@/lib/api/server-fetch';
import { API } from '@/lib/api/endpoints';
import { userPreferencesSchema } from '@/lib/validations/user';
import { DEFAULT_SPARKEY_PRONOUN, type SparkeyPronoun } from '@/lib/resparkable/sparkey-pronoun';
import { logger } from '@/lib/logging';

export async function getSparkeyPronoun(): Promise<SparkeyPronoun> {
  try {
    const response = await serverFetch(API.USERS.ME_PREFERENCES);
    if (!response.ok) {
      logger.warn('Sparkey pronoun preference read failed', { status: response.status });
      return DEFAULT_SPARKEY_PRONOUN;
    }

    const body = await parseApiResponse<unknown>(response);
    if (!body.success) {
      logger.warn('Sparkey pronoun preference read: not a success envelope');
      return DEFAULT_SPARKEY_PRONOUN;
    }

    const parsed = userPreferencesSchema.safeParse(body.data);
    if (!parsed.success) {
      logger.warn('Sparkey pronoun preference read: payload did not match schema');
      return DEFAULT_SPARKEY_PRONOUN;
    }

    return parsed.data.sparkey.pronoun;
  } catch (error) {
    logger.error('Sparkey pronoun preference read threw', error);
    return DEFAULT_SPARKEY_PRONOUN;
  }
}
