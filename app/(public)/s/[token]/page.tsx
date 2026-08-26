/**
 * `/s/[token]` — the public reader.
 *
 * The one page in Resparkable that renders someone's brain to a person with no
 * account. Four things about it are deliberate.
 *
 * **It reads the service directly, not its own API.** A server component
 * calling `readPublicShare` skips an HTTP hop it would only be making to talk
 * to itself. Rate limiting still applies: `proxy.ts` runs on page requests too,
 * and `lib/framework/resparkable/rate-limit.ts` registers a per-IP rule for
 * `/s/` as well as for the API route.
 *
 * **`/s/` is outside every protected prefix, and must stay there.**
 * `appProtectedRoutes` lists `/resparkable`; adding `/s` would put the edge
 * redirect-to-login in front of the one URL whose whole point is that it works
 * without an account.
 *
 * **`notFound()` for unknown, tampered, revoked and expired alike.** Same
 * requirement as the API route (§16.4), same reason: distinguishing them turns
 * the 404 into an oracle telling a stranger which tokens once existed.
 *
 * **`noindex` in the metadata, not only in `robots.txt`.** `robots.txt` is
 * advisory and does not remove an already-indexed URL. The `X-Robots-Tag`
 * header on the API route covers a crawler fetching the JSON directly; this
 * covers one rendering the page. The referrer policy is set as a document-level
 * `<meta name="referrer">` rather than a header, because a page cannot set
 * response headers in the App Router and this needs no core edit to work.
 */

import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { SharedMarkdown } from '@/components/resparkable/share/shared-markdown';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { readPublicShare } from '@/lib/framework/resparkable/services/sharing';
import type { SharedItemView } from '@/lib/framework/resparkable/repo/shared-view';
import { shareTokenSchema } from '@/lib/framework/resparkable/validations';

/**
 * Static, and identical for every share.
 *
 * The title must not name the item: page titles reach browser history, tab
 * lists, screen-sharing and OS-level search indexes, and "Q3 layoffs plan"
 * appearing in any of those is the leak this whole surface is careful about.
 * A reader who wants to know what they are looking at can read the page.
 */
export const metadata: Metadata = {
  title: 'Shared item',
  description: 'A single item, shared with a link.',
  robots: { index: false, follow: false, noarchive: true, nosnippet: true },
  referrer: 'no-referrer',
};

export default async function SharedItemPage({
  params,
}: {
  params: Promise<{ token: string }>;
}): Promise<React.ReactElement> {
  const { token } = await params;

  // Shape-checked before the database is touched. This page is
  // unauthenticated, and a length check is cheaper than an indexed miss.
  const parsed = shareTokenSchema.safeParse(token);
  if (!parsed.success) notFound();

  const payload = await readPublicShare(parsed.data);
  if (!payload) notFound();

  const { item, children, childrenTruncated } = payload;

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-10">
      <article>
        <header className="mb-6">
          <div className="text-muted-foreground mb-2 flex flex-wrap items-center gap-2 text-xs tracking-wide uppercase">
            <span>{item.entityType}</span>
            {item.horizon && <span>· {item.horizon}</span>}
            {item.archived && (
              // Surfaced rather than hidden: an archived item with a live link
              // still resolves, and a reader deserves to know they are looking
              // at thinking that has been set aside rather than current work.
              <Badge variant="outline">Archived</Badge>
            )}
          </div>
          <h1 className="text-2xl font-semibold text-balance">{item.title}</h1>
          <ItemMeta item={item} />
        </header>

        {item.body ? (
          <SharedMarkdown content={item.body} />
        ) : (
          <p className="text-muted-foreground text-sm">This item has no description.</p>
        )}
      </article>

      {children.length > 0 && (
        <section className="mt-10">
          <h2 className="mb-3 text-sm font-semibold tracking-wide uppercase">
            {children[0].entityType === 'goal' ? 'Goals' : 'Tasks'}
          </h2>
          <ul className="space-y-2">
            {children.map((child) => (
              <li key={`${child.entityType}:${child.id}`}>
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base font-medium">{child.title}</CardTitle>
                    <ItemMeta item={child} />
                  </CardHeader>
                  {child.body && (
                    <CardContent className="pt-0">
                      <SharedMarkdown content={child.body} className="text-sm" />
                    </CardContent>
                  )}
                </Card>
              </li>
            ))}
          </ul>
          {childrenTruncated && (
            // Said out loud rather than quietly cut. A list that stops without
            // saying so reads as the whole list.
            <p className="text-muted-foreground mt-3 text-xs">
              Showing the first {children.length}. There are more.
            </p>
          )}
        </section>
      )}

      <footer className="text-muted-foreground mt-12 border-t pt-4 text-xs">
        Shared with a link. This page shows one item and nothing else from its author&rsquo;s
        account.
      </footer>
    </div>
  );
}

/**
 * Status, due date, tags, checklist progress — whatever this item has.
 *
 * Never a score, never a boost rationale, never the project it belongs to.
 * Those are the owner's private opinion of their own work, and the projection
 * in `repo/shared-view.ts` does not load them at all — this component could not
 * render them if it tried.
 */
function ItemMeta({ item }: { item: SharedItemView }): React.ReactElement | null {
  const bits: React.ReactElement[] = [];

  if (item.status) {
    bits.push(
      <Badge key="status" variant="secondary">
        {item.status}
      </Badge>
    );
  }

  if (item.dueAt) {
    bits.push(
      <span key="due">
        Due <time dateTime={item.dueAt.toISOString()}>{item.dueAt.toISOString().slice(0, 10)}</time>
      </span>
    );
  }

  if (item.checklist) {
    bits.push(
      <span key="checklist">
        {item.checklist.done} of {item.checklist.total} done
      </span>
    );
  }

  for (const tag of item.tags) {
    bits.push(
      <Badge key={`tag:${tag}`} variant="outline">
        {tag}
      </Badge>
    );
  }

  if (bits.length === 0) return null;

  return (
    <div className="text-muted-foreground mt-2 flex flex-wrap items-center gap-2 text-xs">
      {bits}
    </div>
  );
}
