/**
 * Unit Tests: bytes as a person reads them (phase 58's storage quota).
 *
 * @see lib/framework/resparkable/ui/format-bytes.ts
 */

import { describe, expect, it } from 'vitest';

import { formatBytes } from '@/lib/framework/resparkable/ui/format-bytes';

describe('formatBytes', () => {
  it('reads a gigabyte or more in GB, to one decimal place', () => {
    expect(formatBytes(2 * 1024 * 1024 * 1024)).toBe('2 GB');
    expect(formatBytes(1.45 * 1024 * 1024 * 1024)).toBe('1.5 GB');
  });

  it('reads anything smaller in whole MB', () => {
    expect(formatBytes(820 * 1024 * 1024)).toBe('820 MB');
    expect(formatBytes(0)).toBe('0 MB');
  });
});
