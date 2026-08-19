# Brand assets — the mark, the wordmark, and which file to reach for

The logo lives in [`public/brand/`](../../../public/brand/). Nine SVGs, all
generated from one script, so the geometry can never drift between variants.

**See also:** [`../../ui/design-language.md`](../../ui/design-language.md) for the
palette these assets draw from.

---

## The mark

A lemniscate — an infinity loop — built only from straight facets, with a
four-point spark sitting on the crossing.

The three commitments in the design language decided almost every line of it:

| Commitment                     | What it produced                                                    |
| ------------------------------ | ------------------------------------------------------------------- |
| **Geometry fractures**         | Every edge is a straight facet. No arc anywhere in the loop.        |
| **One accent, used sparingly** | A single-hue ramp per mode. No third colour, no rainbow.            |
| **Two faces of one material**  | Ember on glass, vermilion on paper — the same fire, not two brands. |

The loop is a genuine crossing rather than two shapes touching: both diagonals run
straight through the centre vertex, so the ribbon passes over itself the way a real
lemniscate does. That detail is load-bearing. An early version used square-on-point
lobes and masked the crossing away entirely, and it stopped reading as a loop — it
read as two diamonds with a star between them. Hexagonal lobes with the crossing
left visible are what recovered the ∞.

The spark is the brightest thing in the mark, and must stay that way. The ember
ramp originally ran up to `#ffd479`, which put the loop's hot end brighter than the
spark beside it; the spark stopped being a spark and became a highlight. The ramp
now tops out at `#f5a524` so the hierarchy holds. **If you re-point the ramp, check
that the spark still out-values every part of the loop.**

### The spark always outranks the loop, and how that inverts

On glass the spark is the _brightest_ thing: a near-white `#fff8ea` core against a
loop that tops out at `#f5a524`. On paper it cannot be — near-white on a near-white
page is a hole. So the light mark inverts the mechanism rather than the meaning: the
loop is deep vermilion `#c2410c` and the spark is gold `#fbbf24`, a bright core
inside a darker fire.

Both readings were rendered before this was decided, and two failed in ways worth
recording:

- **A spark darker than its loop** reads as an ink blot. This is the trap in any
  light palette, where "hotter" naturally means darker — follow that instinct and
  the hottest element becomes the dimmest-looking one.
- **A cream spark on paper** washes out entirely. It needs the loop's contrast
  behind it, and at the crossing the spark is mostly against the page.

The rule that survives both: **the spark must out-value the loop by whichever
channel the ground allows** — luminance on glass, saturation on paper.

Since the app's light accent is itself vermilion now, the mark and the UI agree. The
earlier arrangement, where an indigo UI carried an ember-sparked logo, no longer
applies.

## In-app components

`public/brand/` is for anything leaving the app — social cards, email, print,
favicons. Inside the app the mark is drawn as SVG in React, so it is one paint
with the header and survives a theme toggle without a `<picture>`.

It also carries the same gradient the standalone files do, dim tail to hot
head on the loop, a bright core on the spark, through
**`components/brand/brand-gradients.tsx`**'s `BrandGradientDefs`. A literal
gradient baked into an SVG file is a fixed colour and would break the
`/admin` teal swap; this one instead sets its stops via CSS custom
properties (`--brand-loop-0/1/2`, `--brand-spark-0/1`, defined per mode and
surface in `brand-theme.css` beside `--color-primary`), so it follows the
theme toggle and collapses to flat teal on `/admin` exactly as flat
`currentColor` used to.

Geometry for all of it lives in **`components/brand/geometry.ts`**, and that
matters more than it sounds: the paths used to be pasted into `brand-mark.tsx`
by hand, which is how a logo ends up with two slightly different sparks in two
places. The script is still the source of truth for the _shape_; edit it, then
bring the change to the module.

| Component           | Where                                  | Use for                                                           |
| ------------------- | -------------------------------------- | ----------------------------------------------------------------- |
| `BrandMark`         | `components/brand/brand-mark.tsx`      | The header/footer lockup. Sized in `em`, rides adjacent text.     |
| `SparkGlyph`        | `components/brand/spark-glyph.tsx`     | The mark alone, any size. `traced` adds nodes and the pulse.      |
| `SparkRule`         | same file                              | A section hairline with the mark set into it.                     |
| `SparkMesh`         | `components/brand/spark-mesh.tsx`      | The public pages' artwork: the loop inside a wider field.         |
| `VerbDiagram`       | `components/marketing/resparkable/`    | Three small drawings for catch / kindle / ignite.                 |
| `BrandGradientDefs` | `components/brand/brand-gradients.tsx` | The shared loop/spark gradient `<defs>` the four above draw from. |

### The traced spark is smaller, and has to be

The mark's proportions are set against a **4.6-wide stroke**. At that weight the
spark and the loop are the same order of thing, and the crossing is _implied_ by
the ribbon rather than drawn. Trace the loop at 1.7 instead — which is what
`SparkMesh` and `SparkGlyph traced` do — and the spark, unchanged, becomes about
three times the visual mass of everything near it. It covers both diagonals, and
the mark stops reading as a lemniscate: it reads as two hexagons with a star
between them.

That is the _same failure_ the very first version of the logo had, arrived at
from the opposite direction — and it is why `TRACED_SPARK_TRANSFORM` scales the
spark to 0.54 about 32,17, and `TRACED_SPARK_CLEARANCE` shrinks the mask ring
from 2.8 to 1.4 along with it. A full-size ring around a half-size spark punches
a hole across the very diagonals the smaller spark was shrunk to reveal.

**If you change a stroke weight on a traced mark, re-check both numbers.**

### The animation, and where it is allowed

`SparkMesh` reads the mark as what it already is — a graph — and laps a pulse
round it. The vertices light as the pulse reaches them; three far nodes catch
shortly after the spark crosses the centre, and the crossing does not dim to pay
for it. That last part is the only thing the graphic is there to say, and it is
not a thing a sentence does well.

Timing is computed from the facet lengths, not eyeballed: the facets differ
(14.213 / 11 / 13.601 per lobe, 155.256 in total), so evenly-spaced flashes drift
visibly out of step with the pulse by the far lobe. `LOOP_NODES[].phase` holds
the fractions and `nodeDelay()` turns one into a CSS delay. The classes live in
`brand-theme.css` and read `--spark-lap` / `--spark-phase`.

**This is the app's one piece of continuous motion, and it is fenced to the
public pages.** Inside the product the rule still holds — one arrival, then
stillness — because a thing that moves while you are trying to think is a thing
you end up hiding. A marketing page is the opposite situation: the reader is
deciding whether this is alive.

Under `prefers-reduced-motion` every animation freezes at a legible resting
state rather than being hidden, so what is left is a still diagram of a graph
with a lit crossing — which is the picture anyway.

## The wordmark

Martian Mono at weight 600, tracked `-0.012em`, **converted to outlines**. The
lockups carry no font dependency and render identically wherever they land.

## Which file

| File                         | Use for                                                     |
| ---------------------------- | ----------------------------------------------------------- |
| `resparkable-logo.svg`       | Default lockup. Follows the viewer's colour scheme.         |
| `resparkable-logo-dark.svg`  | Lockup pinned to the ember palette.                         |
| `resparkable-logo-light.svg` | Lockup pinned to the vermilion palette.                     |
| `resparkable-logo-mono.svg`  | Lockup on `currentColor` — one colour, print, stamps.       |
| `resparkable-mark*.svg`      | Same four, mark only, no wordmark.                          |
| `resparkable-icon.svg`       | Mark on a glass tile. Favicons, app icons, anywhere square. |

**Reach for a pinned variant whenever the background is fixed.** The adaptive files
switch on `prefers-color-scheme`, which only exists in a browser: put one on a dark
hero that stays dark regardless of the visitor's OS setting and half your visitors
get the light mark on near-black.

### The adaptive files outside a browser

They carry the light palette as presentation attributes underneath the CSS
variables, so a renderer without `var()` support lands on vermilion, not black —
librsvg does exactly this, and it is why the fallback is there. Browsers take the
`style` attribute, which wins on specificity, and switch as intended.

Correct degradation is not the same as correct output. **For image pipelines,
social cards, email and print, use a pinned variant** and leave nothing to the
renderer.

### Sizing

The mark holds down to about 24px. Below that the loop closes up and the spark
goes; use `resparkable-icon.svg`, whose tile survives 16px.

## The page

`app/(resparkable)/resparkable/brand/page.tsx` renders all of this inside the app, at
`/resparkable/brand`.

Its swatches are filled with `var(--color-*)` and captioned with the **token name**
rather than a hex value, so the page shows whatever the palette currently is and
cannot go stale when it moves. The one exception is the logo ramp, which prints real
hex values — those are baked into the committed SVGs, so they are facts about files
rather than references to live tokens. If they ever disagree with the palette, they
_should_ look wrong.

## Regenerating

```bash
python3 -m venv .venv && .venv/bin/pip install fonttools brotli
.venv/bin/python scripts/framework/resparkable/build-brand.py
```

Every asset comes out of that one script — geometry, palettes and the outlined
wordmark included. **Edit the script, never the SVGs**, or the variants drift apart
one hand-fix at a time.

It reads Martian Mono out of the `next/font` cache under `.next/`, resolving it by
name table rather than by path, because next/font content-hashes the filename and it
moves on every dependency bump. On a clean checkout there is no cache: run
`npm run dev` once first, or the script will say so and stop.
