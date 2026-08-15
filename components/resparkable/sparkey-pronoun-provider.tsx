'use client';

/**
 * Provides the user's chosen Sparkey pronoun to client components, so copy that
 * refers to Sparkey ("...ask it something", "...when he helps you") stays in sync
 * with the preference set on the settings page without every component fetching
 * it itself.
 *
 * The default context value (not `undefined`) means components can call
 * `useSparkeyPronoun()` safely even when rendered outside the provider: tests,
 * Storybook, or any tree that hasn't been wrapped, all fall back to "it".
 */

import { createContext, useContext } from 'react';
import {
  DEFAULT_SPARKEY_PRONOUN,
  getSparkeyPronounForms,
  type SparkeyPronoun,
  type SparkeyPronounForms,
} from '@/lib/resparkable/sparkey-pronoun';

const SparkeyPronounContext = createContext<SparkeyPronoun>(DEFAULT_SPARKEY_PRONOUN);

interface SparkeyPronounProviderProps {
  pronoun: SparkeyPronoun;
  children: React.ReactNode;
}

export function SparkeyPronounProvider({ pronoun, children }: SparkeyPronounProviderProps) {
  return (
    <SparkeyPronounContext.Provider value={pronoun}>{children}</SparkeyPronounContext.Provider>
  );
}

/** Returns the raw pronoun ('it' | 'he' | 'she') the user has chosen for Sparkey. */
export function useSparkeyPronounValue(): SparkeyPronoun {
  return useContext(SparkeyPronounContext);
}

/** Returns the word forms (subject/object/possessive) for the user's Sparkey pronoun. */
export function useSparkeyPronoun(): SparkeyPronounForms {
  return getSparkeyPronounForms(useSparkeyPronounValue());
}
