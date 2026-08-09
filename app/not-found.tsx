import Link from 'next/link';
import type { Metadata } from 'next';
import { Button } from '@/components/ui/button';
import { SparkGlyph } from '@/components/brand/spark-glyph';
import { BrandMark } from '@/components/brand/brand-mark';

export const metadata: Metadata = {
  title: 'Not found',
  robots: { index: false, follow: false },
};

/**
 * Root 404.
 *
 * **Fork-owned scaffold.** What was here was the template's placeholder: an
 * unstyled `h2`, "Could not find requested resource", and a `bg-blue-500`
 * button. The hardcoded blue was the tell: it is the one colour in the codebase
 * that follows neither the theme toggle nor the `/admin` swap, so this page
 * rendered a stranger's first impression in a palette the product does not own.
 *
 * This is the page most likely to be seen by someone who has never heard of us:
 * a stale link, a typo, a search result that moved. So it is treated as a
 * public page rather than as an error state: the mark, one sentence in the
 * product's own voice, and two doors that open.
 *
 * It is the root boundary, so it renders outside any route group's layout and
 * has to bring its own header and its own page field.
 */
export default function NotFound() {
  return (
    <div className="obsidian-field flex min-h-screen flex-col">
      <header className="border-border/60 obsidian-chrome border-b">
        <div className="container mx-auto flex items-center px-4 py-3.5">
          <Link href="/" className="text-lg transition-opacity hover:opacity-75">
            <BrandMark />
          </Link>
        </div>
      </header>

      <main className="flex flex-1 items-center justify-center px-4 py-20">
        <div className="max-w-md text-center">
          <SparkGlyph className="obsidian-reveal mx-auto h-7 w-[52px] opacity-50" />

          <p className="term-label obsidian-reveal mt-8" style={{ animationDelay: '70ms' }}>
            404
          </p>

          <h1
            className="obsidian-reveal mt-4 text-3xl sm:text-4xl"
            style={{ animationDelay: '140ms' }}
          >
            Nothing here.
          </h1>

          <p
            className="text-muted-foreground obsidian-reveal mt-5 leading-relaxed"
            style={{ animationDelay: '210ms' }}
          >
            This address does not lead anywhere. It may have moved, or it may never have existed.
            Either way it is not worth your time.
          </p>

          <div
            className="obsidian-reveal mt-8 flex flex-wrap justify-center gap-3"
            style={{ animationDelay: '280ms' }}
          >
            <Button asChild>
              <Link href="/">Go to the front page</Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/contact">Tell us what broke</Link>
            </Button>
          </div>
        </div>
      </main>
    </div>
  );
}
