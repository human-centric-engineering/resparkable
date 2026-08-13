/**
 * Unit Tests: `lib/framework/resparkable/repo/owner-contact.ts`.
 *
 * The tier's one Prisma access outside its own tables, so what it selects and
 * what it returns on a missing user matter more than usual. `emailVerified`
 * (phase 9) is the newest field on `OwnerContact` and the first one a caller
 * *checks* rather than just displays — `resparkable_capture_for_token` refuses
 * an inbound email unless this is true, so a wrong value here is a silent
 * security regression, not a cosmetic one.
 *
 * @see lib/framework/resparkable/repo/owner-contact.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: { user: { findUnique: vi.fn() } },
}));

import { prisma } from '@/lib/db/client';
import { findOwnerContact } from '@/lib/framework/resparkable/repo/owner-contact';
import { ownerScope } from '@/lib/framework/resparkable/repo/owner-scope';

const findUnique = vi.mocked(prisma.user.findUnique);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('findOwnerContact', () => {
  it('looks the user up by the scope id, selecting only email, name and emailVerified', async () => {
    findUnique.mockResolvedValue({
      email: 'owner@example.com',
      name: 'Owner',
      emailVerified: true,
    } as never);

    await findOwnerContact(ownerScope('user_a'));

    expect(findUnique).toHaveBeenCalledWith({
      where: { id: 'user_a' },
      select: { email: true, name: true, emailVerified: true },
    });
  });

  it('returns the contact with emailVerified carried through', async () => {
    findUnique.mockResolvedValue({
      email: 'owner@example.com',
      name: 'Owner',
      emailVerified: true,
    } as never);

    await expect(findOwnerContact(ownerScope('user_a'))).resolves.toEqual({
      email: 'owner@example.com',
      name: 'Owner',
      emailVerified: true,
    });
  });

  it('reports an unverified email as false, not truthy-because-present', async () => {
    findUnique.mockResolvedValue({
      email: 'owner@example.com',
      name: 'Owner',
      emailVerified: false,
    } as never);

    await expect(findOwnerContact(ownerScope('user_a'))).resolves.toMatchObject({
      emailVerified: false,
    });
  });

  it('normalises a null name to null rather than leaving it undefined', async () => {
    findUnique.mockResolvedValue({
      email: 'owner@example.com',
      name: null,
      emailVerified: true,
    } as never);

    await expect(findOwnerContact(ownerScope('user_a'))).resolves.toMatchObject({ name: null });
  });

  it('returns null when the account no longer exists — an erased-user schedule, not an error', async () => {
    findUnique.mockResolvedValue(null);

    await expect(findOwnerContact(ownerScope('user_a'))).resolves.toBeNull();
  });

  it('returns null when the row exists but has no email', async () => {
    // Defensive: `email` is non-nullable in the schema, but a caller that
    // trusted the row without this check would crash on `.toLowerCase()`
    // rather than skip quietly.
    findUnique.mockResolvedValue({ email: '', name: 'Owner', emailVerified: true } as never);

    await expect(findOwnerContact(ownerScope('user_a'))).resolves.toBeNull();
  });
});
