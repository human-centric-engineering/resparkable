'use client';

/**
 * VaultTab — the launcher-opened counterpart to `app/(protected)/resparkable/vault/page.tsx`.
 *
 * Not a `useTabFetch` adapter at all: the server page does no fetch of its
 * own (documented in its own comment — "both halves are user-initiated file
 * transfers") and just lays out two already-`'use client'`, already
 * self-fetching cards. There's nothing here for this phase to port.
 */

import * as React from 'react';

import { VaultExportCard } from '@/components/resparkable/vault/vault-export-card';
import { VaultImportCard } from '@/components/resparkable/vault/vault-import-card';

export function VaultTab(): React.ReactElement {
  return (
    <div className="grid gap-4 p-4 lg:grid-cols-2">
      <VaultExportCard />
      <VaultImportCard />
    </div>
  );
}
