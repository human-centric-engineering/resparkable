/**
 * The setup snippet for each assistant that can hold a key, in one module.
 *
 * Client config formats move, and when one moves the fix should be a one-line
 * edit here with a test beside it, not a hunt through JSX. Every snippet is
 * built from an object and serialised, so a snippet cannot be syntactically
 * invalid JSON the way a template string quietly can.
 *
 * ## The server entry is always called `resparkable`
 *
 * Never the workspace's name, and this is a lesson inherited rather than
 * learned: a per-workspace entry name makes the snippet disagree with the docs
 * and with every config the person already has, so a second workspace's snippet
 * reads as a different product. The cost is the caveat below, and it is the
 * cheaper of the two.
 *
 * **Two Resparkable deployments in one config need a hand-rename.** The entries
 * differ only in `url`, so pasting the second silently replaces the first and
 * the tools simply point somewhere else. The card says so.
 *
 * ## Which clients are here, and why some are not
 *
 * Core's MCP server is **bearer-only**: a key goes in an `Authorization`
 * header, and there is no sign-in flow. So the dividing line is not how good a
 * client is, it is whether it has somewhere to put a header.
 *
 * Verified against each client's own documentation on 2026-09-20, which is what
 * the plan means by checking the list at build time:
 *
 *   • **Claude Code** — `claude mcp add --transport http`, or `.mcp.json`
 *   • **Cursor** — `.cursor/mcp.json`, `mcpServers`
 *   • **VS Code** — `.vscode/mcp.json`, whose top-level key is `servers`
 *   • **Windsurf** — `~/.codeium/windsurf/mcp_config.json`, `serverUrl`
 *   • **Anything else** taking a URL and a header
 *
 * **Claude Desktop is deliberately absent**, and this is a correction to the
 * plan that proposed this feature. Its remote-server path is Custom Connectors,
 * which take a URL and then run the server's own authentication flow; there is
 * no header field to put a key in, and its config file's server entries are
 * local `command`/`args` ones. So it sits with the web chat apps, in the group
 * the card tells people plainly it cannot serve yet. OAuth 2.1 would fix all of
 * them at once and is a core change, not a fork one.
 */

/**
 * The name of the server entry in every config, everywhere, for ever.
 *
 * One constant rather than a literal per snippet, so the four cannot drift
 * apart and so the docs can cite the same value.
 */
export const RESPARKABLE_MCP_SERVER_NAME = 'resparkable';

/** Where core mounts the MCP transport. */
export const RESPARKABLE_MCP_PATH = '/api/v1/mcp';

/** What every builder below needs, and all it needs. */
export interface SnippetInput {
  /** Absolute, including the origin: a relative URL configures nothing. */
  url: string;
  /** The plaintext key, which exists for exactly as long as the card shows it. */
  key: string;
}

export interface McpClientSnippet {
  id: string;
  /** What the tab says. */
  label: string;
  /** The file this goes in, named exactly, or how else to reach the setting. */
  location: string;
  /** How to highlight the body, and what a copy button is handing over. */
  language: 'json' | 'text';
  /** An optional one-line alternative, for clients that have a CLI. */
  command?: (input: SnippetInput) => string;
  /** The block to paste. */
  config: (input: SnippetInput) => string;
}

/** `Authorization: Bearer <key>`, spelled once. */
function bearer(key: string): Record<string, string> {
  return { Authorization: `Bearer ${key}` };
}

/**
 * The entry body three of the four clients share.
 *
 * Built and serialised rather than interpolated into a template, so a key
 * containing a quote could not produce a config that fails to parse. Keys are
 * base62 and cannot today, which is exactly the kind of thing that stops being
 * true without anybody revisiting the snippet that assumed it.
 */
function httpEntry(input: SnippetInput, urlKey: 'url' | 'serverUrl' = 'url'): object {
  return {
    type: 'http',
    [urlKey]: input.url,
    headers: bearer(input.key),
  };
}

function render(value: object): string {
  return JSON.stringify(value, null, 2);
}

export const MCP_CLIENT_SNIPPETS: readonly McpClientSnippet[] = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    location: '.mcp.json in the project root, or run the command for a user-wide entry',
    language: 'json',
    command: (input) =>
      `claude mcp add --transport http ${RESPARKABLE_MCP_SERVER_NAME} ${input.url} \\\n  --header "Authorization: Bearer ${input.key}"`,
    config: (input) => render({ mcpServers: { [RESPARKABLE_MCP_SERVER_NAME]: httpEntry(input) } }),
  },
  {
    id: 'cursor',
    label: 'Cursor',
    location: '.cursor/mcp.json in the project, or ~/.cursor/mcp.json for every project',
    language: 'json',
    config: (input) => render({ mcpServers: { [RESPARKABLE_MCP_SERVER_NAME]: httpEntry(input) } }),
  },
  {
    id: 'vscode',
    label: 'VS Code',
    location: '.vscode/mcp.json in the project',
    language: 'json',
    // The one that catches people out: the top-level key here is `servers`,
    // not `mcpServers`. A config that is otherwise identical loads nothing and
    // reports no error.
    config: (input) => render({ servers: { [RESPARKABLE_MCP_SERVER_NAME]: httpEntry(input) } }),
  },
  {
    id: 'windsurf',
    label: 'Windsurf',
    location: '~/.codeium/windsurf/mcp_config.json, or Cascade’s MCP panel, "View raw config"',
    language: 'json',
    // Windsurf accepts `url` too, but its own examples use `serverUrl`, and a
    // snippet that matches the documentation the person will search is worth
    // more than one that is merely also valid.
    config: (input) =>
      render({ mcpServers: { [RESPARKABLE_MCP_SERVER_NAME]: httpEntry(input, 'serverUrl') } }),
  },
  {
    id: 'other',
    label: 'Anything else',
    location: 'Any assistant that takes an address and a header',
    language: 'text',
    // Not JSON: a client whose format nobody here knows is better served by the
    // two values than by a guess at its file layout.
    config: (input) => `${input.url}\n\nAuthorization: Bearer ${input.key}`,
  },
];

/**
 * Assistants that cannot use one of these keys, named so nobody spends an
 * evening on it.
 *
 * Not a list of bad clients. A list of clients whose only way in is a sign-in
 * flow, which a bearer-only server does not offer.
 */
export const OAUTH_ONLY_CLIENTS = ['Claude Desktop', 'the web chat assistants'];
