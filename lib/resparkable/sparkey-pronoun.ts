/**
 * Sparkey pronoun forms.
 *
 * Sparkey is the assistant's name. The user decides how the app refers to it
 * in copy that needs a pronoun (default: "It", since Sparkey is a tool, not a person).
 *
 * Only two surfaces use this today — the Goals and Areas empty states are the
 * only copy that currently has a pronoun referring to Sparkey rather than to
 * something else in the sentence (a document, a person). If new copy about
 * Sparkey needs a pronoun, call `getSparkeyPronounForms(pronoun)` with a
 * `pronoun` prop threaded down from the page (see `goals-view.tsx`/
 * `areas-view.tsx` and their `page.tsx`s, which read it via
 * `lib/resparkable/get-sparkey-pronoun.ts`) rather than hardcoding "it".
 */

export const SPARKEY_PRONOUNS = ['it', 'he', 'she'] as const;

export type SparkeyPronoun = (typeof SPARKEY_PRONOUNS)[number];

export const DEFAULT_SPARKEY_PRONOUN: SparkeyPronoun = 'it';

export interface SparkeyPronounForms {
  subject: string;
  object: string;
  possessive: string;
}

const SPARKEY_PRONOUN_FORMS: Record<SparkeyPronoun, SparkeyPronounForms> = {
  it: { subject: 'it', object: 'it', possessive: 'its' },
  he: { subject: 'he', object: 'him', possessive: 'his' },
  she: { subject: 'she', object: 'her', possessive: 'her' },
};

export const SPARKEY_PRONOUN_LABELS: Record<SparkeyPronoun, string> = {
  it: 'It',
  he: 'He',
  she: 'She',
};

export function getSparkeyPronounForms(pronoun: SparkeyPronoun): SparkeyPronounForms {
  return SPARKEY_PRONOUN_FORMS[pronoun];
}
