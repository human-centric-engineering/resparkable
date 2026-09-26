'use client';

/**
 * GroupJoinLinks: the admin's join links (§23.11, phase 57).
 *
 * ## The sentence this section exists to say
 *
 * An invitation names an address; a join link names nobody. A forwarded
 * invitation is useless without the mailbox, and a forwarded join link is the
 * whole thing. The plan asks for that to be stated in the UI and not only in a
 * doc, so it is the first line an admin reads here.
 *
 * ## The link is shown once
 *
 * Only its digest is stored, so the full URL exists in the mint response and
 * nowhere else. It is shown with a copy button until the admin mints another or
 * leaves the page, and the list after that shows a prefix. An admin who loses a
 * link revokes it and mints a new one.
 *
 * ## Why approval follows the role until it is touched
 *
 * `request` is the default for a member link and `open` for a viewer link
 * (§23.11). The select follows the role until the admin picks an approval
 * themselves, after which it stays where they put it.
 */

import * as React from 'react';
import { Check, Copy, Link2, X } from 'lucide-react';

import { SaveStatus, useSaveStatus } from '@/components/resparkable/ui/save-status';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { ClientDate } from '@/components/ui/client-date';
import { FieldHelp } from '@/components/ui/field-help';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { apiClient } from '@/lib/api/client';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import {
  mintedJoinLinkSchema,
  type GroupJoinLinkWire,
} from '@/lib/framework/resparkable/ui/payloads';

type Role = 'member' | 'viewer';
type Approval = 'open' | 'request';

const EXPIRY_DAYS = ['7', '30', '90', '365'] as const;

function defaultApproval(role: Role): Approval {
  return role === 'viewer' ? 'open' : 'request';
}

export interface GroupJoinLinksProps {
  groupId: string;
  links: GroupJoinLinkWire[];
}

export function GroupJoinLinks({
  groupId,
  links: initialLinks,
}: GroupJoinLinksProps): React.ReactElement {
  const [links, setLinks] = React.useState(initialLinks);
  const [role, setRole] = React.useState<Role>('member');
  const [approval, setApproval] = React.useState<Approval | null>(null);
  const [maxUses, setMaxUses] = React.useState('');
  const [days, setDays] = React.useState<string>('30');
  const [neverExpires, setNeverExpires] = React.useState(false);
  const [minted, setMinted] = React.useState<{ url: string; copied: boolean } | null>(null);
  const [mintError, setMintError] = React.useState<string | null>(null);
  const { state, message, run } = useSaveStatus();

  const effectiveApproval = approval ?? defaultApproval(role);

  // Links minted here, so a list that arrives after them does not wipe them.
  const mintedHere = React.useRef<GroupJoinLinkWire[]>([]);

  // Follow the list when it is (re)loaded, which in a workspace tab happens
  // after this component has mounted. Deliberately not a `key` on the parent:
  // remounting would also drop `minted`, and the minted URL exists nowhere else.
  // A link minted before a slow fetch resolves is not in what it returns, and
  // replacing the list outright would leave a live credential with no revoke
  // button, so those are kept at the top.
  React.useEffect(() => {
    const loaded = new Set(initialLinks.map((link) => link.id));
    setLinks([...mintedHere.current.filter((link) => !loaded.has(link.id)), ...initialLinks]);
  }, [initialLinks]);

  async function mint(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setMintError(null);
    const uses = maxUses.trim() === '' ? null : Number(maxUses);

    const box: { raw: unknown } = { raw: null };
    const ok = await run(async () => {
      box.raw = await apiClient.post(RESPARKABLE_API.groupJoinLinks(groupId), {
        body: {
          role,
          approval: effectiveApproval,
          maxUses: uses,
          expiry: neverExpires ? { kind: 'never' } : { kind: 'days', days: Number(days) },
        },
      });
    });
    if (!ok) return;

    // Parsed, never cast: a network response, and the one that carries a
    // credential, so a shape change should fail loudly rather than show a link
    // that is not the one that was minted.
    const parsed = mintedJoinLinkSchema.safeParse(box.raw);
    if (!parsed.success) {
      // The link WAS created, so saying nothing would leave a live credential
      // nobody can see. Say so, and point at the list, where it can be revoked.
      setMintError(
        'The link was created but could not be shown. Reload the page and revoke it, then create another.'
      );
      return;
    }

    const { token: _token, url, ...link } = parsed.data;
    mintedHere.current = [link, ...mintedHere.current];
    setLinks((prev) => [link, ...prev]);
    setMinted({ url, copied: false });
  }

  async function revoke(linkId: string): Promise<void> {
    const previous = links;
    const now = new Date().toISOString();
    setLinks((prev) => prev.map((row) => (row.id === linkId ? { ...row, revokedAt: now } : row)));

    const ok = await run(() => apiClient.delete(RESPARKABLE_API.groupJoinLink(groupId, linkId)));
    if (!ok) setLinks(previous);
  }

  return (
    <section>
      <h3 className="mb-2 flex items-center gap-1.5 text-sm font-medium">
        Join links
        <FieldHelp title="Join links">
          <p>
            A join link lets anybody who has it join this group, without you typing their address.
          </p>
          <p>
            An invitation only works for the person it was sent to. A join link works for whoever
            has it, so if it is forwarded, the person it reaches can use it too.
          </p>
        </FieldHelp>
      </h3>

      <p className="text-muted-foreground mb-3 text-[11px]">
        Anyone who has a join link can use it. If it is forwarded, it works for whoever it reaches.
        A link can never make somebody an admin.
      </p>

      <form className="mb-3 flex flex-col gap-2" onSubmit={(event) => void mint(event)}>
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <label
              className="text-muted-foreground mb-1 flex items-center gap-1 text-xs"
              htmlFor="join-role"
            >
              Joins as
              <FieldHelp title="Role">
                <p>A member can read and add to everything in the group.</p>
                <p>
                  A viewer can read everything in the group but change nothing. For a link that may
                  travel further than you meant, this is the safer choice.
                </p>
              </FieldHelp>
            </label>
            <Select
              value={role}
              onValueChange={(next) => setRole(next === 'viewer' ? 'viewer' : 'member')}
            >
              <SelectTrigger id="join-role" className="h-9 w-28 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="member">member</SelectItem>
                <SelectItem value="viewer">viewer</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div>
            <label
              className="text-muted-foreground mb-1 flex items-center gap-1 text-xs"
              htmlFor="join-approval"
            >
              When they click it
              <FieldHelp title="When they click it">
                <p>
                  &ldquo;Joins straight away&rdquo;: whoever clicks the link is in the group at
                  once.
                </p>
                <p>
                  &ldquo;Needs an admin to let them in&rdquo;: clicking the link only asks to join.
                  They can see nothing in the group until an admin clicks &ldquo;Let in&rdquo; on
                  this page. If an admin turns them down, that place on the link is free again.
                </p>
              </FieldHelp>
            </label>
            <Select
              value={effectiveApproval}
              onValueChange={(next) => setApproval(next === 'open' ? 'open' : 'request')}
            >
              <SelectTrigger id="join-approval" className="h-9 w-60 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="request">Needs an admin to let them in</SelectItem>
                <SelectItem value="open">Joins straight away</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div>
            <label
              className="text-muted-foreground mb-1 flex items-center gap-1 text-xs"
              htmlFor="join-max-uses"
            >
              Uses
              <FieldHelp title="Uses">
                <p>
                  How many people can use this link. Leave it empty for no limit. The group&rsquo;s
                  member limit still applies either way.
                </p>
              </FieldHelp>
            </label>
            <Input
              id="join-max-uses"
              type="number"
              min={1}
              max={500}
              inputMode="numeric"
              className="h-9 w-20"
              value={maxUses}
              onChange={(event) => setMaxUses(event.target.value)}
              placeholder="Any"
            />
          </div>

          <div>
            <label className="text-muted-foreground mb-1 block text-xs" htmlFor="join-expiry">
              Works for
            </label>
            <Select value={days} onValueChange={setDays} disabled={neverExpires}>
              <SelectTrigger id="join-expiry" className="h-9 w-28 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EXPIRY_DAYS.map((value) => (
                  <SelectItem key={value} value={value}>
                    {value} days
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <Button type="submit" size="sm" disabled={state === 'saving'}>
            <Link2 className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
            Create link
          </Button>
        </div>

        <div className="flex items-center gap-2">
          <Checkbox
            id="join-never-expires"
            checked={neverExpires}
            onCheckedChange={(checked) => setNeverExpires(checked === true)}
          />
          <label className="text-muted-foreground text-xs" htmlFor="join-never-expires">
            Never expires
          </label>
        </div>
      </form>

      {mintError && (
        <p role="alert" className="text-destructive mb-3 text-xs">
          {mintError}
        </p>
      )}

      {minted && (
        <div className="border-border/60 mb-3 rounded-md border p-3">
          <div className="flex items-center gap-2">
            <Input readOnly value={minted.url} aria-label="The new join link" className="text-xs" />
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                void navigator.clipboard.writeText(minted.url);
                setMinted({ ...minted, copied: true });
              }}
            >
              {minted.copied ? (
                <Check className="h-4 w-4" aria-hidden="true" />
              ) : (
                <Copy className="h-4 w-4" aria-hidden="true" />
              )}
              <span className="sr-only">Copy link</span>
            </Button>
          </div>
          <p className="text-muted-foreground mt-2 text-xs">
            Copy it now. This is the only time the whole link is shown. If you lose it, revoke it
            and create another.
          </p>
        </div>
      )}

      {links.length === 0 ? (
        <p className="text-muted-foreground text-xs">No join links yet.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {links.map((link) => {
            const expired = link.expiresAt !== null && new Date(link.expiresAt) < new Date();
            const usedUp = link.maxUses !== null && link.useCount >= link.maxUses;
            const revocable = link.revokedAt === null && !expired;
            return (
              <li
                key={link.id}
                className="border-border/60 flex items-center justify-between gap-3 rounded-md border px-3 py-2"
              >
                <span className="min-w-0 truncate text-sm">
                  <span className="font-mono">{link.tokenPrefix}…</span>
                  <span className="text-muted-foreground ml-2 text-[11px]">
                    {link.role} ·{' '}
                    {link.approval === 'open'
                      ? 'joins straight away'
                      : 'needs an admin to let them in'}{' '}
                    · used {link.useCount}
                    {link.maxUses !== null ? ` of ${link.maxUses}` : ''}
                    {link.revokedAt !== null ? (
                      ' · revoked'
                    ) : expired ? (
                      ' · expired'
                    ) : usedUp ? (
                      ' · used up'
                    ) : link.expiresAt !== null ? (
                      <>
                        {' '}
                        · until <ClientDate date={link.expiresAt} />
                      </>
                    ) : (
                      ' · never expires'
                    )}
                  </span>
                </span>
                {/* Revocable unless already revoked or expired. A used-up link
                    is not dead: turning down a request made through it gives a
                    use back, so it has to stay revocable. */}
                {revocable && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void revoke(link.id)}
                    aria-label={`Revoke the join link starting ${link.tokenPrefix}`}
                  >
                    <X className="h-3.5 w-3.5" aria-hidden="true" />
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <SaveStatus state={state} message={message} />
    </section>
  );
}
