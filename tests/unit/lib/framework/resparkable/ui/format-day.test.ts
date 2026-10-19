/**
 * Unit Tests: `formatDay`, a day of the month on the group's own clock.
 *
 * @see lib/framework/resparkable/ui/format-day.ts
 */

import { describe, expect, it } from 'vitest';

import { formatDay } from '@/lib/framework/resparkable/ui/format-day';

describe('formatDay', () => {
  it('writes the day and the full month name', () => {
    expect(formatDay('2026-11-05T00:00:00.000Z', 'UTC')).toBe('5 November');
  });

  it('uses the group’s zone for which day it is, not UTC', () => {
    const instant = '2026-11-04T23:00:00.000Z';

    expect(formatDay(instant, 'UTC')).toBe('4 November');
    expect(formatDay(instant, 'Pacific/Auckland')).toBe('5 November');
    expect(formatDay(instant, 'America/Los_Angeles')).toBe('4 November');
  });

  it('is empty for something that is not a date', () => {
    expect(formatDay('not a date', 'UTC')).toBe('');
    expect(formatDay('', 'UTC')).toBe('');
  });

  it('falls back to the UTC day for a zone name it does not know', () => {
    expect(formatDay('2026-11-04T23:00:00.000Z', 'Not/AZone')).toBe('4 November');
  });
});
