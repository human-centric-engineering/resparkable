/**
 * Unit Tests: the setup snippet each assistant is given.
 *
 * A snippet is the one artefact here a person copies without reading, into a
 * file they will not look at again. A wrong one does not fail loudly: the
 * client loads nothing, reports no error, and the tools are simply absent. So
 * the per-client details that are easy to get subtly wrong get an assertion
 * each rather than a shared shape test.
 *
 * The one worth naming: **VS Code's top-level key is `servers`, not
 * `mcpServers`.** An otherwise identical config under the wrong key is valid
 * JSON that does nothing.
 *
 * Test Coverage:
 * - Every JSON snippet parses, and carries the key in an Authorization header
 * - Every snippet names the server `resparkable`, never the workspace
 * - VS Code uses `servers`; the other three use `mcpServers`
 * - Windsurf uses `serverUrl`, matching its own documentation
 * - The Claude Code command carries the transport, the name and the header
 * - The fallback snippet is the URL and the header, and claims no file format
 *
 * @see lib/framework/resparkable/mcp/client-snippets.ts
 */

import { describe, it, expect } from 'vitest';

import {
  MCP_CLIENT_SNIPPETS,
  RESPARKABLE_MCP_PATH,
  RESPARKABLE_MCP_SERVER_NAME,
  type McpClientSnippet,
  type SnippetInput,
} from '@/lib/framework/resparkable/mcp/client-snippets';

const INPUT: SnippetInput = {
  url: `https://resparkable.example${RESPARKABLE_MCP_PATH}`,
  key: 'smcp_TESTKEY0000000000000000000000',
};

function snippet(id: string): McpClientSnippet {
  const found = MCP_CLIENT_SNIPPETS.find((entry) => entry.id === id);
  if (!found) throw new Error(`No snippet for ${id}`);
  return found;
}

/** The JSON snippets, which is every one except the deliberate text fallback. */
const JSON_SNIPPETS = MCP_CLIENT_SNIPPETS.filter((entry) => entry.language === 'json');

describe('every client snippet', () => {
  it('covers the clients the card offers', () => {
    // Guards the `it.each` sweeps below from passing on a shortened list.
    expect(MCP_CLIENT_SNIPPETS.map((entry) => entry.id)).toEqual([
      'claude-code',
      'cursor',
      'vscode',
      'windsurf',
      'other',
    ]);
  });

  it.each(MCP_CLIENT_SNIPPETS.map((entry) => [entry.label, entry] as const))(
    '%s names where it goes',
    (_label, entry) => {
      // A snippet with no home is a snippet somebody pastes into the wrong file.
      expect(entry.location.length).toBeGreaterThan(0);
    }
  );

  it.each(MCP_CLIENT_SNIPPETS.map((entry) => [entry.label, entry] as const))(
    '%s carries the key and the address',
    (_label, entry) => {
      const body = entry.config(INPUT);

      expect(body).toContain(INPUT.key);
      expect(body).toContain(INPUT.url);
    }
  );
});

describe('every JSON snippet', () => {
  it.each(JSON_SNIPPETS.map((entry) => [entry.label, entry] as const))(
    '%s parses as JSON',
    (_label, entry) => {
      // The whole reason the builders serialise an object rather than
      // interpolating a template: this cannot regress into a broken brace.
      expect(() => JSON.parse(entry.config(INPUT))).not.toThrow();
    }
  );

  it.each(JSON_SNIPPETS.map((entry) => [entry.label, entry] as const))(
    '%s puts the key in an Authorization header, under the server name resparkable',
    (_label, entry) => {
      const parsed = JSON.parse(entry.config(INPUT)) as Record<
        string,
        Record<string, { headers?: Record<string, string> }>
      >;

      // One top-level key, whatever it is called, holding one server entry
      // named `resparkable`. Never the workspace: a per-workspace name makes
      // the snippet disagree with the docs and with existing configs.
      const [container] = Object.values(parsed);
      expect(Object.keys(container)).toEqual([RESPARKABLE_MCP_SERVER_NAME]);

      expect(container[RESPARKABLE_MCP_SERVER_NAME].headers).toEqual({
        Authorization: `Bearer ${INPUT.key}`,
      });
    }
  );
});

describe('the per-client details that are easy to get wrong', () => {
  it('gives VS Code `servers`, not `mcpServers`', () => {
    // The one mistake that produces valid JSON, no error, and no tools.
    const parsed = JSON.parse(snippet('vscode').config(INPUT)) as Record<string, unknown>;

    expect(Object.keys(parsed)).toEqual(['servers']);
  });

  it.each(['claude-code', 'cursor', 'windsurf'])('gives %s `mcpServers`', (id) => {
    const parsed = JSON.parse(snippet(id).config(INPUT)) as Record<string, unknown>;

    expect(Object.keys(parsed)).toEqual(['mcpServers']);
  });

  it('gives Windsurf `serverUrl`, matching its own documentation', () => {
    const parsed = JSON.parse(snippet('windsurf').config(INPUT)) as {
      mcpServers: Record<string, Record<string, unknown>>;
    };
    const entry = parsed.mcpServers[RESPARKABLE_MCP_SERVER_NAME];

    expect(entry.serverUrl).toBe(INPUT.url);
    expect(entry.url).toBeUndefined();
  });

  it('gives the other three `url`', () => {
    for (const id of ['claude-code', 'cursor', 'vscode']) {
      const parsed = JSON.parse(snippet(id).config(INPUT)) as Record<
        string,
        Record<string, Record<string, unknown>>
      >;
      const [container] = Object.values(parsed);

      expect(container[RESPARKABLE_MCP_SERVER_NAME].url, `${id} lost its url`).toBe(INPUT.url);
    }
  });

  it('declares the HTTP transport everywhere it belongs', () => {
    for (const entry of JSON_SNIPPETS) {
      const parsed = JSON.parse(entry.config(INPUT)) as Record<
        string,
        Record<string, Record<string, unknown>>
      >;
      const [container] = Object.values(parsed);

      expect(container[RESPARKABLE_MCP_SERVER_NAME].type, `${entry.id} lost its type`).toBe('http');
    }
  });
});

describe('the Claude Code command', () => {
  it('names the transport, the server and the header', () => {
    const command = snippet('claude-code').command?.(INPUT) ?? '';

    expect(command).toContain('claude mcp add --transport http');
    expect(command).toContain(RESPARKABLE_MCP_SERVER_NAME);
    expect(command).toContain(INPUT.url);
    expect(command).toContain(`"Authorization: Bearer ${INPUT.key}"`);
  });

  it('is the only snippet with a command, since it is the only client with a CLI here', () => {
    const withCommand = MCP_CLIENT_SNIPPETS.filter((entry) => entry.command).map(
      (entry) => entry.id
    );

    expect(withCommand).toEqual(['claude-code']);
  });
});

describe('the fallback snippet', () => {
  it('is the address and the header, and guesses at no file format', () => {
    const entry = snippet('other');
    const body = entry.config(INPUT);

    expect(entry.language).toBe('text');
    expect(body).toContain(INPUT.url);
    expect(body).toContain(`Authorization: Bearer ${INPUT.key}`);
    // A client whose format nobody here knows is better served by two values
    // than by a plausible-looking guess at its layout.
    expect(body).not.toContain('{');
  });
});
