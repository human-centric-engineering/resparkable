/**
 * BrandGradientDefs: the mark's colour, shared across every in-app drawing of it.
 *
 * **Fork-owned.** `BrandMark`, `SparkGlyph` and `SparkMesh` all draw the same
 * loop and spark, and until now all three did it in flat `currentColor`: no
 * hue variation across the ramp, everything the same shade of amber or
 * vermilion. The standalone files in `public/brand/` always carried a proper
 * gradient (dim tail to hot head on the loop, a bright core on the spark); this
 * gives the in-app mark the same nuance without the problem that kept it out
 * before, which was that a gradient baked into an SVG file is a fixed colour
 * that cannot follow the theme toggle or the `/admin` teal swap.
 *
 * The fix is the same technique `resparkable-mark.svg` already uses for
 * `prefers-color-scheme`: gradient stops set via `style` so they read a CSS
 * custom property instead of a literal colour. Here the properties are
 * `--brand-loop-0/1/2` and `--brand-spark-0/1`, defined once per mode and
 * surface in `brand-theme.css` beside `--color-primary`. Admin sets every stop
 * to the same teal, so the gradient collapses to the flat colour the `/admin`
 * swap always meant: see the block comment at `brand-theme.css` §3b for why
 * admin carries one hue instead of a ramp.
 *
 * Both gradients use `gradientUnits="userSpaceOnUse"` with the mark's own
 * 64×34 coordinates (matching the standalone SVGs' stops exactly), so any
 * shape drawn in that same local space, transformed or not, picks up the ramp
 * correctly. `SparkMesh` nests the loop inside a translated `<g>` and the
 * traced spark inside a further scaled one; both still resolve against this
 * gradient's own coordinates because `userSpaceOnUse` is evaluated in the
 * referencing element's local space, transforms included.
 *
 * Fixed ids, not `useId`: every instance defines byte-identical stops, so two
 * mark drawings on one page resolving to the first is a no-op. Same reasoning
 * as the mask ids in `brand-mark.tsx` and `spark-glyph.tsx`.
 */

export const BRAND_LOOP_GRADIENT_ID = 'resparkable-brand-loop';
export const BRAND_SPARK_GRADIENT_ID = 'resparkable-brand-spark';

export function BrandGradientDefs(): React.ReactNode {
  return (
    <>
      <linearGradient
        id={BRAND_LOOP_GRADIENT_ID}
        gradientUnits="userSpaceOnUse"
        x1="4"
        y1="30"
        x2="60"
        y2="4"
      >
        <stop offset="0" style={{ stopColor: 'var(--brand-loop-0)' }} />
        <stop offset="0.46" style={{ stopColor: 'var(--brand-loop-1)' }} />
        <stop offset="1" style={{ stopColor: 'var(--brand-loop-2)' }} />
      </linearGradient>
      <radialGradient
        id={BRAND_SPARK_GRADIENT_ID}
        gradientUnits="userSpaceOnUse"
        cx="32"
        cy="17"
        r="11.5"
      >
        <stop offset="0" style={{ stopColor: 'var(--brand-spark-0)' }} />
        <stop offset="1" style={{ stopColor: 'var(--brand-spark-1)' }} />
      </radialGradient>
    </>
  );
}
