import type { Metadata } from 'next';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { LandingHero } from '@/components/marketing/resparkable/landing-hero';
import { PublicSection, NumberedItem } from '@/components/marketing/resparkable/public-section';
import { VerbDiagram } from '@/components/marketing/resparkable/verb-diagram';
import { SparkGlyph, SparkRule } from '@/components/brand/spark-glyph';

const description =
  'Catch a spark in one line, kindle it while it is live, and use it to light someone else up. Resparkable holds your ideas, notes, tasks, projects and goals in one place, joins them up for you, and is built so everything in it can leave.';

export const metadata: Metadata = {
  title: 'Resparkable: catch and kindle the spark of an idea',
  description,
  openGraph: { title: 'Resparkable', description, type: 'website' },
  twitter: { card: 'summary_large_image', title: 'Resparkable', description },
};

/**
 * The whole product in three verbs.
 *
 * The order is the order a reader meets it in, and the middle one has changed
 * twice. It was "Keep it." first, which is what every product in this genre
 * promises and the wrong promise here: keeping is a claim about storage, and
 * storage is not what makes an idea worth anything; a spark filed away is a
 * spark that went out quietly in a folder. Then it was "Carry it.", which fixed
 * the claim but not the verb. Carrying is something you do to luggage.
 *
 * ## Why these three and not the other three
 *
 * `catch · kindle · ignite` is one metaphor followed all the way through, where
 * `catch · carry · pass on` was three unrelated things you do with your hands.
 * A spark that is caught and left alone goes out. What the overnight pass
 * actually does to it is closer to kindling than to carrying: give it air, put
 * it next to the other dry thing in the pile, bring it back warm. And the third
 * verb is the argument of the whole page, so it should be the strongest word
 * available: handing an idea on is not delivery, it is ignition, and the source
 * does not dim to pay for it.
 *
 * The first verb stays "catch" deliberately. "Spark it." was on the table and is
 * wrong twice: *spark* is already this app's noun for a caught idea, and the verb
 * would claim you generate the thing, which is the opposite of what `/about`
 * argues. You do not strike the spark. You are there when it lands.
 *
 * Nothing here is a metaphor for anything the product does not do. If a line
 * cannot be read aloud to someone who has never used the app, it does not belong
 * on the front page.
 */
const CORE = [
  {
    kind: 'catch',
    term: 'Catch it.',
    body: 'A spark takes one line. No project to choose, no date to set, no folder to pick. Write it before it goes and get on with your day: being asked where a thought belongs is the fastest way to lose the thought.',
  },
  {
    kind: 'kindle',
    term: 'Kindle it.',
    body: 'A spark on its own goes out, and filing it away is not what keeps it going. This one gets air: it comes back in your morning briefing, beside the project it turned out to belong to, or next to something you wrote six weeks ago about the same thing and had forgotten. Kept warm rather than kept safe.',
  },
  {
    kind: 'ignite',
    term: 'Ignite others.',
    body: 'An idea does its work in other hands, or in the thing you build out of it. Everything here is written to leave: plain markdown that opens anywhere, an export that carries your edits with it, an assistant that will draft the version you can actually send. Light someone else up and yours is not one bit dimmer.',
  },
] as const;

/** What you get, said plainly. One line each, no internals. */
const FEATURES = [
  {
    term: 'Catch it anywhere',
    body: 'Type it, speak it, send it from your phone, or hand it to an assistant you already talk to. One line is enough, and the same idea sent twice stays one idea.',
  },
  {
    term: 'A morning briefing',
    body: 'A short read waiting for you each morning: what you finished, what deserves today, and one thing you had stopped thinking about.',
  },
  {
    term: 'Priorities you did not have to set',
    body: 'Your tasks arrive in a sensible order: what is due, what is blocking something, what actually serves a goal you care about, and what fits the time you have. Move anything up yourself and it stays there.',
  },
  {
    term: 'Search that understands you',
    body: 'Find things by what they were about rather than the exact words you happened to use, across your notes, projects, goals, people and documents at once.',
  },
  {
    term: 'Connections you would have missed',
    body: 'Overnight it reads back over everything you have written and offers the links: two notes that were the same thought, a task that belongs to a goal, a person who keeps coming up. You take the ones that are right. This is the resparking, and it is the part you cannot do from memory.',
  },
  {
    term: 'Goals from this week to this lifetime',
    body: 'Goals nest inside each other, from the one that is done by Friday to the one you will still be holding in ten years, each sitting in an area of your life you named and described yourself. No quotas and no hours to fill: this is a tool for understanding what you are doing, not for scoring you on it.',
  },
  {
    term: 'Boards for the work in flight',
    body: 'Columns, tags, checklists and limits over the same tasks you already have. Drag a card, and everywhere else it appears agrees.',
  },
  {
    term: 'The people behind the work',
    body: 'Clients, contacts and companies are first-class, attached to the projects and notes that involve them, so preparing for a conversation takes one screen.',
  },
  {
    term: 'Your documents, in with your notes',
    body: 'Drop in a PDF, a contract, a spreadsheet or a book and it becomes searchable alongside everything you have written yourself.',
  },
  {
    term: 'Ask about your own work',
    body: 'A conversation that already knows your goals, your live projects and what is on top of the pile, and it tells you what it looked at before answering.',
  },
  {
    term: 'Built to leave',
    body: 'Everything exports as plain markdown that opens in Obsidian or any editor, edits included. Nothing is locked in, nothing you wrote is deleted on a timer, and a system you can walk out of is the only kind worth putting your thinking into.',
  },
];

/**
 * The vision, written as the product it is becoming.
 *
 * Not a roadmap and deliberately not dated: a public page is the wrong place to
 * grade your own progress, and a reader wants to know what this is for, not
 * which sprint a feature is in.
 */
const AHEAD = [
  {
    term: 'Everything in step',
    body: 'A folder of markdown on your own machine kept in step with your account, both directions, continuously, so the same idea is in your editor, on your phone and in the briefing without you moving it.',
  },
  {
    term: 'Work with other people',
    body: 'Shared projects, shared boards and shared reviews, with each person keeping their own private inbox. You choose exactly what leaves your side, and you can take it back.',
  },
  {
    term: 'Ideas that travel',
    body: 'With your say-so, one idea at a time, set beside what other people have chosen to put out. What comes back is a framing you would not have reached on your own; whoever sharpened yours is not left holding any less.',
  },
];

/**
 * Landing page.
 *
 * **Fork-owned scaffold** — CUSTOMIZATION.md treats this file as a starting
 * point, and this is the fork having started. The copy rules are short: plain
 * English a stranger can read at speed, no invented numbers, no stack, no
 * pricing, and nothing framed by what is missing. It describes the product,
 * including where it is going, in the voice of someone showing you round rather
 * than someone auditing themselves.
 *
 * ## What the page argues, and why the argument moved
 *
 * It used to argue loss: never lose a good idea, keep everything, get it back.
 * That is the note-taking genre's default pitch and it frames a thought as
 * property: something you accumulate, guard, and are richer for holding. This
 * product does not believe that. A spark arrives from somewhere nobody can
 * account for, it lights you up, and its worth is entirely in what happens
 * next: acted on, built with, or handed to someone who can do more with it than
 * you can. Capture is in service of that, not a substitute for it.
 *
 * So the page is written in the other mode throughout. Catch, kindle, ignite:
 * never hold, own, or bank. The `Built to leave` feature and the export promise
 * are load-bearing rather than reassurance: a system you cannot walk out of is
 * asking you to treat your own thinking as its inventory.
 *
 * The one line the whole page hangs off sits in the statement band below the
 * three verbs, and it is a plain fact rather than a flourish: light is the thing
 * that does not divide when you share it.
 */
export default function LandingPage() {
  return (
    <>
      <LandingHero />

      <PublicSection
        label="what it is"
        title="Catch it. Kindle it. Ignite others."
        lede="Three verbs, one fire. Not one of them is storage."
      >
        <div className="space-y-10">
          {CORE.map(({ kind, term, body }) => (
            <div key={term}>
              <VerbDiagram kind={kind} className="mb-4" />
              <h3 className="text-xl">{term}</h3>
              <p className="text-muted-foreground mt-2 max-w-2xl text-lg leading-relaxed">{body}</p>
            </div>
          ))}
        </div>
      </PublicSection>

      {/* The statement band. One idea, centred, nothing else on the screen:
          the only place on any public page that breaks the left-aligned rail,
          and it earns that by being the sentence the rest of the page follows
          from. `traced` is safe here: the glyph is 36px tall. */}
      <section>
        <div className="container mx-auto px-4">
          <SparkRule withGlyph={false} />
        </div>
        <div className="container mx-auto px-4 py-16 md:py-20">
          <div className="mx-auto max-w-3xl text-center">
            <SparkGlyph traced className="mx-auto h-9 w-[68px]" />
            <p className="mt-8 text-2xl leading-snug text-balance sm:text-3xl">
              A spark is fleeting. It is also the only thing you can hand over and still be holding.
            </p>
            <p className="text-muted-foreground mx-auto mt-6 max-w-xl leading-relaxed">
              Nothing is subtracted when you light someone else up. That is not a nice thought about
              generosity: it is the plain arithmetic of ideas, and it is why a system built to store
              them is solving the wrong half of the problem.
            </p>
          </div>
        </div>
      </section>

      <PublicSection
        id="built"
        label="what you get"
        title="Everything in one place."
        lede="Your ideas, your work and the people it involves, all in the same system rather than in five."
      >
        <div>
          {FEATURES.map((item, index) => (
            <NumberedItem key={item.term} index={index + 1} term={item.term}>
              {item.body}
            </NumberedItem>
          ))}
        </div>
      </PublicSection>

      <PublicSection
        label="while you are away"
        title="Two notes, weeks apart."
        lede="The part that works when you are not looking."
      >
        <div className="max-w-2xl space-y-5 text-lg leading-relaxed">
          <p>
            Everything you keep is stored twice: as the words you wrote, and as a sense of what it
            is about. Once a night, while you are doing something else, Resparkable reads back over
            all of it and looks for things that belong together and are not yet joined up.
          </p>
          <p>
            What it finds, it brings you with a sentence on why. You keep the ones that are right
            and wave off the ones that are not. It does not ask you about the same pair twice.
          </p>
          <p className="text-foreground">
            Most of it you already knew. Then two fragments written six weeks apart turn out to have
            been the same thought, and neither of them said so at the time. Alone, neither was worth
            much. Struck together they are worth more than both, which is the whole reason it runs
            at night.
          </p>
        </div>
      </PublicSection>

      <PublicSection
        label="where this goes"
        title="Ideas worth more together."
        lede="What we are building towards, and why the pieces are shaped the way they are."
      >
        <div className="space-y-8">
          {AHEAD.map(({ term, body }) => (
            <div key={term}>
              <h3 className="text-xl">{term}</h3>
              <p className="text-muted-foreground mt-2 max-w-2xl leading-relaxed">{body}</p>
            </div>
          ))}
        </div>
      </PublicSection>

      <section>
        <div className="container mx-auto px-4">
          <SparkRule withGlyph={false} />
        </div>
        <div className="container mx-auto px-4 py-16 text-center md:py-24">
          <SparkGlyph className="mx-auto h-6 w-[45px] opacity-60" />
          <h2 className="mt-6 text-2xl sm:text-3xl">Catch the next one.</h2>
          <p className="text-muted-foreground mx-auto mt-4 max-w-lg leading-relaxed">
            There will be one today, and it will arrive while you are doing something else. Write it
            down in one line. What happens to it after that is the part you do not have to do.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Button asChild size="lg">
              <Link href="/signup">Create an account</Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link href="/about">Why we built it</Link>
            </Button>
          </div>
        </div>
      </section>
    </>
  );
}
