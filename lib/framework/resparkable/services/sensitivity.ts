/**
 * Sensitivity classification for captured thoughts.
 *
 * `captureThought()` (services/capture.ts) is "the one write path that has to
 * be faster than thinking" — it doesn't make an LLM call, and this doesn't
 * either. `classifyThoughtSensitivity` is a pure keyword/regex pass in the
 * same spirit as `lib/security/redact.ts`'s masking primitives: cheap,
 * synchronous, no I/O.
 *
 * The result governs which background agents' reads and the description-
 * summariser see a thought (see repo/thoughts.ts's `excludeSensitive` filter)
 * — it is NOT a restriction on which LLM provider a chat turn is sent to,
 * and it is NEVER applied to the GDPR subject-export path
 * (repo/subject-export.ts exports every row regardless of classification).
 *
 * `'public'` is never returned here — a person opts into it later, by hand,
 * via `PATCH /resparkable/thoughts/[id]`. The default on no signal is
 * `'private'`, matching every other privacy-adjacent field in this schema.
 */

import type { THOUGHT_SENSITIVITY_LEVELS } from '@/lib/framework/resparkable/validations';

export type ThoughtSensitivity = (typeof THOUGHT_SENSITIVITY_LEVELS)[number];

/**
 * Keyword groups that escalate a thought to `'sensitive'`. Deliberately broad
 * rather than precise — a false positive costs a background agent one row it
 * won't read; a false negative is the failure mode that actually matters.
 */
const SENSITIVE_PATTERNS: RegExp[] = [
  // Health / mental health
  /\b(diagnos(is|ed|es)|therap(y|ist)|medication|prescri(bed|ption)|depress(ion|ed)|anxiety|panic attack|suicid|self[- ]harm|addiction|relapse|miscarriage|infertility|chronic (pain|illness)|disability)\b/i,
  // Financial hardship
  /\b(bankrupt(cy)?|foreclosure|eviction|can'?t afford|debt collector|behind on (rent|payments|mortgage)|overdraft|repossess(ed|ion)|laid off|redundan(t|cy))\b/i,
  // Relationship conflict
  /\b(divorc(e|ing)|affair|cheating|separation|custody battle|domestic (violence|abuse)|restraining order|estranged)\b/i,
  // Legal
  /\b(lawsuit|being sued|criminal (charge|record)|arrest(ed)?|probation|parole|immigration status|deportation)\b/i,
  // Shape-based PII (mirrors the pii_ssn/pii_credit_card patterns in
  // lib/orchestration/chat/output-guard.ts)
  /\b\d{3}-\d{2}-\d{4}\b/, // SSN-shaped
  /\b(?:\d[ -]*?){13,19}\b/, // credit-card-shaped run of digits
];

/**
 * Classify a thought's content into a sensitivity level.
 *
 * @example
 * classifyThoughtSensitivity('Renew the domain before it expires') // 'private'
 * classifyThoughtSensitivity('Started therapy for anxiety this week') // 'sensitive'
 */
export function classifyThoughtSensitivity(content: string): ThoughtSensitivity {
  if (SENSITIVE_PATTERNS.some((pattern) => pattern.test(content))) {
    return 'sensitive';
  }
  return 'private';
}
