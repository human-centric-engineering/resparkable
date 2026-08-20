/* eslint-disable @next/next/no-img-element -- These are static, self-hosted SVGs
   from `public/brand/`, already ~1.5 KB each. `next/image` cannot resize or
   re-encode an SVG, so it would buy nothing here, and rendering one through it
   requires `dangerouslyAllowSVG` in next.config — which relaxes the rule for
   *every* image the app serves, including remote ones, to satisfy a cosmetic
   lint warning on nine files we author ourselves. Plain <img> is the correct
   call; the trade is recorded here so it isn't re-litigated. */

import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Brand',
  description: 'The mark, the wordmark, and which file to reach for.',
};

/**
 * The brand sheet.
 *
 * ## Why the swatches carry token names instead of hex values
 *
 * A brand page that prints `#c2410c` next to a chip is a page that lies the first
 * time someone re-points the primary — quietly, because nothing breaks. So the
 * chips here are filled with `var(--color-*)` and captioned with the *token name*.
 * The colour is whatever `brand-theme.css` currently says it is, and the caption
 * stays true no matter what that is.
 *
 * The one place real hex values do appear is the logo ramp, and that is correct:
 * those are baked into the committed SVGs, so they are facts about files rather
 * than references to a live token. If they drift from the palette, they *should*
 * read as stale.
 *
 * ## Why two panels are painted with literal colours
 *
 * The specimen pair has to show ember-on-glass and vermilion-on-paper at the same
 * time, which is exactly the one thing tokens cannot do — they resolve to whichever
 * mode the reader is in. Those two panels are content, not chrome, so they carry
 * their grounds explicitly. Everything else on the page is tokenised.
 */

/** Vertices of the faceted lemniscate, mirrored from `build-brand.py`. */
const LOOP = 'M32,17 L23,6 L12,6 L4,17 L12,28 L23,28 L32,17 L41,6 L52,6 L60,17 L52,28 L41,28 Z';
const SPARK =
  'M32,6.5C32,10.275 36.725,17 42.5,17C36.725,17 32,23.725 32,27.5' +
  'C32,23.725 27.275,17 21.5,17C27.275,17 32,10.275 32,6.5Z';
const VERTICES = [
  [32, 17],
  [23, 6],
  [12, 6],
  [4, 17],
  [12, 28],
  [23, 28],
  [41, 6],
  [52, 6],
  [60, 17],
  [52, 28],
  [41, 28],
] as const;

const RAMP_DARK = [
  { hex: '#a3480a', role: 'tail' },
  { hex: '#e0891c', role: 'mid' },
  { hex: '#f5a524', role: 'head' },
  { hex: '#fff8ea', role: 'spark' },
];
const RAMP_LIGHT = [
  { hex: '#f0a882', role: 'tail' },
  { hex: '#dd6a2a', role: 'mid' },
  { hex: '#c2410c', role: 'head' },
  { hex: '#fbbf24', role: 'spark' },
];

const TOKENS = [
  { token: '--color-primary', note: 'The accent. Ember on glass, vermilion on paper.' },
  { token: '--color-destructive', note: 'Moved to clear the warm primary by 29°.' },
  { token: '--color-warn', note: 'Moved to a truer gold, 48° clear.' },
  { token: '--color-signal', note: 'Live. Never re-skinned.' },
  { token: '--color-info', note: 'Informational. Never re-skinned.' },
  { token: '--color-sheen', note: 'Reserved: only where the machine is thinking for you.' },
];

const FILES = [
  ['resparkable-logo.svg', 'lockup', 'adaptive', 'Default. Follows the viewer’s colour scheme.'],
  ['resparkable-logo-dark.svg', 'lockup', 'ember', 'Pinned. Any ground that stays dark.'],
  ['resparkable-logo-light.svg', 'lockup', 'vermilion', 'Pinned. Any ground that stays light.'],
  ['resparkable-logo-mono.svg', 'lockup', 'one-colour', 'currentColor. Print, stamps, engraving.'],
  ['resparkable-mark.svg', 'mark', 'adaptive', 'Mark alone, no wordmark.'],
  ['resparkable-mark-dark.svg', 'mark', 'ember', 'Mark alone, pinned dark.'],
  ['resparkable-mark-light.svg', 'mark', 'vermilion', 'Mark alone, pinned light.'],
  ['resparkable-mark-mono.svg', 'mark', 'one-colour', 'Mark alone, currentColor.'],
  ['resparkable-icon.svg', 'icon', 'tile', 'Favicon, app icon, anywhere square.'],
];

const SIZES = [150, 64, 40, 24];

function Swatch({ hex, role }: { hex: string; role: string }) {
  return (
    <div className="flex items-center gap-3">
      <span
        className="border-border size-6 shrink-0 rounded-sm border"
        style={{ background: hex }}
      />
      <code className="font-mono text-xs tabular-nums">{hex}</code>
      <span className="text-muted-foreground ml-auto text-xs">{role}</span>
    </div>
  );
}

export default function ResparkableBrandPage() {
  return (
    <div className="max-w-4xl space-y-10">
      <header className="space-y-3">
        <p className="term-label">Resparkable · brand mark</p>
        <h1 className="text-2xl text-balance">A spark, and the loop that keeps returning to it</h1>
        <p className="text-muted-foreground max-w-prose text-sm">
          An infinity loop built only from straight facets, with a four-point spark sitting on the
          crossing. The loop is a real crossing, not two shapes touching — both diagonals run
          straight through the centre vertex, so the ribbon passes over itself.
        </p>
      </header>

      {/* Fixed grounds: the whole point is showing both modes at once. */}
      <section className="space-y-3">
        <p className="term-label">Two faces of one material</p>
        <div className="border-border grid grid-cols-1 overflow-hidden rounded-md border sm:grid-cols-2">
          <div
            className="flex flex-col items-center justify-center gap-4 p-8"
            style={{ background: '#0a0b0f' }}
          >
            <img
              src="/brand/resparkable-logo-dark.svg"
              alt="Resparkable logo, ember on dark"
              className="w-full max-w-[18rem]"
            />
            <span className="term-label" style={{ color: '#7e8697' }}>
              ember on glass
            </span>
          </div>
          <div
            className="border-border flex flex-col items-center justify-center gap-4 border-t p-8 sm:border-t-0 sm:border-l"
            style={{ background: '#fbf8f6' }}
          >
            <img
              src="/brand/resparkable-logo-light.svg"
              alt="Resparkable logo, vermilion on light"
              className="w-full max-w-[18rem]"
            />
            <span className="term-label" style={{ color: '#8a7a70' }}>
              vermilion on paper
            </span>
          </div>
        </div>
      </section>

      <section className="space-y-3">
        <p className="term-label">Construction</p>
        <h2 className="text-base">Every edge is a facet</h2>
        <div className="grid grid-cols-1 items-center gap-6 md:grid-cols-[1.3fr_1fr]">
          <div className="bg-card border-border rounded-md border p-6">
            <svg
              viewBox="-1 2 66 30"
              className="block h-auto w-full"
              role="img"
              aria-label="Eleven vertices of the faceted lemniscate, with the spark outlined at the crossing"
            >
              <path d={LOOP} fill="none" stroke="currentColor" strokeWidth={0.55} opacity={0.42} />
              <path
                d={SPARK}
                fill="none"
                stroke="var(--color-primary)"
                strokeWidth={0.55}
                opacity={0.85}
              />
              {VERTICES.map(([x, y]) => (
                <circle
                  key={`${x}-${y}`}
                  cx={x}
                  cy={y}
                  r={x === 32 && y === 17 ? 1.5 : 1.05}
                  fill="var(--color-primary)"
                />
              ))}
            </svg>
          </div>
          <dl className="space-y-4 text-sm">
            {[
              ['11', 'vertices, two hexagonal lobes sharing the one at the centre.'],
              ['0', 'curves in the loop. Obsidian fractures into edges, so the mark does too.'],
              [
                '1',
                'accent per mode. The spark is always the brightest thing in the mark — if you re-point the ramp, check that it still is.',
              ],
            ].map(([n, text]) => (
              <div key={n} className="flex gap-3">
                <dt className="text-primary font-display w-8 shrink-0 text-[11px] font-semibold tracking-wider">
                  {n}
                </dt>
                <dd className="text-muted-foreground">{text}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      <section className="space-y-3">
        <p className="term-label">The ramp</p>
        <h2 className="text-base">Cool at the tail, hot at the head</h2>
        <p className="text-muted-foreground max-w-prose text-sm">
          The loop runs a single-hue ramp from a dim tail to a hot head: the idea dims, loops round,
          and re-ignites. The spark outranks every stop on it. These are baked into the SVGs, so
          they are the one place on this page that prints real hex values.
        </p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="bg-card border-border space-y-3 rounded-md border p-4">
            <p className="term-label">dark · ember</p>
            {RAMP_DARK.map((s) => (
              <Swatch key={s.hex} {...s} />
            ))}
          </div>
          <div className="bg-card border-border space-y-3 rounded-md border p-4">
            <p className="term-label">light · vermilion</p>
            {RAMP_LIGHT.map((s) => (
              <Swatch key={s.hex} {...s} />
            ))}
          </div>
        </div>
      </section>

      <section className="space-y-3">
        <p className="term-label">Live tokens</p>
        <h2 className="text-base">What the app is actually running</h2>
        <p className="text-muted-foreground max-w-prose text-sm">
          Filled from <code className="font-mono text-xs">brand-theme.css</code> at render, in your
          current mode. Captioned by token name rather than hex, so this page cannot go stale when
          the palette moves.
        </p>
        <div className="bg-card border-border divide-border divide-y rounded-md border">
          {TOKENS.map(({ token, note }) => (
            <div key={token} className="flex items-center gap-3 p-3">
              <span
                className="border-border size-6 shrink-0 rounded-sm border"
                style={{ background: `var(${token})` }}
              />
              <code className="font-mono text-xs">{token}</code>
              <span className="text-muted-foreground ml-auto text-right text-xs">{note}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <p className="term-label">At size</p>
        <h2 className="text-base">Holds to 24px; below that, use the tile</h2>
        <div className="border-border grid grid-cols-1 overflow-hidden rounded-md border sm:grid-cols-2">
          {(
            [
              ['#0a0b0f', 'resparkable-mark-dark.svg', '#7e8697'],
              ['#fbf8f6', 'resparkable-mark-light.svg', '#8a7a70'],
            ] as const
          ).map(([bg, file, caption], i) => (
            <div
              key={bg}
              className={`border-border flex flex-wrap items-center gap-6 p-6 ${i === 1 ? 'border-t sm:border-t-0 sm:border-l' : ''}`}
              style={{ background: bg }}
            >
              {SIZES.map((w) => (
                <figure key={w} className="m-0 flex flex-col items-center gap-2">
                  <img src={`/brand/${file}`} width={w} alt="" />
                  <figcaption
                    className="font-mono text-[11px] tabular-nums"
                    style={{ color: caption }}
                  >
                    {w}
                  </figcaption>
                </figure>
              ))}
              {[32, 16].map((w) => (
                <figure key={`tile-${w}`} className="m-0 flex flex-col items-center gap-2">
                  <img src="/brand/resparkable-icon.svg" width={w} alt="" />
                  <figcaption
                    className="font-mono text-[11px] tabular-nums"
                    style={{ color: caption }}
                  >
                    tile {w}
                  </figcaption>
                </figure>
              ))}
            </div>
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <p className="term-label">The files</p>
        <h2 className="text-base">
          Nine SVGs in <code className="font-mono text-sm">public/brand/</code>
        </h2>
        <div className="bg-card border-border overflow-x-auto rounded-md border">
          <table className="w-full min-w-[42rem] border-collapse">
            <thead>
              <tr>
                {['File', 'Kind', 'Tone', 'Use for'].map((h) => (
                  <th
                    key={h}
                    className="term-label border-border border-b px-3 py-2 text-left font-normal"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {FILES.map(([file, kind, tone, use]) => (
                <tr key={file} className="border-border/60 border-b last:border-0">
                  <td className="px-3 py-2">
                    <code className="font-mono text-xs">{file}</code>
                  </td>
                  <td className="px-3 py-2">
                    <span className="term-meta">{kind}</span>
                  </td>
                  <td className="px-3 py-2">
                    <span className="term-meta">{tone}</span>
                  </td>
                  <td className="text-muted-foreground px-3 py-2 text-sm">{use}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-3">
        <p className="term-label">Rules</p>
        <h2 className="text-base">Three that matter</h2>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {[
            [
              'Pin the variant',
              'The adaptive files switch on prefers-color-scheme, which only exists in a browser. On a hero that stays dark regardless of the visitor’s OS, half your visitors get the light mark on near-black. Fixed ground → pinned file.',
            ],
            [
              'Edit the script',
              'All nine come out of scripts/framework/resparkable/build-brand.py. Hand-fix one SVG and the variants drift apart, one fix at a time.',
            ],
            [
              'Outside a browser, pin harder',
              'The adaptive files fall back to the light palette rather than black where var() is unsupported. Correct degradation is not correct output — for image pipelines, email and print, pin it.',
            ],
          ].map(([title, body]) => (
            <div key={title} className="bg-card border-border space-y-2 rounded-md border p-4">
              <p className="term-label text-primary">{title}</p>
              <p className="text-muted-foreground text-sm">{body}</p>
            </div>
          ))}
        </div>
      </section>

      <p className="text-muted-foreground border-border border-t pt-6 text-xs">
        Palette, geometry and type follow{' '}
        <code className="font-mono">.context/ui/design-language.md</code>. Wordmark: Martian Mono
        600, converted to outlines.
      </p>
    </div>
  );
}
