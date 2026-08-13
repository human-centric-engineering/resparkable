/**
 * Unit Tests: `composeSharedContent` — the share-target landing page's draft
 * composer.
 *
 * The one piece of logic on `/resparkable/capture` worth pinning down in
 * isolation: how `?title=&text=&url=` (Android's Web Share Target query
 * shape) becomes the textarea's initial value. Everything else on the page
 * is `QuickCapture`, already covered by its own test file.
 *
 * @see app/(protected)/resparkable/capture/page.tsx
 */

import { describe, it, expect } from 'vitest';

import { composeSharedContent } from '@/app/(protected)/resparkable/capture/page';

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
