'use client';

/**
 * ShareDialog — the owner's side of both kinds of sharing, in one place.
 *
 * ## Why two tabs rather than one list of "people and links"
 *
 * Because they are different things and conflating them is how somebody hands
 * the internet a document they meant to hand a colleague. A **named grant** is a
 * relationship: it goes to one address, it shows the grantee who shared it, and
 * it can be amended. A **public link** is a bearer credential: anyone holding
 * the URL is in, nothing about the owner is disclosed, and the only way to close
 * it is to revoke it. The dialog says so in both tabs rather than assuming the
 * distinction is obvious from the fields.
 *
 * ## The three things a filter board has to say before it is shared
 *
 * §13 requires all three, and this is the surface they were required in:
 *
 *   1. **The rule, in plain English.** A filter board is a live query. Sharing
 *      it shares every task that matches, including ones created next week. The
 *      sentence comes from the server (`filterSummary`), because the honest
 *      version needs the project's name and the filter holds only an id.
 *   2. **The live count**, so "13 tasks right now" is on screen before anyone
 *      agrees to anything.
 *   3. **"Share a snapshot instead"**, which freezes the board to what it shows
 *      today. For anything leaving your organisation this is the safer choice,
 *      and the copy says so rather than presenting the two as equal options.
 *
 * An explicit board needs none of it: its contents are exactly the cards the
 * owner put on it.
 *
 * ## The token is shown once, and the copy has to mean it
 *
 * `POST /share-links` is the only moment the plaintext token exists outside a
 * hash. Nothing in the system can produce it again — not this dialog on its next
 * open, not the link list, not an export, not a database dump. So the freshly
 * minted link stays on screen until the dialog closes, and the wording is "copy
 * it now" rather than a reassuring "you can find this later".
 */

import * as React from 'react';
import { Check, Copy, Link2, Send, Trash2, UserPlus } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ClientDate } from '@/components/ui/client-date';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { FieldHelp } from '@/components/ui/field-help';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import type { ResparkableShareableType } from '@/lib/framework/resparkable/validations';
import {
  createdGrantSchema,
  grantsSchema,
  inviteSentSchema,
  mintedShareLinkSchema,
  shareLinksSchema,
  type GrantWire,
  type ShareLinkWire,
} from '@/lib/framework/resparkable/ui/payloads';

export interface ShareDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * One of §13's six, not a string. It was `string` while two call sites passed
   * two literals; now that `ShareButton` fans it out to six surfaces, an
   * `entityType="thought"` or a plural typo would compile and fail only at the
   * grants POST, where `z.enum(RESPARKABLE_SHAREABLE_TYPES)` rejects it. A
   * share button that silently does nothing on one surface is exactly the
   * failure the wrapper exists to prevent, so the union does the preventing.
   */
  entityType: ResparkableShareableType;
  entityId: string;
  /** What is being shared, for the dialog's own heading. */
  title: string;
  /**
   * A filter board's rule and card count, when this is one. Absent for
   * everything else — including explicit boards, whose membership is fixed.
   */
  filterBoard?: { summary: string; cardCount: number };
  /** Called after a snapshot, so the surface behind the dialog can reload. */
  onSnapshot?: () => void;
}

export function ShareDialog({
  open,
  onOpenChange,
  entityType,
  entityId,
  title,
  filterBoard,
  onSnapshot,
}: ShareDialogProps): React.ReactElement {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Share “{title}”</DialogTitle>
          <DialogDescription>
            Shared items are read-only. Nobody you share with can change anything.
          </DialogDescription>
        </DialogHeader>

        {filterBoard !== undefined && (
          <FilterBoardWarning
            summary={filterBoard.summary}
            cardCount={filterBoard.cardCount}
            entityId={entityId}
            onSnapshot={onSnapshot}
          />
        )}

        <Tabs defaultValue="people">
          <TabsList className="w-full">
            <TabsTrigger value="people" className="flex-1">
              People
            </TabsTrigger>
            <TabsTrigger value="link" className="flex-1">
              Public link
            </TabsTrigger>
          </TabsList>

          <TabsContent value="people" className="space-y-4 pt-4">
            <PeoplePanel entityType={entityType} entityId={entityId} />
          </TabsContent>

          <TabsContent value="link" className="space-y-4 pt-4">
            <LinkPanel entityType={entityType} entityId={entityId} />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

// ─── The dynamic-filter warning ──────────────────────────────────────────────

function FilterBoardWarning({
  summary,
  cardCount,
  entityId,
  onSnapshot,
}: {
  summary: string;
  cardCount: number;
  entityId: string;
  onSnapshot?: () => void;
}): React.ReactElement {
  const [freezing, setFreezing] = React.useState(false);
  const [frozen, setFrozen] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const freeze = async () => {
    setFreezing(true);
    setError(null);
    try {
      const response = await fetch(RESPARKABLE_API.boardSnapshot(entityId), { method: 'POST' });
      if (!response.ok) {
        setError('Could not take a snapshot of this board.');
        return;
      }
      setFrozen(true);
      onSnapshot?.();
    } catch {
      setError('Could not take a snapshot of this board.');
    } finally {
      setFreezing(false);
    }
  };

  if (frozen) {
    return (
      <p className="rounded-md border border-dashed p-3 text-sm">
        This board now holds a fixed set of cards. Tasks you create later will not appear on it, and
        will not reach anyone you share it with.
      </p>
    );
  }

  return (
    <div className="space-y-2 rounded-md border border-dashed p-3">
      <p className="text-sm">{summary}</p>
      <p className="text-muted-foreground text-sm">
        {cardCount} {cardCount === 1 ? 'task matches' : 'tasks match'} right now.
      </p>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={() => void freeze()}
        disabled={freezing}
      >
        Share a snapshot instead
      </Button>
      <p className="text-muted-foreground text-xs">
        A snapshot fixes the board to the tasks above. For anything leaving your organisation this
        is the safer choice. You can put the board back on a filter later by editing it.
      </p>
      {error !== null && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
    </div>
  );
}

// ─── People ──────────────────────────────────────────────────────────────────

function PeoplePanel({
  entityType,
  entityId,
}: {
  entityType: ResparkableShareableType;
  entityId: string;
}): React.ReactElement {
  const [grants, setGrants] = React.useState<GrantWire[] | null>(null);
  const [email, setEmail] = React.useState('');
  const [role, setRole] = React.useState('viewer');
  const [includeTaskDetail, setIncludeTaskDetail] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    const url = `${RESPARKABLE_API.GRANTS}?entityType=${encodeURIComponent(entityType)}&entityId=${encodeURIComponent(entityId)}`;
    const parsed = await readList(url, grantsSchema);
    if (parsed === null) setError('Could not load who this is shared with.');
    else setGrants(parsed);
  }, [entityType, entityId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  /**
   * Email the person a grant was issued to.
   *
   * Its own call, because the grant is a database fact before it is a message:
   * a mail-provider failure has to leave working access rather than nothing.
   * That is why every failure path here sets a notice rather than an error —
   * the person already has access either way.
   */
  const sendInvite = async (grantId: string): Promise<boolean> => {
    try {
      const response = await fetch(RESPARKABLE_API.grantInvite(grantId), { method: 'POST' });
      if (!response.ok) return false;
      const payload: unknown = await response.json();
      if (!isSuccess(payload)) return false;
      const parsed = inviteSentSchema.safeParse(payload.data);
      return parsed.success && parsed.data.sent;
    } catch {
      return false;
    }
  };

  const share = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    const address = email;
    try {
      const response = await fetch(RESPARKABLE_API.GRANTS, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entityType,
          entityId,
          granteeEmail: address,
          role,
          includeTaskDetail,
        }),
      });
      const payload: unknown = await response.json();
      if (!response.ok || !isSuccess(payload)) {
        setError('Could not share this. Check the email address and try again.');
        return;
      }
      const parsed = createdGrantSchema.safeParse(payload.data);
      if (!parsed.success) {
        setError('Shared, but the response could not be read. Reload to see it.');
        return;
      }

      const sent = await sendInvite(parsed.data.grant.id);
      setNotice(
        sent
          ? `Shared. ${address} has been emailed.`
          : 'Shared. The email could not be sent, but they can still open it. Try sending again.'
      );

      setEmail('');
      await load();
    } catch {
      setError('Could not share this.');
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: string) => {
    await fetch(RESPARKABLE_API.grant(id), { method: 'DELETE' });
    await load();
  };

  return (
    <div className="space-y-4">
      <form className="space-y-3" onSubmit={(event) => void share(event)}>
        <div className="space-y-1">
          <Label htmlFor="share-email">Email address</Label>
          <Input
            id="share-email"
            type="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="them@example.com"
          />
        </div>

        <div className="flex items-end gap-3">
          <div className="flex-1 space-y-1">
            <div className="flex items-center gap-1">
              <Label htmlFor="share-role">They can</Label>
              <FieldHelp title="What they can do">
                A viewer can read what you shared and nothing else. A commenter can also leave
                comments on it. Neither can change the item, and neither can see anything you have
                not shared.
              </FieldHelp>
            </div>
            <Select value={role} onValueChange={setRole}>
              <SelectTrigger id="share-role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="viewer">Read it</SelectItem>
                <SelectItem value="commenter">Read it and comment</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <Button type="submit" disabled={busy}>
            <UserPlus className="h-4 w-4" aria-hidden="true" />
            Share
          </Button>
        </div>

        <div className="flex items-center gap-2">
          <Switch
            id="share-detail"
            checked={includeTaskDetail}
            onCheckedChange={setIncludeTaskDetail}
          />
          <Label htmlFor="share-detail" className="font-normal">
            Include task notes
          </Label>
          <FieldHelp title="Task notes">
            Off by default. A shared task shows its title, status and due date. Turn this on to also
            show the notes you have written on it. Priority scores and the reasons behind them are
            never shown, whatever this is set to.
          </FieldHelp>
        </div>
      </form>

      {error !== null && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}

      {notice !== null && (
        <p aria-live="polite" className="text-muted-foreground text-sm">
          {notice}
        </p>
      )}

      {grants !== null && grants.length > 0 && (
        <ul className="space-y-2">
          {grants.map((grant) => (
            <li
              key={grant.id}
              className="flex flex-wrap items-center gap-2 rounded-md border p-2 text-sm"
            >
              <span className="font-medium">{grant.granteeEmail}</span>
              <Badge variant="outline" className="text-[11px]">
                {grant.role === 'commenter' ? 'can comment' : 'can read'}
              </Badge>
              {/* "Invited" rather than "cannot see it yet", which would be
                  untrue: a grant works from the moment it is issued. This says
                  whether they have been through the invite flow, and nothing
                  about whether the address has an account — which the owner is
                  deliberately not told, or sharing becomes a way to test
                  whether somebody has signed up. */}
              {!grant.accepted && (
                <Badge variant="secondary" className="text-[11px]">
                  invited
                </Badge>
              )}
              {grant.expiresAt !== null && (
                <span className="text-muted-foreground text-xs">
                  until <ClientDate date={grant.expiresAt} />
                </span>
              )}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="ml-auto"
                onClick={() => {
                  void sendInvite(grant.id).then((sent) =>
                    setNotice(
                      sent ? 'Email sent again.' : 'The email could not be sent. Try again later.'
                    )
                  );
                }}
              >
                <Send className="h-4 w-4" aria-hidden="true" />
                <span className="sr-only">Email {grant.granteeEmail} again</span>
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => void revoke(grant.id)}>
                <Trash2 className="h-4 w-4" aria-hidden="true" />
                <span className="sr-only">Stop sharing with {grant.granteeEmail}</span>
              </Button>
            </li>
          ))}
        </ul>
      )}

      {grants !== null && grants.length === 0 && (
        <p className="text-muted-foreground text-sm">This is not shared with anyone yet.</p>
      )}
    </div>
  );
}

// ─── Public link ─────────────────────────────────────────────────────────────

function LinkPanel({
  entityType,
  entityId,
}: {
  entityType: ResparkableShareableType;
  entityId: string;
}): React.ReactElement {
  const [links, setLinks] = React.useState<ShareLinkWire[] | null>(null);
  const [minted, setMinted] = React.useState<{ path: string } | null>(null);
  const [includeChildren, setIncludeChildren] = React.useState(false);
  const [includeTaskDetail, setIncludeTaskDetail] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    const url = `${RESPARKABLE_API.SHARE_LINKS}?entityType=${encodeURIComponent(entityType)}&entityId=${encodeURIComponent(entityId)}`;
    const parsed = await readList(url, shareLinksSchema);
    if (parsed === null) setError('Could not load this item’s links.');
    else setLinks(parsed);
  }, [entityType, entityId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const mint = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(RESPARKABLE_API.SHARE_LINKS, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entityType, entityId, includeChildren, includeTaskDetail }),
      });
      const payload: unknown = await response.json();
      if (!response.ok || !isSuccess(payload)) {
        setError('Could not create a link.');
        return;
      }
      const parsed = mintedShareLinkSchema.safeParse(payload.data);
      if (!parsed.success) {
        setError('Could not read the new link.');
        return;
      }
      setMinted({ path: parsed.data.path });
      await load();
    } catch {
      setError('Could not create a link.');
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: string) => {
    await fetch(RESPARKABLE_API.shareLink(id), { method: 'DELETE' });
    setMinted(null);
    await load();
  };

  return (
    <div className="space-y-4">
      <p className="text-muted-foreground text-sm">
        Anyone with the link can read this. They will not see your name, your other items, or
        anything you have not shared. Search engines are asked not to index it.
      </p>

      <div className="flex items-center gap-2">
        <Switch id="link-children" checked={includeChildren} onCheckedChange={setIncludeChildren} />
        <Label htmlFor="link-children" className="font-normal">
          Include what is inside it
        </Label>
        <FieldHelp title="What is inside it">
          A project’s tasks, a goal’s sub-goals, or a board’s cards. Off by default, which shares
          the item on its own.
        </FieldHelp>
      </div>

      <div className="flex items-center gap-2">
        <Switch
          id="link-detail"
          checked={includeTaskDetail}
          onCheckedChange={setIncludeTaskDetail}
        />
        <Label htmlFor="link-detail" className="font-normal">
          Include task notes
        </Label>
      </div>

      <Button type="button" onClick={() => void mint()} disabled={busy}>
        <Link2 className="h-4 w-4" aria-hidden="true" />
        Create a link
      </Button>

      {error !== null && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}

      {minted !== null && (
        <div className="space-y-2 rounded-md border border-dashed p-3">
          {/* On screen until the dialog closes, and worded as a one-off,
              because it is one: the plaintext exists in this response and
              nowhere else in the system, ever again. */}
          <p className="text-sm font-medium">Copy this now. It is not shown again.</p>
          <div className="flex gap-2">
            <Input readOnly value={absoluteUrl(minted.path)} aria-label="Share link" />
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                void navigator.clipboard.writeText(absoluteUrl(minted.path));
                setCopied(true);
              }}
            >
              {copied ? (
                <Check className="h-4 w-4" aria-hidden="true" />
              ) : (
                <Copy className="h-4 w-4" aria-hidden="true" />
              )}
              <span className="sr-only">Copy link</span>
            </Button>
          </div>
          <p className="text-muted-foreground text-xs">
            If you lose it, create another one. There is no way to look this up later.
          </p>
        </div>
      )}

      {links !== null && links.length > 0 && (
        <ul className="space-y-2">
          {links.map((link) => (
            <li
              key={link.id}
              className="flex flex-wrap items-center gap-2 rounded-md border p-2 text-sm"
            >
              <span className="font-mono text-xs">{link.tokenPrefix}…</span>
              <Badge variant="outline" className="text-[11px]">
                {link.viewCount} {link.viewCount === 1 ? 'view' : 'views'}
              </Badge>
              {link.expiresAt !== null && (
                <span className="text-muted-foreground text-xs">
                  until <ClientDate date={link.expiresAt} />
                </span>
              )}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="ml-auto"
                onClick={() => void revoke(link.id)}
              >
                <Trash2 className="h-4 w-4" aria-hidden="true" />
                <span className="sr-only">Revoke this link</span>
              </Button>
            </li>
          ))}
        </ul>
      )}

      {links !== null && links.length === 0 && minted === null && (
        <p className="text-muted-foreground text-sm">There are no links to this item.</p>
      )}
    </div>
  );
}

// ─── Shared plumbing ─────────────────────────────────────────────────────────

/**
 * Fetch a list endpoint and parse it. `null` on any failure.
 *
 * Parsed rather than cast: a network response is external data, and `as` is not
 * how it gets narrowed. A shape change upstream should surface here, not as an
 * undefined field halfway down a render.
 */
async function readList<T>(
  url: string,
  schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false } }
): Promise<T | null> {
  try {
    const response = await fetch(url);
    const payload: unknown = await response.json();
    if (!response.ok || !isSuccess(payload)) return null;
    const parsed = schema.safeParse(payload.data);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function isSuccess(payload: unknown): payload is { success: true; data: unknown } {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    'success' in payload &&
    payload.success === true &&
    'data' in payload
  );
}

/**
 * The link as somebody would paste it.
 *
 * `window.location.origin` rather than a configured base URL, because this only
 * ever runs in the browser that is about to copy it — and a deployment reached
 * on two hostnames should hand out the one the owner is actually using.
 */
function absoluteUrl(path: string): string {
  if (typeof window === 'undefined') return path;
  return `${window.location.origin}${path}`;
}
