import Link from 'next/link';
import { BrandMark } from '@/components/brand/brand-mark';
import { SparkMesh } from '@/components/brand/spark-mesh';

/**
 * FooterBand — the mark, once, at size, at the bottom of every public page.
 *
 * **Fork-owned.** It sits *above* `PublicFooter` rather than replacing it. That
 * footer is platform-maintained and carries the Cookie Preferences control,
 * which the platform renders unconditionally because consent is a legal
 * requirement rather than a fork's styling decision. Forking it to add a logo
 * would take on that whole surface for one graphic and inherit every upstream
 * fix by hand afterwards. A band above it costs nothing and merges cleanly.
 *
 * The mesh behind the lockup is the same component the hero runs, dropped to a
 * value where it reads as a watermark. Repeating a graphic at full strength at
 * both ends of a page makes the page look like it has two openings; at 30% it
 * closes the page instead of restarting it.
 *
 * The three verbs are set in `.term-meta` because they are a caption on the
 * mark, not a claim of their own — the claims are all above this, and a
 * sign-off that argues is a sign-off that gets read twice.
 */
export function FooterBand(): React.ReactNode {
  return (
    <section className="border-border/70 relative overflow-hidden border-t">
      <div
        className="pointer-events-none absolute inset-0 flex items-center justify-center"
        aria-hidden="true"
      >
        <div className="w-[34rem] max-w-[150%] opacity-30">
          <SparkMesh />
        </div>
      </div>

      <div className="relative container mx-auto flex flex-col items-center gap-5 px-4 py-14 text-center md:py-16">
        <Link href="/" className="transition-opacity hover:opacity-75">
          <BrandMark className="text-2xl sm:text-3xl" />
        </Link>

        <p className="text-muted-foreground max-w-sm leading-relaxed text-balance">
          Ideas are not for keeping. They are for what they set off.
        </p>

        <p className="term-meta">catch · kindle · ignite</p>
      </div>
    </section>
  );
}
