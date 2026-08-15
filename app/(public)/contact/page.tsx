import type { Metadata } from 'next';
import { ContactForm } from '@/components/forms/contact-form';
import { SparkMesh } from '@/components/brand/spark-mesh';
import { SparkGlyph } from '@/components/brand/spark-glyph';
import { BRAND } from '@/lib/brand';

const description = `Ask a question about ${BRAND.name}, report something broken, or say what is missing.`;

export const metadata: Metadata = {
  title: 'Contact',
  description,
  openGraph: { title: `Contact - ${BRAND.name}`, description },
  twitter: { card: 'summary_large_image', title: `Contact - ${BRAND.name}`, description },
};

/**
 * Contact page.
 *
 * **Fork-owned scaffold.** One channel, and it is real: the form writes a
 * `ContactSubmission` row and sends a notification.
 *
 * What was here before and is deliberately gone: a support tier linking to
 * invented pricing, a promised response time nobody had committed to, and a
 * `hello@example.com` address that would have bounced. A contact page whose
 * details are placeholders is worse than one channel that works: the reader
 * cannot tell which of them are real, so they trust none. A public issue
 * tracker went the same way: the repository is private, so the link would have
 * been a door that does not open.
 *
 * The mesh sits behind the heading rather than beside the form. A form is the
 * one place on a public site where the reader has switched from browsing to
 * working, and putting a continuously animating graphic next to a field they are
 * typing into is a small act of sabotage. It stays above the fold and stops.
 */
export default function ContactPage() {
  return (
    <div className="relative overflow-hidden">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[26rem]" aria-hidden="true">
        <div className="absolute -top-20 -right-[26%] w-[125%] opacity-[0.2] lg:-top-24 lg:-right-[6%] lg:w-[42%] lg:opacity-60">
          <SparkMesh />
        </div>
      </div>

      <div className="relative container mx-auto px-4 pt-14 pb-16 md:pt-20 md:pb-24">
        <div className="mx-auto max-w-5xl">
          <div className="max-w-2xl">
            <p className="term-label lattice-reveal">contact</p>
            <h1
              className="lattice-reveal mt-5 text-4xl sm:text-5xl"
              style={{ animationDelay: '70ms' }}
            >
              Tell us what you need.
            </h1>
            <p
              className="text-muted-foreground lattice-reveal mt-6 text-lg leading-relaxed"
              style={{ animationDelay: '140ms' }}
            >
              Ask a question, tell us something went wrong, or say what would make this worth using
              for you. There is no support desk in the way: messages reach the people building it,
              and get a real answer back.
            </p>
          </div>

          <div className="mt-12 grid gap-10 lg:grid-cols-12 lg:gap-16">
            <div className="lg:col-span-7">
              <div className="bg-card border-border rounded-lg border p-6 md:p-8">
                <h2 className="text-xl">Send a message</h2>
                <p className="text-muted-foreground mt-2 mb-6 text-sm leading-relaxed">
                  Everything except the message itself is used only to reply to you.
                </p>
                <ContactForm />
              </div>
            </div>

            <div className="lg:col-span-5">
              <div className="bg-card border-border rounded-lg border p-6">
                <SparkGlyph className="mb-3 h-4 w-[30px] opacity-35" />
                <p className="term-label">what to send</p>
                <p className="text-muted-foreground mt-3 text-sm leading-relaxed">
                  The feature you went looking for and did not find is the most useful message we
                  get. So is the thing that behaved oddly, and the sentence somewhere on this site
                  that did not make sense. If you have had an idea about what this should be, that
                  counts double: it is the whole premise that they are worth more once they are out.
                </p>
              </div>

              <div className="bg-card border-border mt-6 rounded-lg border p-6">
                <SparkGlyph className="mb-3 h-4 w-[30px] opacity-35" />
                <p className="term-label">your data</p>
                <p className="text-muted-foreground mt-3 text-sm leading-relaxed">
                  A message sent here is stored so that it can be answered, and nothing more.
                  Deleting your account removes everything attached to it, and you can ask for a
                  full copy of what is held about you at any time.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
