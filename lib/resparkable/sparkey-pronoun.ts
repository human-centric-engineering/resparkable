/**
 * Sparkey pronoun forms.
 *
 * Sparkey is the assistant's name. The user decides how the app refers to it
 * in copy that needs a pronoun (default: "It", since Sparkey is a tool, not a person).
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
