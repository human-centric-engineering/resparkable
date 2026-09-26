// @vitest-environment happy-dom

/**
 * Unit Tests: `ResparkableGroupJoinPage` (server component, phase 57).
 *
 * Mirrors `ResparkableInvitePage`'s test in `pages.misc.test.tsx`: the page
 * reads nothing and validates nothing itself, it passes the raw token
 * through to `JoinGroup`, which asks before it POSTs. The metadata is
 * `noindex`/`nofollow` with no referrer, because the URL is a bearer
 * credential and nothing about it belongs in a search index, a browser
 * history entry, or another site's logs.
 *
 * @see app/(resparkable)/resparkable/groups/join/[token]/page.tsx
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/components/resparkable/groups/join-group', () => ({
  JoinGroup: (props: { token: string }) => (
    <div data-testid="join-group" data-props={JSON.stringify(props)} />
  ),
}));

describe('ResparkableGroupJoinPage', () => {
  const TOKEN = 'group-join-token-abc123';

  it('awaits params and passes the token through to JoinGroup, validating nothing itself', async () => {
    const { default: ResparkableGroupJoinPage } =
      await import('@/app/(resparkable)/resparkable/groups/join/[token]/page');

    render(await ResparkableGroupJoinPage({ params: Promise.resolve({ token: TOKEN }) }));

    const view = screen.getByTestId('join-group');
    expect(view.getAttribute('data-props')).toBe(JSON.stringify({ token: TOKEN }));
  });

  it('sets noindex, nofollow metadata with no referrer, and a title that names no group', async () => {
    const { metadata } = await import('@/app/(resparkable)/resparkable/groups/join/[token]/page');

    expect(metadata.robots).toMatchObject({ index: false, follow: false });
    expect(metadata.referrer).toBe('no-referrer');
    // The URL is a bearer credential to a shared workspace; naming a group in
    // <title> would put it in this reader's browser history and tab strip.
    expect(typeof metadata.title).toBe('string');
    expect(JSON.stringify(metadata.title)).not.toMatch(/study|recipe|allotment/i);
  });
});
