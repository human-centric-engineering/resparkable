import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { SparkWordmark } from '@/components/brand/spark-wordmark';
import { SparkMesh } from '@/components/brand/spark-mesh';

/**
 * The landing page's opening screen.
 *
 * **Fork-owned.** Sunrise's platform `Hero` is a centred title/description/two
 * buttons block, which is the shape every starter template ships. This one is
 * left-aligned against the page grid instead, with the mark (opened out into
 * the graph it is drawn from) holding the right half.
 *
 * ## Why there is artwork here now, when there deliberately was not
 *
 * What used to be here was a mocked-up capture panel, and the reason it went
 * still stands: a diagram of the product is not the product, and a reader who
 * has to decode a fake screenshot before the first sentence has been given work
 * rather than an answer. `SparkMesh` is not that. It claims no feature and
 * shows no interface. It is the logo at a size where you can see what it is made
 * of: nodes, edges, and one spark going round. That is the same thing the
 * headline says: this product does not ask you to hold onto anything.
 *
 * ## The headline
 *
 * It was "Never lose a good idea." for a while, and that was the wrong promise
 * in this product's own terms. Loss-aversion is the note-taking genre's default
 * pitch and it frames an idea as property: something you accumulate and guard,
 * whose worth is in the having. The opposite is the case. A spark is worth
 * something only while it is moving, and the app's whole job is to keep it
 * moving rather than to file it safely away. So the headline states what the
 * product actually does, in plain terms, and the subhead fills in the rest.
 *
 * The second half was "Get it back when it matters.", which was accurate and
 * flat, then "Catch and kindle the spark of an idea, then ignite others.",
 * which ran the full arc but read as a description rather than a hook. The
 * headline now asks the question instead: "Is your idea resparkable?" puts
 * the product's own name in the reader's mouth as a verb, and the rest of the
 * page is the answer.
 *
 * ## Why the type is a step smaller than a hero's usually is
 *
 * `text-3xl / 4xl / 5xl`, not `4xl / 5xl / 6xl`. The headline is a whole
 * sentence rather than a phrase, and at `6xl` inside `max-w-xl` it breaks to
 * five lines and starts competing with the mesh for the top of the screen. The
 * size is set by the line, not the other way round: shorten the headline and the
 * old scale is the right one again.
 *
 * ## Motion
 *
 * One orchestrated arrival: five elements on `.lattice-reveal` with inline
 * delays climbing in 70ms steps, and `prefers-reduced-motion` handled by the
 * class. The mesh's own animation is continuous, which is the single exception
 * to the app's stillness rule and is fenced to the public pages. See
 * `brand-theme.css` §mesh.
 *
 * `overflow-hidden` on the section is load-bearing: the mesh is deliberately
 * bled past the right edge, and without it that becomes horizontal page scroll
 * on every narrow viewport.
 */
export function LandingHero(): React.ReactNode {
  return (
    <section className="relative overflow-hidden">
      <div className="pointer-events-none absolute inset-0" aria-hidden="true">
        <div className="absolute -top-10 -right-[24%] w-[150%] opacity-[0.28] sm:-right-[16%] sm:w-[115%] lg:top-1/2 lg:-right-[6%] lg:w-[54%] lg:-translate-y-1/2 lg:opacity-100">
          <SparkMesh />
        </div>
      </div>

      <div className="relative container mx-auto px-4 pt-16 pb-16 md:pt-28 md:pb-28">
        <div className="max-w-3xl lg:max-w-xl">
          <p className="term-label lattice-reveal">catch · kindle · ignite</p>

          <h1
            className="lattice-reveal mt-5 text-3xl sm:text-4xl md:text-5xl"
            style={{ animationDelay: '70ms' }}
          >
            Is your idea resparkable?
          </h1>

          <p
            className="text-muted-foreground lattice-reveal mt-6 text-lg leading-relaxed"
            style={{ animationDelay: '140ms' }}
          >
            <SparkWordmark className="text-foreground text-[0.95em]" /> catches the thought that
            turns up while you are doing something else. Nothing to file, just one line. It brings
            it back joined to the notes, tasks, projects and goals it turned out to belong with, and
            puts it where it can be acted on. Catching it was always the easy part.
          </p>

          <div
            className="lattice-reveal mt-8 flex flex-wrap items-center gap-3"
            style={{ animationDelay: '210ms' }}
          >
            <Button asChild size="lg">
              <Link href="/signup">Create an account</Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link href="#built">See what it does</Link>
            </Button>
          </div>

          <p className="term-meta lattice-reveal mt-8" style={{ animationDelay: '280ms' }}>
            Private by default · Never used to train anything · Take everything with you
          </p>
        </div>
      </div>
    </section>
  );
}
