'use client';

/**
 * Markdown for a shared page — the same renderer as everywhere else, with one
 * difference that only matters here.
 *
 * ## Remote images are click-to-load
 *
 * The deployment CSP allows `img-src https:`, so `![](https://attacker/x?t=…)`
 * in a note fires the moment the page renders. On the owner's own surfaces that
 * is mostly self-inflicted — it is their note. **On a shared page it is not.**
 * A note that arrived from an untrusted source (a vault sync from someone
 * else's repo, a pasted document) can carry a tracking pixel, and every person
 * the owner shares the page with silently pings a third party. The reader never
 * agreed to that and cannot see it happening.
 *
 * So a remote image renders as a placeholder the reader can choose to load.
 * Same-origin images render normally: those cannot phone anywhere.
 *
 * `data:` images never arrive at all. `react-markdown`'s `defaultUrlTransform`
 * allows only `http`, `https`, `mailto`, `irc` and `xmpp`, and rewrites every
 * other scheme to the empty string, so an inline image in a shared note is
 * dropped by the parser before this component sees it. That is the framework's
 * decision rather than this page's, and the empty `src` it produces is handled
 * below rather than passed to an `<img>`, which the browser would resolve as a
 * second request for the current page.
 *
 * Tightening `img-src` globally would be the other fix and it is worse — it
 * would break every legitimate image on the owner's own surfaces to close a
 * hole that only exists on this one.
 *
 * ## No raw HTML, ever
 *
 * `remark-gfm` is a parser-level extension: tables, task lists, strikethrough,
 * autolinks. It does **not** permit raw HTML, so a `<script>` in the source
 * renders as inert text. Do NOT add `rehype-raw` or `allowDangerousHtml` here —
 * on a page whose whole premise is rendering someone else's prose to strangers,
 * that would turn a note into an XSS sink.
 */

import { useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { MARKDOWN_BLOCK_CLASSES } from '@/components/admin/orchestration/markdown-or-raw-view';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * Can this src reach a third party if the browser fetches it automatically?
 *
 * Asked as an allowlist, not as a match on `https?://`, because of
 * **protocol-relative URLs**. `![](//tracker.example/p.gif)` has no scheme, so
 * react-markdown's `defaultUrlTransform` passes it through untouched (it only
 * strips a URL whose *scheme* is unsafe, and this one has none), and the
 * browser then resolves it against this page's https origin. It reaches the
 * third party exactly as `https://tracker.example/p.gif` does. A check anchored
 * on `https?://` never sees it, which would leave the gate open to the one form
 * an author would reach for if they were trying to slip past it.
 *
 * Anything else carrying a scheme defers too. The caller has already discarded
 * an empty `src`, which is what every scheme react-markdown rejects, `data:`
 * included, has been rewritten to by the time it gets here. So a scheme
 * arriving at this function is one the parser allowed, and none of those are
 * this origin.
 *
 * What is left is a root-relative `/x.png` or a bare `x.png`: this origin,
 * rendered immediately.
 */
function isRemote(src: string): boolean {
  if (src.startsWith('//')) return true;
  return /^[a-z][a-z0-9+.-]*:/i.test(src);
}

function DeferredImage({ src, alt }: { src?: string; alt?: string }): React.ReactElement | null {
  const [loaded, setLoaded] = useState(false);

  // No src, or one the parser rewrote to `''` because its scheme is not on
  // react-markdown's allowlist. `<img src="">` is not an empty image: the
  // browser resolves it against the document URL and fetches this page again.
  if (!src) return null;

  if (!isRemote(src)) {
    // Same-origin or a data URI. Nothing to defer — a plain <img> rather than
    // next/image because the source is arbitrary markdown, not a known asset.
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt={alt ?? ''} className="max-w-full rounded" />;
  }

  if (loaded) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt={alt ?? ''} className="max-w-full rounded" />;
  }

  let host = 'another site';
  try {
    // A protocol-relative src has no scheme for `URL` to parse, and it is the
    // page's own origin that supplies one at fetch time. Naming the host is the
    // whole value of the placeholder, so give it the scheme the browser would.
    const absolute = src.startsWith('//') ? `https:${src}` : src;
    host = new URL(absolute).host || host;
  } catch {
    // A src that does not parse is not one worth naming. The placeholder still
    // renders, and the reader still gets the choice.
  }

  return (
    <span className="border-border bg-muted/40 my-2 flex flex-col items-start gap-2 rounded border border-dashed p-3 text-sm">
      <span className="text-muted-foreground">
        {alt ? `Image: ${alt}` : 'Image'} — hosted by <span className="font-medium">{host}</span>.
        Loading it tells that site you opened this page.
      </span>
      <Button type="button" size="sm" variant="secondary" onClick={() => setLoaded(true)}>
        Load image
      </Button>
    </span>
  );
}

export function SharedMarkdown({
  content,
  className,
}: {
  content: string;
  className?: string;
}): React.ReactElement {
  return (
    <div className={cn(MARKDOWN_BLOCK_CLASSES, className)}>
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          img: ({ src, alt }) => (
            <DeferredImage src={typeof src === 'string' ? src : undefined} alt={alt} />
          ),
        }}
      >
        {content}
      </Markdown>
    </div>
  );
}
