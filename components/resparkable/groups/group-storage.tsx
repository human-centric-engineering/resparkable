'use client';

/**
 * The group's shared shelf: how much its documents take up, against the
 * quota (§23.13, phase 58). Every member sees the usage, so an upload refused
 * for space is never the first anyone hears of it; an admin can change the
 * limit.
 */

import * as React from 'react';

import { SaveStatus, useSaveStatus } from '@/components/resparkable/ui/save-status';
import { Button } from '@/components/ui/button';
import { FieldHelp } from '@/components/ui/field-help';
import { Input } from '@/components/ui/input';
import { apiClient } from '@/lib/api/client';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import { formatBytes } from '@/lib/framework/resparkable/ui/format-bytes';

const GB = 1024 * 1024 * 1024;

export interface GroupStorageProps {
  groupId: string;
  isAdmin: boolean;
  usedBytes: number;
  quotaBytes: number;
}

export function GroupStorage({
  groupId,
  isAdmin,
  usedBytes,
  quotaBytes: initialQuota,
}: GroupStorageProps): React.ReactElement {
  const { state, message, run } = useSaveStatus();
  const [quotaBytes, setQuotaBytes] = React.useState(initialQuota);
  const [draft, setDraft] = React.useState(String(Math.round((initialQuota / GB) * 10) / 10));

  async function save(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const nextBytes = Math.round(Number(draft) * GB);
    if (!Number.isFinite(nextBytes) || nextBytes === quotaBytes) return;

    const ok = await run(() =>
      apiClient.patch(RESPARKABLE_API.group(groupId), { body: { storageQuotaBytes: nextBytes } })
    );
    if (ok) setQuotaBytes(nextBytes);
    else setDraft(String(Math.round((quotaBytes / GB) * 10) / 10));
  }

  return (
    <section className="space-y-2">
      <h3 className="text-sm font-medium">Documents</h3>
      <p className="text-muted-foreground text-sm">
        {formatBytes(usedBytes)} of {formatBytes(quotaBytes)} used.
      </p>

      {isAdmin && (
        <form
          className="flex items-end gap-2"
          onSubmit={(event) => void save(event)}
          // A decimal `step` invites a float step-mismatch that silently blocks
          // the submit; the server's bounds are the validation that counts.
          noValidate
        >
          <div>
            <label
              className="text-muted-foreground mb-1 flex items-center gap-1 text-xs"
              htmlFor="group-storage-limit"
            >
              Storage limit (GB)
              <FieldHelp title="Storage limit">
                <p>
                  The most space the group&apos;s uploaded documents can take up together. An upload
                  that would go over it is refused, with a message saying so.
                </p>
                <p>Archived documents still count, because their files are still kept.</p>
              </FieldHelp>
            </label>
            <Input
              id="group-storage-limit"
              type="number"
              min={0.1}
              max={1024}
              step={0.1}
              inputMode="decimal"
              className="h-8 w-24"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
          </div>
          <Button
            type="submit"
            size="sm"
            variant="outline"
            disabled={Math.round(Number(draft) * GB) === quotaBytes || state === 'saving'}
          >
            Save
          </Button>
        </form>
      )}

      <SaveStatus state={state} message={message} />
    </section>
  );
}
