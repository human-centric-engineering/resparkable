/**
 * Unit Tests: `/resparkable/capture` — the share-target landing page.
 *
 * Two things worth pinning down: `composeSharedContent`, in isolation (how
 * `?title=&text=&url=` — Android's Web Share Target query shape — becomes the
 * textarea's initial value), and the page component itself, which is where
 * that value and its `initialSource: 'pwa'` tag actually reach `QuickCapture`.
 * The latter is easy to get wrong silently: `{...(initialValue ? {...} : {})}`
 * is exactly the kind of conditional-spread that can flip a truthy check the
 * wrong way with no type error to catch it.
 *
 * @see app/(resparkable)/resparkable/capture/page.tsx
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/components/resparkable/layout/quick-capture', () => ({
  QuickCapture: (props: Record<string, unknown>) => (
    <div data-testid="quick-capture" data-props={JSON.stringify(props)} />
  ),
}));

import ResparkableCapturePage, {
  composeSharedContent,
} from '@/app/(resparkable)/resparkable/capture/page';

function searchParams(params: Record<string, string | string[] | undefined>) {
  return Promise.resolve(params);
}

async function renderPage(params: Record<string, string | string[] | undefined>) {
  const element = await ResparkableCapturePage({ searchParams: searchParams(params) });
  render(element);
  return JSON.parse(screen.getByTestId('quick-capture').dataset.props ?? '{}') as Record<
    string,
    unknown
  >;
}

describe('ResparkableCapturePage', () => {
  it('passes the composed content as initialValue, tagged initialSource: "pwa"', async () => {
    const props = await renderPage({ title: 'Recipe', text: 'Try this for dinner' });

    expect(props).toMatchObject({
      initialValue: 'Recipe\n\nTry this for dinner',
      initialSource: 'pwa',
    });
  });

  it('omits initialSource entirely when nothing was shared', async () => {
    // Not `initialSource: undefined` — the conditional spread must not add
    // the key at all, or QuickCapture's own `initialSource ?? undefined`
    // default would be shadowed by an explicit `undefined` the same way.
    const props = await renderPage({});

    expect(props.initialValue).toBe('');
    expect('initialSource' in props).toBe(false);
  });

  it('focuses the box on open, same as the drawer does for ⌘K', async () => {
    const props = await renderPage({ text: 'hello' });

    expect(props.focusSignal).toBe(1);
  });
});

describe('composeSharedContent', () => {
  it('joins title and text with a blank line', () => {
    expect(composeSharedContent({ title: 'Recipe', text: 'Try this for dinner' })).toBe(
      'Recipe\n\nTry this for dinner'
    );
  });

  it('appends the url on its own line when the text does not already contain it', () => {
    expect(
      composeSharedContent({
        title: 'A great article',
        text: 'You should read this',
        url: 'https://example.com/article',
      })
    ).toBe('A great article\n\nYou should read this\n\nhttps://example.com/article');
  });

  it('does not duplicate the url when the shared text already contains it', () => {
    // Most browser share sheets ("Share page…") put the link inside `text`
    // already — appending it again would be noise at the bottom of every
    // shared page.
    expect(
      composeSharedContent({
        text: 'Check this out: https://example.com/article',
        url: 'https://example.com/article',
      })
    ).toBe('Check this out: https://example.com/article');
  });

  it('handles a url-only share (no title, no text)', () => {
    expect(composeSharedContent({ url: 'https://example.com' })).toBe('https://example.com');
  });

  it('returns an empty string when nothing was shared', () => {
    expect(composeSharedContent({})).toBe('');
  });

  it('trims whitespace-only fields out entirely', () => {
    expect(composeSharedContent({ title: '   ', text: 'Only this' })).toBe('Only this');
  });

  it('takes the first value when a param arrives as an array', () => {
    // Next.js hands repeated query params (`?text=a&text=b`) back as arrays.
    expect(composeSharedContent({ text: ['first', 'second'] })).toBe('first');
  });
});
