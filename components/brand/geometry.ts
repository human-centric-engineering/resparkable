import type { CSSProperties } from 'react';

/**
 * The mark's geometry, as data.
 *
 * **Fork-owned scaffold.** One module so the header mark, the hero mesh and the
 * small diagrams cannot drift apart. Before this existed the paths were pasted
 * into `brand-mark.tsx` by hand, which is exactly how a logo ends up with two
 * slightly different sparks in two places.
 *
 * The source of truth for the *shape* is still
 * `scripts/framework/resparkable/build-brand.py`, which writes `public/brand/`.
 * These strings are the same geometry transcribed for in-app SVG, where the
 * files' gradients would pin the mark to the consumer accent and break the
 * `/admin` teal swap. Edit the script, then bring the change here.
 */

/** The mark's own coordinate space. Everything below is in these units. */
export const MARK_VIEWBOX = { width: 64, height: 34 } as const;

/**
 * The faceted lemniscate. Both diagonals pass straight through 32,17, so the
 * ribbon crosses over itself the way a real one does rather than two shapes
 * touching. Twelve straight facets, no arc anywhere — obsidian fractures.
 */
export const LOOP_PATH =
  'M32,17 L23,6 L12,6 L4,17 L12,28 L23,28 L32,17 L41,6 L52,6 L60,17 L52,28 L41,28 Z';

/** Four-point spark, radius 10.5 about the crossing. */
export const SPARK_PATH =
  'M32,6.5C32,10.275 36.725,17 42.5,17C36.725,17 32,23.725 32,27.5' +
  'C32,23.725 27.275,17 21.5,17C27.275,17 32,10.275 32,6.5Z';

/**
 * The loop as a graph: eleven vertices, each with the point along the path at
 * which a traveller reaches it.
 *
 * `phase` is a fraction of the closed path's length, computed from the facet
 * lengths rather than eyeballed — the facets are not equal, so evenly spaced
 * timings would visibly drift out of step with the pulse by the far side.
 * (14.213, 11, 13.601, 13.601, 11, 14.213 per lobe; 155.256 in total.)
 *
 * The crossing appears twice on purpose: a traveller passes through the centre
 * at 0 and again at 0.5, which is why the spark flares twice per lap. That beat
 * is the whole mark — the same spark, come round and lit again.
 */
export interface LoopNode {
  x: number;
  y: number;
  /** Fraction of the lap at which the pulse arrives, 0–1. */
  phase: number;
  /** True for the crossing, which is the spark's seat and is drawn larger. */
  crossing?: boolean;
}

export const LOOP_NODES: readonly LoopNode[] = [
  { x: 32, y: 17, phase: 0, crossing: true },
  { x: 23, y: 6, phase: 0.0915 },
  { x: 12, y: 6, phase: 0.1624 },
  { x: 4, y: 17, phase: 0.25 },
  { x: 12, y: 28, phase: 0.3376 },
  { x: 23, y: 28, phase: 0.4084 },
  { x: 32, y: 17, phase: 0.5, crossing: true },
  { x: 41, y: 6, phase: 0.5915 },
  { x: 52, y: 6, phase: 0.6624 },
  { x: 60, y: 17, phase: 0.75 },
  { x: 52, y: 28, phase: 0.8376 },
  { x: 41, y: 28, phase: 0.9084 },
];

/**
 * Shrink the spark when the loop is drawn as a graph rather than as a ribbon.
 *
 * The mark's proportions are set against a 4.6-wide stroke: at that weight the
 * spark and the loop are the same order of thing, and the crossing is implied
 * by the ribbon rather than drawn. Trace the loop at 1.7 instead and the spark
 * — unchanged — becomes three times the visual mass of everything around it. It
 * covers both diagonals, and the mark stops reading as a lemniscate and starts
 * reading as two hexagons with a star between them. That is the failure mode
 * `.context/framework/resparkable/brand-assets.md` records from the very first
 * version of the logo, arrived at from the opposite direction.
 *
 * Scaling about 32,17 keeps the spark centred on the crossing and lets both
 * diagonals through underneath, which is what recovers the ∞.
 */
export const TRACED_SPARK_TRANSFORM = 'translate(32 17) scale(0.54) translate(-32 -17)';

/**
 * The clearance ring around the spark, as a stroke width on the mask.
 *
 * It scales with the spark for the same reason the spark scales with the
 * stroke: a 2.8 ring around a 0.54-scale spark punches a hole most of the way
 * across the crossing, and clears the very diagonals the smaller spark was
 * shrunk to reveal.
 */
export const TRACED_SPARK_CLEARANCE = 1.4;

/**
 * How long one lap takes, in seconds.
 *
 * Slow on purpose. This runs continuously on a page someone is reading, and
 * anything quick enough to catch the eye twice is a page you cannot read. At
 * this speed it registers as the page being warm rather than as an animation.
 */
export const LAP_SECONDS = 11;

/**
 * The travelling dash covers 14% of the lap, so its leading edge sits 0.14
 * ahead of `stroke-dashoffset`; the node keyframe peaks 6% into its own cycle.
 * Solving for "peak lands when the head arrives" gives `phase - 0.20`, shifted
 * a whole lap negative so every node is already in step on first paint instead
 * of the mesh filling in over the first eleven seconds.
 */
export function nodeDelay(phase: number, lap: number = LAP_SECONDS): string {
  return `${((phase - 1.2) * lap).toFixed(2)}s`;
}

/**
 * The custom properties the mesh classes in `brand-theme.css` read.
 *
 * They exist so the timing can live here, beside the vertex table that computes
 * it, instead of being duplicated in CSS as numbers nobody can check against
 * the geometry.
 */
export interface SparkStyle extends CSSProperties {
  /** One lap of the loop. Drives the trace, the vertices and the spark. */
  '--spark-lap'?: string;
  /** This element's offset into its own animation, as a CSS time. */
  '--spark-phase'?: string;
  /** The far nodes' breathe cycle, which is deliberately not a factor of the lap. */
  '--spark-mote-lap'?: string;
}

/**
 * Widen a spark style to what `style` accepts.
 *
 * `React.CSSProperties` has no index signature, so custom properties do not
 * type-check against it inline — and `@typescript-eslint/consistent-type-assertions`
 * (rightly) bans the `as` that would paper over it. Declaring the shape once and
 * returning it keeps every call site assertion-free.
 */
export function sparkStyle(vars: SparkStyle): CSSProperties {
  return vars;
}
