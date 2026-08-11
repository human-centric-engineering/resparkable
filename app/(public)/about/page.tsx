import type { Metadata } from 'next';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { PublicSection, NumberedItem } from '@/components/marketing/resparkable/public-section';
import { SparkWordmark } from '@/components/brand/spark-wordmark';
import { SparkMesh } from '@/components/brand/spark-mesh';
import { SparkGlyph, SparkRule } from '@/components/brand/spark-glyph';

const description =
  'Why Resparkable exists, how it works, and the promises it makes about the things you write down.';

export const metadata: Metadata = {
  title: 'About',
  description,
  openGraph: { title: 'About - Resparkable', description },
  twitter: { card: 'summary_large_image', title: 'About - Resparkable', description },
};

/**
 * How it works, in the order it happens to you.
 *
 * Four steps, no internals. Anyone reading this page is deciding whether to
 * trust it with their thinking, not reviewing its architecture.
 */
const HOW = [
  {
    term: 'You write one line.',
    body: 'From the web, your phone, your voice or an assistant you already talk to. There is nothing to fill in and nothing to decide. The moment you have an idea is the worst possible moment to be asked which folder it goes in.',
  },
  {
    term: 'It works out what you meant.',
    body: 'The line is read for what it is about and put where it belongs: an idea, a task, something for a project already under way, or a person you keep meaning to speak to.',
  },
  {
    term: 'It looks for what it connects to.',
    body: 'Overnight, everything you have written is read back over and compared. Things that belong together are brought to you with a reason, and you decide. This is where a thought written in March gets struck against one from January and both get louder.',
  },
  {
    term: 'It hands it back, lit.',
    body: 'In the morning briefing, at the top of the right list, beside the project it belongs to, or in an answer when you ask. From there it is yours to act on, build with, or give to whoever can do more with it than you can.',
  },
];

/**
 * The promises.
 *
 * Deliberately about the reader's content rather than the codebase — each one is
 * something a person can hold us to, not an implementation note.
 */
const PROMISES = [
  {
    term: 'What you write is yours.',
    body: 'Ownership here means control rather than confinement. Your ideas, notes and documents belong to you, you can take all of it out at any time as plain markdown that opens in any editor, and you can delete it for good. A system you cannot walk out of is asking you to treat your own thinking as its inventory.',
  },
  {
    term: 'It is private unless you hand it over.',
    body: 'Your account is yours alone. Nothing you keep is visible to anyone else until you deliberately pass it on, and you can take that back. Sharing is the point of the thing; being shared without deciding to is not.',
  },
  {
    term: 'It is not used to train anything.',
    body: 'Your content is never fed into training, never pooled into a shared index, and never sold. There is no advertising here and there is not going to be.',
  },
  {
    term: 'Nothing you wrote is deleted by a clock.',
    body: 'Anything you archive stays recoverable. The system prunes its own working data; it does not tidy away things a person took the trouble to write.',
  },
  {
    term: 'You are always the one who decides.',
    body: 'Suggested links, priorities and summaries are offered, never imposed. Everything the system proposes is something you can accept, change or wave off.',
  },
];

/**
 * About page.
 *
 * **Fork-owned scaffold.** The argument first, then how it works, then what we
 * promise about your content. No stack, no engineering rules, no self-assessment
 * of what is finished — a reader is here to decide whether to trust it with
 * their thinking.
 *
 * ## Why the headline is a denial
 *
 * It was "Ideas are perishable." True, but it pointed the wrong way. Perishable
 * invites preservation, and preservation is exactly the instinct this product
 * is arguing with. "Nobody owns an idea." states the thing the rest of the page
 * builds on: a spark arrives from somewhere nobody can account for, its worth is
 * entirely in what it sets off, and treating it as property is what kills it.
 *
 * The section that follows the argument, "Held, or lived with.", is the only
 * openly philosophical block on any public page, and it is here rather than on
 * the landing page on purpose. Someone on `/about` has asked why. Someone on `/`
 * has not, and would rather be shown the product.
 */
export default function AboutPage() {
  return (
    <>
      <section className="relative overflow-hidden">
        <div className="pointer-events-none absolute inset-0" aria-hidden="true">
          <div className="absolute -top-16 -right-[30%] w-[130%] opacity-[0.22] lg:top-1/2 lg:-right-[10%] lg:w-[46%] lg:-translate-y-1/2 lg:opacity-70">
            <SparkMesh />
          </div>
        </div>

        <div className="relative container mx-auto px-4 pt-14 pb-12 md:pt-20 md:pb-16">
          <div className="max-w-2xl">
            <p className="term-label obsidian-reveal">about</p>
            <h1
              className="obsidian-reveal mt-5 text-4xl sm:text-5xl"
              style={{ animationDelay: '70ms' }}
            >
              Nobody owns an idea.
            </h1>
            <p
              className="text-muted-foreground obsidian-reveal mt-6 text-lg leading-relaxed"
              style={{ animationDelay: '140ms' }}
            >
              <SparkWordmark className="text-foreground text-[0.95em]" /> exists for the thought
              that arrives while you are doing something else. Catch it in one line, kindle it while
              it is live, and hand it on to whoever it can light up, including the version of you
              who will have forgotten it by Thursday.
            </p>
          </div>
        </div>
      </section>

      <PublicSection
        label="the reason"
        title="The good ones arrive unannounced."
        lede="The one thing everything else here is built on."
      >
        <div className="max-w-2xl space-y-5 text-lg leading-relaxed">
          <p>
            An idea does not give you notice. It turns up in a queue, mid-sentence, half awake, and
            if nothing happens in the next few seconds it is gone, usually for good. Nobody has a
            convincing account of where they come from. It is hard to shake the sense that the good
            ones are less invented than caught.
          </p>
          <p>
            Most software for this asks you to file the thought at the exact moment you have it:
            pick a project, set a date, choose a list. That is a request to decide what an idea is
            before you know, and it is why so many of these tools end up empty. Here, writing it
            down takes one line and asks for nothing else. Everything after that happens on your
            behalf.
          </p>
          <p className="text-foreground">
            And that is the real bet. One idea is worth something. Two that turn out to have been
            the same idea, written weeks apart in different words, are worth more than either.
            Nobody is in a position to notice that from memory.
          </p>
        </div>
      </PublicSection>

      <PublicSection
        label="the difference"
        title="Held, or lived with."
        lede="Two ways to treat something you know, and only one of them does anything."
      >
        <div className="max-w-2xl space-y-5 text-lg leading-relaxed">
          <p>
            One way is to have it. File it, count it, list it among the things you own, feel
            fractionally richer for the total. Treated like that an idea is inert, and a
            well-organised archive of inert thoughts has never changed anything. The tools that
            encourage it are not neutral about this: streaks, counts and a growing library are a
            product telling you that accumulation is the achievement.
          </p>
          <p>
            The other way is to live with it while it is live. Turn it over, argue with it, build
            something out of it, say it out loud to someone who will take it further than you will.
            An idea in that mode is not a possession at all: it is something happening to you, and
            it is worth exactly as much as what it sets off.
          </p>
          <p className="text-foreground">
            This is built for the second one, and the difference shows up in small places. There are
            no quotas here and nothing keeps score against a clock. Everything exports on the way
            out of the door. The measure of a good week is not how much you filed.
          </p>
        </div>
      </PublicSection>

      <PublicSection
        label="how it works"
        title="Four steps, three of them ours."
        lede="You do the first one. The rest happens whether you are watching or not."
      >
        <div>
          {HOW.map((step, index) => (
            <NumberedItem key={step.term} index={index + 1} term={step.term}>
              {step.body}
            </NumberedItem>
          ))}
        </div>
      </PublicSection>

      <PublicSection
        label="our promises"
        title="What we will not do with it."
        lede="You are handing over the things you think about. These are the terms we hold ourselves to."
      >
        <div>
          {PROMISES.map((promise, index) => (
            <NumberedItem key={promise.term} index={index + 1} term={promise.term}>
              {promise.body}
            </NumberedItem>
          ))}
        </div>

        <div className="mt-8 flex flex-wrap gap-3">
          <Button asChild>
            <Link href="/signup">Create an account</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/contact">Ask something</Link>
          </Button>
        </div>
      </PublicSection>

      <section>
        <div className="container mx-auto px-4">
          <SparkRule withGlyph={false} />
        </div>
        <div className="container mx-auto px-4 py-16 text-center md:py-20">
          <SparkGlyph className="mx-auto h-6 w-[45px] opacity-60" />
          <p className="mx-auto mt-6 max-w-xl text-xl leading-snug text-balance sm:text-2xl">
            If your idea lights mine, yours is not dimmer for it. There are simply two of us awake.
          </p>
        </div>
      </section>
    </>
  );
}
