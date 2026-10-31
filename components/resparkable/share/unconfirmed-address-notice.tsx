'use client';

/**
 * UnconfirmedAddressNotice: why "Shared with me" may be missing things
 * (phase 66).
 *
 * A share sent to an address reaches only an account that has confirmed it
 * owns that address (`privacy/address.ts`). On a deploy with verification off,
 * a person who never confirmed theirs would otherwise see an empty or short
 * list with nothing to say why, which reads as shares withdrawn. This says why
 * and links to where the confirmation is sent.
 *
 * ## Read from the account, not the session
 *
 * `GET /api/v1/users/me` reads `emailVerified` from the database. The session
 * is cached for five minutes, so a person who has just confirmed on another
 * device would keep seeing this from the session alone.
 *
 * ## Silent on failure
 *
 * A failed read shows nothing. The list below is still correct, and a notice
 * about a state we could not establish would be a guess.
 */

import * as React from 'react';
import Link from 'next/link';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import { apiClient } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { CONFIRM_ADDRESS_ROUTE } from '@/lib/framework/resparkable/ui/routes';

const accountSchema = z.object({ emailVerified: z.boolean() });

export function UnconfirmedAddressNotice(): React.ReactElement | null {
  const [unconfirmed, setUnconfirmed] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    apiClient
      .get<unknown>(API.USERS.ME)
      .then((raw) => {
        const parsed = accountSchema.safeParse(raw);
        if (!cancelled && parsed.success) setUnconfirmed(!parsed.data.emailVerified);
      })
      .catch(() => {
        // Silent on failure; see the file comment.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!unconfirmed) return null;

  return (
    <div
      role="status"
      className="bg-card flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"
    >
      <p className="text-sm">
        Things shared with your email address appear here once you confirm it.
      </p>
      <Button asChild size="sm" variant="secondary">
        <Link href={CONFIRM_ADDRESS_ROUTE}>Confirm my address</Link>
      </Button>
    </div>
  );
}
