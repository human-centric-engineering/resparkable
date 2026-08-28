/**
 * Unit Tests: `SharedMarkdown`, the renderer on the one page with no session.
 *
 * Two properties are the reason this component exists at all, and neither is
 * visible from the outside once it is wrong:
 *
 *   1. **A remote image does not fetch until the reader asks it to.** The
 *      deployment CSP allows `img-src https:`, so an image in a shared note
 *      fires on render, and on this page the person paying that cost is a
 *      stranger the owner sent a link to, not the note's author. A tracking
 *      pixel here reports every reader to a third party, silently.
 *   2. **Raw HTML never renders.** The page's whole premise is showing someone
 *      else's prose to people with no account.
 *
 * The interesting cases are the URL forms that *look* local and are not.
 * `//host/x.png` carries no scheme, so react-markdown's `defaultUrlTransform`
 * hands it through untouched and the browser resolves it against this page's
 * https origin, and a `^https?://` check never sees it. That form has its own test
 * because it is the one an author would reach for to slip past the gate.
 *
 * Test coverage:
 * - Absolute http/https images render as a placeholder, not an <img>
 * - Protocol-relative `//host/x` defers too, and the placeholder names the host
 * - Root-relative, bare-relative and `data:` images render immediately
 * - Clicking "Load image" swaps the placeholder for the real <img>
 * - Raw HTML in the source renders as inert text, never as an element
 *
 * @see components/resparkable/share/shared-markdown.tsx
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { SharedMarkdown } from '@/components/resparkable/share/shared-markdown';

/** The rendered <img> elements, which is the only thing that can phone out. */
function images(container: HTMLElement): HTMLImageElement[] {
  return Array.from(container.querySelectorAll('img'));
}

describe('SharedMarkdown', () => {
  describe('remote images are deferred', () => {
    it.each([
      ['https', '![pixel](https://tracker.example/p.gif)', 'tracker.example'],
      ['http', '![pixel](http://tracker.example/p.gif)', 'tracker.example'],
      // No scheme at all, so nothing that inspects the scheme rejects it, and
      // the browser supplies this page's https at fetch time.
      ['protocol-relative', '![pixel](//tracker.example/p.gif)', 'tracker.example'],
    ])('defers a %s image and names the host', async (_label, markdown, host) => {
      const { container } = render(<SharedMarkdown content={markdown} />);

      expect(images(container)).toHaveLength(0);
      expect(screen.getByRole('button', { name: /load image/i })).toBeInTheDocument();
      expect(screen.getByText(host)).toBeInTheDocument();
    });

    it('loads the image only after the reader clicks', async () => {
      const user = userEvent.setup();
      const { container } = render(
        <SharedMarkdown content="![pixel](https://tracker.example/p.gif)" />
      );

      expect(images(container)).toHaveLength(0);

      await user.click(screen.getByRole('button', { name: /load image/i }));

      const [img] = images(container);
      expect(img).toBeDefined();
      expect(img.getAttribute('src')).toBe('https://tracker.example/p.gif');
    });
  });

  describe('same-origin and inline images render immediately', () => {
    it.each([
      ['root-relative', '![logo](/logo.png)', '/logo.png'],
      ['bare relative', '![logo](logo.png)', 'logo.png'],
    ])('renders a %s image with no placeholder', (_label, markdown, expected) => {
      const { container } = render(<SharedMarkdown content={markdown} />);

      const [img] = images(container);
      expect(img).toBeDefined();
      expect(img.getAttribute('src')).toBe(expected);
      expect(screen.queryByRole('button', { name: /load image/i })).not.toBeInTheDocument();
    });
  });

  it.each([
    // Throws in `new URL`: no host to parse out of a bare `//`.
    ['an unparseable src', '![](//)'],
    // Parses cleanly and still has no host. A scheme react-markdown allows,
    // which is why it reaches the component at all.
    ['a src with no host', '![](mailto:someone@example.com)'],
  ])('falls back to a generic label for %s', (_label, markdown) => {
    // The reader still gets the choice. A src this component cannot describe is
    // not one it should quietly load on their behalf.
    render(<SharedMarkdown content={markdown} />);

    expect(screen.getByText(/another site/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /load image/i })).toBeInTheDocument();
  });

  it('describes a deferred image by its alt text when it has one', () => {
    render(<SharedMarkdown content="![Q3 revenue chart](https://tracker.example/c.png)" />);
    expect(screen.getByText(/Image: Q3 revenue chart/)).toBeInTheDocument();
  });

  it('renders a loaded image with an empty alt rather than no alt at all', async () => {
    // `alt=""` marks an image decorative to a screen reader; a missing `alt`
    // makes it announce the filename, which on this page is someone else's URL.
    const user = userEvent.setup();
    const { container } = render(<SharedMarkdown content="![](https://tracker.example/c.png)" />);

    await user.click(screen.getByRole('button', { name: /load image/i }));

    const [img] = images(container);
    expect(img.getAttribute('alt')).toBe('');
  });

  it('renders a same-origin image with an empty alt when the source gives none', () => {
    const { container } = render(<SharedMarkdown content="![](/logo.png)" />);

    const [img] = images(container);
    expect(img.getAttribute('src')).toBe('/logo.png');
    expect(img.getAttribute('alt')).toBe('');
  });

  it('renders nothing for a src the parser stripped, never <img src="">', () => {
    // `react-markdown`'s allowlist is `http`, `https`, `mailto`, `irc`, `xmpp`.
    // Every other scheme is rewritten to `''` before this component sees it,
    // and `<img src="">` is not an empty image: the browser resolves it against
    // the document URL and fetches this page a second time.
    const { container } = render(
      <SharedMarkdown content="![dot](data:image/gif;base64,R0lGODlhAQABAAAAACw=)" />
    );

    expect(images(container)).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /load image/i })).not.toBeInTheDocument();
  });

  it('renders raw HTML as inert text, never as an element', () => {
    // `remark-gfm` is parser-level and permits no raw HTML. If someone adds
    // `rehype-raw` here, this is the test that fails, which is the point.
    const { container } = render(
      <SharedMarkdown content={'<img src="https://tracker.example/p.gif">\n\n<b>bold</b>'} />
    );

    expect(images(container)).toHaveLength(0);
    expect(container.querySelector('b')).toBeNull();
    expect(container.textContent).toContain('<b>bold</b>');
  });

  it('renders ordinary prose', () => {
    render(<SharedMarkdown content={'# Heading\n\nA paragraph.'} />);

    expect(screen.getByRole('heading', { name: 'Heading' })).toBeInTheDocument();
    expect(screen.getByText('A paragraph.')).toBeInTheDocument();
  });
});
