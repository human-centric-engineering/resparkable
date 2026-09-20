'use client';

/**
 * Connect an AI assistant: generate, regenerate and revoke this workspace's key.
 *
 * **Not a Claude feature.** MCP is an open protocol and the server does not
 * care what is on the other end, so nothing here names a vendor outside the
 * snippet tabs, where naming one is the whole point.
 *
 * Five states, and the order below is the order a person meets them: loading,
 * the server is off, no key yet, a key exists, a key was just made. The last is
 * the only one that ever holds a secret, and it holds it in memory for as long
 * as the card is open and nowhere else.
 *
 * Copy follows the house rules: plain English, no scope names, and nothing
 * about never losing anything.
 */

import * as React from 'react';

import { SaveStatus, useSaveStatus } from '@/components/resparkable/ui/save-status';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { FieldHelp } from '@/components/ui/field-help';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import {
  MCP_CLIENT_SNIPPETS,
  OAUTH_ONLY_CLIENTS,
  RESPARKABLE_MCP_PATH,
  RESPARKABLE_MCP_SERVER_NAME,
  type McpClientSnippet,
} from '@/lib/framework/resparkable/mcp/client-snippets';
import { apiClient, APIClientError } from '@/lib/api/client';
import { useCopyToClipboard } from '@/lib/hooks/use-copy-to-clipboard';
import { Check, Copy, Plug } from 'lucide-react';

interface ConnectionKey {
  id: string;
  keyPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
}

interface KeysView {
  serverEnabled: boolean;
  keys: ConnectionKey[];
}

interface MintedKey extends ConnectionKey {
  plaintext: string;
}

export interface ConnectAssistantCardProps {
  /** The workspace this page is already targeting, resolved server-side. */
  spaceId: string;
  /** Its name, for the sentence that says which brain the key reaches. */
  spaceName: string;
}

function message(error: unknown, fallback: string): string {
  return error instanceof APIClientError ? error.message : fallback;
}

export function ConnectAssistantCard({
  spaceId,
  spaceName,
}: ConnectAssistantCardProps): React.ReactElement {
  const { state, message: statusMessage, run } = useSaveStatus();
  const [view, setView] = React.useState<KeysView | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  // The plaintext, held only while this card is open. A reload loses it, which
  // is the truth about the key rather than a limitation of the component.
  const [minted, setMinted] = React.useState<MintedKey | null>(null);
  const [confirmingRevoke, setConfirmingRevoke] = React.useState<string | null>(null);

  const load = React.useCallback(async (): Promise<void> => {
    try {
      setView(await apiClient.get<KeysView>(RESPARKABLE_API.spaceMcpKeys(spaceId)));
      setLoadError(null);
    } catch (error) {
      setLoadError(message(error, 'Could not read your keys for this workspace.'));
    }
  }, [spaceId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  // Neither of these clears `minted` when the request fails, and that is the
  // point rather than an omission. `setMinted` only ever runs after a response
  // arrives, so a failure leaves whatever was already on screen: a key the
  // person has not copied yet, which a failed **rotate** did not replace and
  // which is therefore still the working credential. Clearing it would destroy
  // a live secret nothing can show again, in response to a network blip.
  const generate = async (): Promise<void> => {
    await run(
      async () => {
        const key = await apiClient.post<MintedKey>(RESPARKABLE_API.spaceMcpKeys(spaceId));
        setMinted(key);
        await load();
      },
      (error) => message(error, 'Could not create a key.')
    );
  };

  const regenerate = async (keyId: string): Promise<void> => {
    await run(
      async () => {
        const key = await apiClient.post<MintedKey>(
          RESPARKABLE_API.spaceMcpKeyRotate(spaceId, keyId)
        );
        setMinted(key);
        await load();
      },
      (error) => message(error, 'Could not regenerate this key.')
    );
  };

  const revoke = async (keyId: string): Promise<void> => {
    await run(
      async () => {
        await apiClient.delete(RESPARKABLE_API.spaceMcpKey(spaceId, keyId));
        // Whatever was on screen refers to the key that has just gone.
        setMinted(null);
        setConfirmingRevoke(null);
        await load();
      },
      (error) => message(error, 'Could not revoke this key.')
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Plug className="h-5 w-5" aria-hidden="true" />
          Connect an AI assistant
        </CardTitle>
        <CardDescription>
          Give an assistant a key and it can read <strong>{spaceName}</strong> while you work
          somewhere else: ask what is on today, search what you have written, pass a thought across.
          It can add to your inbox. It cannot change or file anything.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {loadError ? (
          <p role="alert" className="text-destructive text-sm">
            {loadError}
          </p>
        ) : view === null ? (
          <p className="text-muted-foreground text-sm">Checking this workspace…</p>
        ) : (
          <>
            {/* The notice sits ABOVE the keys rather than replacing them.
                Revoking does not depend on the server being on, and a key you
                cannot see is a key you cannot revoke: a person who learns their
                key has leaked, on a day an administrator happens to have the
                server switched off, would otherwise be shown an explanation and
                no way to act. The key is inert while the server is off, but it
                comes back the moment the switch does. */}
            {!view.serverEnabled ? <ServerOffNotice /> : null}

            {view.keys.length === 0 ? (
              view.serverEnabled ? (
                <div className="flex items-center justify-between gap-4">
                  <div className="space-y-0.5">
                    <p className="text-sm font-medium">No assistant is connected yet.</p>
                    <p className="text-muted-foreground text-sm">
                      You will see the key once, when it is made.
                    </p>
                  </div>
                  <Button onClick={() => void generate()} disabled={state === 'saving'}>
                    Generate a key
                  </Button>
                </div>
              ) : null
            ) : (
              <ul className="space-y-3">
                {/* Every live key, not the first. One per workspace is a rule
                    this app applies when minting, not a database constraint, so
                    a second can exist and hiding it would hide a working
                    credential from the person holding it. */}
                {view.keys.map((key) => (
                  <li key={key.id}>
                    <KeyRow
                      entry={key}
                      busy={state === 'saving'}
                      confirming={confirmingRevoke === key.id}
                      onRegenerate={() => void regenerate(key.id)}
                      onAskRevoke={() => setConfirmingRevoke(key.id)}
                      onCancelRevoke={() => setConfirmingRevoke(null)}
                      onRevoke={() => void revoke(key.id)}
                    />
                  </li>
                ))}
              </ul>
            )}

            {minted ? <MintedKeyPanel minted={minted} /> : null}
          </>
        )}

        <SaveStatus
          state={state}
          message={state === 'error' ? statusMessage : null}
          className="mt-2"
        />
      </CardContent>
    </Card>
  );
}

/**
 * The server is off.
 *
 * Its own state rather than an empty list with a disabled button, because the
 * fix is somebody else's: a key minted against a server that is off would
 * install cleanly and then fail to connect, which is the twenty minutes of
 * debugging this notice exists to prevent.
 */
function ServerOffNotice(): React.ReactElement {
  return (
    <div className="bg-card space-y-1 rounded-md border p-3">
      <p className="text-sm font-medium">Assistants cannot connect to this install yet.</p>
      <p className="text-muted-foreground text-sm">
        Whoever administers this server has not switched the connection on. Ask them to, and this
        card will offer you a key.
      </p>
    </div>
  );
}

function KeyRow({
  entry,
  busy,
  confirming,
  onRegenerate,
  onAskRevoke,
  onCancelRevoke,
  onRevoke,
}: {
  entry: ConnectionKey;
  busy: boolean;
  confirming: boolean;
  onRegenerate: () => void;
  onAskRevoke: () => void;
  onCancelRevoke: () => void;
  onRevoke: () => void;
}): React.ReactElement {
  return (
    <div className="bg-card space-y-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="space-y-0.5">
          <p className="font-mono text-sm">{entry.keyPrefix}…</p>
          <p className="term-meta">
            {entry.lastUsedAt
              ? `Last used ${new Date(entry.lastUsedAt).toLocaleDateString()}`
              : 'Not used yet'}
          </p>
        </div>

        {confirming ? (
          // Inside the card, not a browser dialog: the question is about the
          // thing you are looking at, and the answer belongs beside it.
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm">Revoke this key?</span>
            <Button variant="destructive" size="sm" onClick={onRevoke} disabled={busy}>
              Revoke
            </Button>
            <Button variant="ghost" size="sm" onClick={onCancelRevoke} disabled={busy}>
              Cancel
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={onRegenerate} disabled={busy}>
              Regenerate
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="text-destructive"
              onClick={onAskRevoke}
              disabled={busy}
            >
              Revoke
            </Button>
          </div>
        )}
      </div>

      {confirming ? (
        <p className="text-muted-foreground text-xs">
          Any assistant using it stops reaching this workspace at once.
        </p>
      ) : null}
    </div>
  );
}

/**
 * The key, once.
 *
 * Deliberately worded as the one-off it is. The plaintext lives in this
 * component's state and in the response that put it there; nothing in the
 * system can show it again.
 */
function MintedKeyPanel({ minted }: { minted: MintedKey }): React.ReactElement {
  const { copied, copy } = useCopyToClipboard();
  const url = mcpUrl();

  return (
    <div className="space-y-3 rounded-md border border-dashed p-3">
      <div className="space-y-2">
        <p className="text-sm font-medium">Copy this key now. It is not shown again.</p>
        <div className="flex gap-2">
          <Input
            readOnly
            value={minted.plaintext}
            aria-label="Your new key"
            className="font-mono"
          />
          <Button variant="secondary" onClick={() => void copy(minted.plaintext)}>
            {copied ? (
              <Check className="h-4 w-4" aria-hidden="true" />
            ) : (
              <Copy className="h-4 w-4" aria-hidden="true" />
            )}
            <span className="sr-only">Copy key</span>
          </Button>
        </div>
        <p className="text-muted-foreground text-xs">
          If you lose it, regenerate: that makes a new one and retires this one.
        </p>
      </div>

      <div className="space-y-2">
        <p className="term-label">
          Set it up
          <FieldHelp title="Two Resparkable workspaces in one assistant">
            Each snippet calls the server <code>{RESPARKABLE_MCP_SERVER_NAME}</code>. If you already
            have one of these set up for another workspace, rename one of them by hand before
            pasting, or the second quietly replaces the first.
          </FieldHelp>
        </p>

        <Tabs defaultValue={MCP_CLIENT_SNIPPETS[0].id}>
          <TabsList className="h-auto w-full flex-wrap">
            {MCP_CLIENT_SNIPPETS.map((client) => (
              <TabsTrigger key={client.id} value={client.id}>
                {client.label}
              </TabsTrigger>
            ))}
          </TabsList>

          {MCP_CLIENT_SNIPPETS.map((client) => (
            <TabsContent key={client.id} value={client.id} className="space-y-2 pt-2">
              <SnippetPanel client={client} url={url} apiKey={minted.plaintext} />
            </TabsContent>
          ))}
        </Tabs>

        <p className="text-muted-foreground text-xs">
          Some assistants, {OAUTH_ONLY_CLIENTS.join(' and ')} among them, only connect by signing
          you in, and this server cannot offer that yet.
        </p>
      </div>
    </div>
  );
}

function SnippetPanel({
  client,
  url,
  apiKey,
}: {
  client: McpClientSnippet;
  url: string;
  apiKey: string;
}): React.ReactElement {
  const input = { url, key: apiKey };
  const command = client.command?.(input);

  return (
    <div className="space-y-2">
      <p className="text-muted-foreground text-xs">{client.location}</p>
      {command ? <CopyBlock body={command} label="Copy the command" /> : null}
      <CopyBlock body={client.config(input)} label="Copy the configuration" />
    </div>
  );
}

function CopyBlock({ body, label }: { body: string; label: string }): React.ReactElement {
  const { copied, copy } = useCopyToClipboard();

  return (
    <div className="space-y-1">
      <div className="bg-muted overflow-x-auto rounded-md p-3">
        <pre className="text-xs">
          <code>{body}</code>
        </pre>
      </div>
      <Button variant="ghost" size="sm" onClick={() => void copy(body)}>
        {copied ? (
          <Check className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
        ) : (
          <Copy className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
        )}
        {label}
      </Button>
    </div>
  );
}

/**
 * The address an assistant connects to.
 *
 * From the browser's own origin rather than a configured value: whatever host
 * this page was served from is the host the person can reach, which is the one
 * that belongs in their config. Server-rendered, there is no origin and the
 * path alone is returned; nothing renders a snippet in that pass.
 */
function mcpUrl(): string {
  if (typeof window === 'undefined') return RESPARKABLE_MCP_PATH;
  return `${window.location.origin}${RESPARKABLE_MCP_PATH}`;
}
