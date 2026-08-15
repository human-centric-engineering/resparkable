/**
 * Unit Tests: `classifyThoughtSensitivity`.
 *
 * Pure and deterministic — no LLM call, no I/O — because `captureThought` is
 * "the one write path that has to be faster than thinking" and this runs
 * inline on every capture, on every channel.
 *
 * Test Coverage:
 * - Ordinary content classifies as `private`, the safe default
 * - Content matching a sensitive-category keyword classifies as `sensitive`
 * - `public` is never returned — it exists for a person to opt into by hand
 *
 * @see lib/framework/resparkable/services/sensitivity.ts
 */

import { describe, it, expect } from 'vitest';

import { classifyThoughtSensitivity } from '@/lib/framework/resparkable/services/sensitivity';

describe('classifyThoughtSensitivity', () => {
  it('classifies ordinary content as private', () => {
    expect(classifyThoughtSensitivity('Renew the domain before it expires')).toBe('private');
  });

  it('classifies empty content as private rather than throwing', () => {
    expect(classifyThoughtSensitivity('')).toBe('private');
  });

  it.each([
    ['health', 'Started therapy for anxiety this week'],
    ['financial hardship', "We're behind on rent again this month"],
    ['relationship conflict', 'We are going through a divorce and it is ugly'],
    ['legal', 'Got a letter saying I am being sued by a former client'],
    ['SSN-shaped text', 'My number is 123-45-6789, for the form'],
  ])('classifies %s content as sensitive', (_label, content) => {
    expect(classifyThoughtSensitivity(content)).toBe('sensitive');
  });

  it('never returns public — that is a person’s own downgrade, not an auto-classification', () => {
    const samples = [
      'Renew the domain',
      'Started therapy for anxiety',
      'Buy milk',
      'We are being sued',
    ];
    for (const content of samples) {
      expect(classifyThoughtSensitivity(content)).not.toBe('public');
    }
  });

  it('is case-insensitive', () => {
    expect(classifyThoughtSensitivity('STARTED THERAPY FOR ANXIETY')).toBe('sensitive');
  });
});
