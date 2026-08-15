/**
 * Tests: Sparkey pronoun forms
 *
 * @see lib/resparkable/sparkey-pronoun.ts
 */

import { describe, it, expect } from 'vitest';
import {
  SPARKEY_PRONOUNS,
  DEFAULT_SPARKEY_PRONOUN,
  getSparkeyPronounForms,
} from '@/lib/resparkable/sparkey-pronoun';

describe('getSparkeyPronounForms', () => {
  it('returns it/it/its for "it"', () => {
    expect(getSparkeyPronounForms('it')).toEqual({
      subject: 'it',
      object: 'it',
      possessive: 'its',
    });
  });

  it('returns he/him/his for "he"', () => {
    expect(getSparkeyPronounForms('he')).toEqual({
      subject: 'he',
      object: 'him',
      possessive: 'his',
    });
  });

  it('returns she/her/her for "she"', () => {
    expect(getSparkeyPronounForms('she')).toEqual({
      subject: 'she',
      object: 'her',
      possessive: 'her',
    });
  });

  it('defaults to "it"', () => {
    expect(DEFAULT_SPARKEY_PRONOUN).toBe('it');
  });

  it('exposes exactly the three supported pronouns', () => {
    expect(SPARKEY_PRONOUNS).toEqual(['it', 'he', 'she']);
  });
});
