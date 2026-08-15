import { cn } from '@/lib/utils';
import {
  LOOP_PATH,
  SPARK_PATH,
  LOOP_NODES,
  LAP_SECONDS,
  nodeDelay,
  sparkStyle,
  TRACED_SPARK_TRANSFORM,
  TRACED_SPARK_CLEARANCE,
} from '@/components/brand/geometry';
import {
  BrandGradientDefs,
  BRAND_LOOP_GRADIENT_ID,
  BRAND_SPARK_GRADIENT_ID,
} from '@/components/brand/brand-gradients';

/**
 * SparkMesh — the mark, read as the graph it already is, inside a wider field.
 *
 * **Fork-owned.** The public pages' one piece of artwork.
 *
 * ## Why this and not an illustration
 *
 * The landing hero used to have a mocked-up capture panel, and it went because a
 * diagram of the product is not the product. This is not a diagram of the
 * product either — it is the logo, drawn at a size where you can see what it is
 * made of. Eleven vertices, twelve straight facets, and a pulse that laps them.
 * Nothing here claims a feature.
 *
 * The wider mesh is the part that carries the argument. The loop is not floating
 * in a void; it is one knot in a field of other nodes, and three of those far
 * nodes catch light shortly after the spark crosses the centre — while the
 * crossing itself does not dim to pay for it. That is the only thing the page
 * needs a picture for, and it is not a thing a sentence does well.
 *
 * ## Why it is CSS and not a canvas
 *
 * Every moving part is `opacity`, `transform` or `stroke-dashoffset`, which the
 * compositor handles without touching layout or paint. There is no rAF loop, no
 * client bundle and no hydration — this is a Server Component that ships as
 * markup. A `<canvas>` particle field would cost all four and look worse, since
 * the geometry here is exact rather than random.
 *
 * The timing lives in `geometry.ts` beside the vertex table that computes it:
 * facet lengths differ, so evenly-spaced flashes drift visibly out of step with
 * the pulse by the far lobe. `--spark-lap` and `--spark-phase` carry the numbers
 * into the classes in `brand-theme.css`.
 *
 * ## Colour
 *
 * The loop, the travelling trace and the crossing spark draw from
 * `BrandGradientDefs`, the same ramp `BrandMark` and `SparkGlyph` use, so the
 * mark itself carries the same dim-tail-to-hot-head nuance everywhere it
 * appears. The field lines and the far motes stay flat and dim on
 * `currentColor`: they are ambient context for the mark, not the mark, and
 * giving them the same ramp would compete with it instead of setting it off.
 *
 * ## Ids
 *
 * Fixed, not `useId`. Two instances can appear on one page (hero and footer
 * band); every instance emits byte-identical `<mask>` content, so a browser
 * resolving all references to the first is a no-op. `useId` is also a hook, and
 * this deliberately is not a client component. Same reasoning covers the
 * gradient defs.
 */

/**
 * Far nodes. Not on the loop — the field the loop sits in.
 *
 * `kind: 'mote'` breathes on its own long cycle, unrelated to the pulse: the
 * field is not something the loop drives. `kind: 'relay'` is the exception —
 * three nodes that catch shortly after the spark crosses the centre, and
 * `phase` for those is a lap fraction rather than a mote offset.
 *
 * What makes the field read as branching rather than as a ring: six
 * "primary" nodes (`p*`) take a single spoke each into the loop, each
 * primary sprouts a couple of smaller "secondary" nodes of its own (`s*`),
 * and a few of those sprout one or two smaller "leaf" nodes still (`l*`).
 * Nothing connects sideways — every far node has exactly one line back
 * toward the loop, never a line to a same-tier neighbour, which is what a
 * hand-grown branch looks like next to a perimeter of evenly spaced stops.
 * `r` shrinks down the naming tiers so the eye reads depth (trunk → branch
 * → twig) without the edges needing to say so.
 */
interface Mote {
  id: string;
  x: number;
  y: number;
  r: number;
  kind: 'mote' | 'relay';
  /** Lap fraction for a relay; seconds-offset divisor for a mote. */
  phase: number;
}

const MOTES: readonly Mote[] = [
  // primary — one spoke each into the loop, see MESH_EDGES
  { id: 'pa', x: 26, y: 50, r: 1.9, kind: 'relay', phase: 0.07 },
  { id: 'pb', x: 46, y: 10, r: 1.6, kind: 'mote', phase: 0.42 },
  { id: 'pc', x: 128, y: 12, r: 1.8, kind: 'relay', phase: 0.56 },
  { id: 'pd', x: 150, y: 50, r: 1.9, kind: 'mote', phase: 0.18 },
  { id: 'pe', x: 112, y: 96, r: 1.7, kind: 'relay', phase: 0.53 },
  { id: 'pf', x: 40, y: 94, r: 1.6, kind: 'mote', phase: 0.71 },

  // secondary — a handful of threads off each primary
  { id: 'sa1', x: 4, y: 30, r: 1.3, kind: 'mote', phase: 0.09 },
  { id: 'sa2', x: 2, y: 64, r: 1.2, kind: 'mote', phase: 0.63 },
  { id: 'sb1', x: 18, y: -6, r: 1.2, kind: 'mote', phase: 0.35 },
  { id: 'sb2', x: 68, y: -8, r: 1.1, kind: 'mote', phase: 0.88 },
  { id: 'sc1', x: 106, y: -8, r: 1.2, kind: 'mote', phase: 0.24 },
  { id: 'sc2', x: 154, y: -2, r: 1.3, kind: 'mote', phase: 0.5 },
  { id: 'sd1', x: 168, y: 28, r: 1.3, kind: 'mote', phase: 0.77 },
  { id: 'sd2', x: 168, y: 72, r: 1.2, kind: 'mote', phase: 0.15 },
  { id: 'se1', x: 132, y: 102, r: 1.1, kind: 'mote', phase: 0.44 },
  { id: 'sf1', x: 14, y: 102, r: 1.3, kind: 'mote', phase: 0.61 },
  { id: 'sf2', x: -8, y: 84, r: 1.1, kind: 'mote', phase: 0.03 },

  // leaf — one or two smaller nodes off a handful of secondaries
  { id: 'la1', x: -10, y: 14, r: 0.8, kind: 'mote', phase: 0.29 },
  { id: 'la2', x: -10, y: 44, r: 0.7, kind: 'mote', phase: 0.82 },
  { id: 'lc1', x: 168, y: -8, r: 0.8, kind: 'mote', phase: 0.11 },
  { id: 'lf1', x: -4, y: 100, r: 0.7, kind: 'mote', phase: 0.55 },
];

/**
 * The `wide` variant's extra reach — twigs off the field's own outermost
 * leaves (`la1`, `la2`, `sf2` on the left; `lc1`, `sd1`, `sd2` on the right),
 * continuing two tiers further out rather than a second, separate field
 * bolted on beside the first. Same coordinate space as `MOTES`, so a `wide`
 * caller just widens the `viewBox` (see `SparkMesh`) — nothing needs
 * re-aligning, because it was never a different drawing.
 */
const WING_MOTES: readonly Mote[] = [
  { id: 'wl1', x: -34, y: 4, r: 0.6, kind: 'mote', phase: 0.17 },
  { id: 'wl2', x: -36, y: 40, r: 0.6, kind: 'mote', phase: 0.71 },
  { id: 'wl3', x: -38, y: 78, r: 0.55, kind: 'mote', phase: 0.38 },
  { id: 'wl4', x: -62, y: -6, r: 0.5, kind: 'mote', phase: 0.94 },
  { id: 'wl5', x: -64, y: 58, r: 0.5, kind: 'mote', phase: 0.06 },
  { id: 'wl6', x: -58, y: 96, r: 0.5, kind: 'mote', phase: 0.52 },
  { id: 'wl7', x: -86, y: 24, r: 0.45, kind: 'mote', phase: 0.27 },
  { id: 'wl8', x: -84, y: 70, r: 0.45, kind: 'mote', phase: 0.85 },

  { id: 'wr1', x: 194, y: 12, r: 0.6, kind: 'mote', phase: 0.44 },
  { id: 'wr2', x: 198, y: 46, r: 0.6, kind: 'mote', phase: 0.13 },
  { id: 'wr3', x: 200, y: 84, r: 0.55, kind: 'mote', phase: 0.66 },
  { id: 'wr4', x: 224, y: 0, r: 0.5, kind: 'mote', phase: 0.31 },
  { id: 'wr5', x: 226, y: 62, r: 0.5, kind: 'mote', phase: 0.89 },
  { id: 'wr6', x: 220, y: 96, r: 0.5, kind: 'mote', phase: 0.58 },
  { id: 'wr7', x: 250, y: 20, r: 0.45, kind: 'mote', phase: 0.22 },
  { id: 'wr8', x: 248, y: 78, r: 0.45, kind: 'mote', phase: 0.77 },
];

/** Edges for `WING_MOTES` — same one-line-back-toward-the-loop rule. */
const WING_EDGES: readonly [number, number, number, number][] = [
  [-10, 14, -34, 4],
  [-10, 44, -36, 40],
  [-8, 84, -38, 78],
  [-34, 4, -62, -6],
  [-36, 40, -64, 58],
  [-38, 78, -58, 96],
  [-62, -6, -86, 24],
  [-64, 58, -84, 70],

  [168, -8, 194, 12],
  [168, 28, 198, 46],
  [168, 72, 200, 84],
  [194, 12, 224, 0],
  [198, 46, 226, 62],
  [200, 84, 220, 96],
  [224, 0, 250, 20],
  [226, 62, 248, 78],
];

/** The motes' own breathe cycle. Deliberately not a factor of the lap. */
const MOTE_SECONDS = 9;

/**
 * Mesh edges, viewBox coordinates. One line per far node back toward the
 * loop — primaries spoke into a vertex, secondaries branch off a primary,
 * leaves branch off a secondary — so the count matches `MOTES.length`
 * exactly: this is a tree, not a graph with cycles, and nothing chains one
 * outer node to its neighbour the way a rim would.
 */
const MESH_EDGES: readonly [number, number, number, number][] = [
  // spokes, primary → loop vertex (see LOOP_OFFSET for why these are
  // 52/35 more than geometry.ts's own LOOP_NODES coordinates)
  [26, 50, 56, 52],
  [46, 10, 75, 41],
  [128, 12, 104, 41],
  [150, 50, 112, 52],
  [112, 96, 93, 63],
  [40, 94, 75, 63],

  // branches, primary → secondary
  [26, 50, 4, 30],
  [26, 50, 2, 64],
  [46, 10, 18, -6],
  [46, 10, 68, -8],
  [128, 12, 106, -8],
  [128, 12, 154, -2],
  [150, 50, 168, 28],
  [150, 50, 168, 72],
  [112, 96, 132, 102],
  [40, 94, 14, 102],
  [40, 94, -8, 84],

  // twigs, secondary → leaf
  [4, 30, -10, 14],
  [4, 30, -10, 44],
  [154, -2, 168, -8],
  [14, 102, -4, 100],
];

/** Puts the 64×34 mark at the centre of the 168×104 field. */
const LOOP_OFFSET = 'translate(52 35)';

export function SparkMesh({
  className,
  wide = false,
}: {
  className?: string;
  /**
   * Reveal `WING_MOTES` either side of the regular field, on a proportionally
   * wider `viewBox`. Proportional is load-bearing: the loop and the regular
   * field are the same coordinates at the same scale either way, so `wide`
   * only ever adds canvas at the edges, it never zooms. A caller that widens
   * the *element* instead (a bigger `w-[...]` with `wide` off) scales
   * everything, loop included — that's the mistake this prop exists to avoid.
   * The footer band is the one caller so far: full strength on `/` and
   * `/about` would read as two logos; wide-and-faint reads as the same field
   * the hero sits in, glimpsed further down the page.
   */
  wide?: boolean;
}): React.ReactNode {
  const lap = sparkStyle({ '--spark-lap': `${LAP_SECONDS}s` });
  const motes = wide ? [...MOTES, ...WING_MOTES] : MOTES;
  const edges = wide ? [...MESH_EDGES, ...WING_EDGES] : MESH_EDGES;

  return (
    <svg
      viewBox={wide ? '-90 0 348 104' : '0 0 168 104'}
      className={cn('text-primary w-full', className)}
      style={lap}
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <BrandGradientDefs />
        {/* Dilated by a 2.8-wide stroke: this is the clearance ring around the
            spark, not the spark. Two opacities of one colour over near-black go
            muddy, so the silhouette does the separating instead. */}
        <mask id="spark-mesh-clear">
          <rect x="-20" y="-20" width="208" height="144" fill="#fff" />
          <g transform={LOOP_OFFSET}>
            <path
              d={SPARK_PATH}
              transform={TRACED_SPARK_TRANSFORM}
              fill="#000"
              stroke="#000"
              strokeWidth={TRACED_SPARK_CLEARANCE}
              strokeLinejoin="round"
            />
          </g>
        </mask>
      </defs>

      {/* The field. Was 10% opacity — the same "present, unnameable" contract
          `.lattice-field`'s own grid runs on — but that contract assumes a
          plain surface behind it. Sat over `.lattice-field-hex`'s honeycomb
          it read as translucent rather than dim: the grid showed straight
          through it instead of the field reading as its own layer. Solid
          enough now to hold its own line over a textured background, still
          well under the loop's own strength so the mark stays the thing the
          field is *around*. */}
      <g stroke="currentColor" strokeWidth="0.6" opacity="0.4">
        {edges.map(([x1, y1, x2, y2]) => (
          <line key={`${x1},${y1},${x2},${y2}`} x1={x1} y1={y1} x2={x2} y2={y2} />
        ))}
      </g>

      <g fill="currentColor">
        {motes.map((mote) => (
          <circle
            key={mote.id}
            cx={mote.x}
            cy={mote.y}
            r={mote.r}
            className={mote.kind === 'relay' ? 'spark-relay' : 'spark-mote'}
            style={sparkStyle({
              '--spark-phase':
                mote.kind === 'relay'
                  ? nodeDelay(mote.phase)
                  : `${(-mote.phase * MOTE_SECONDS).toFixed(2)}s`,
            })}
          />
        ))}
      </g>

      <g transform={LOOP_OFFSET}>
        {/* The structure: the loop as a standing thing, dim relative to the
            traveller but no longer dim enough to vanish into the hex grid
            behind it — was 0.22. */}
        <path
          d={LOOP_PATH}
          mask="url(#spark-mesh-clear)"
          fill="none"
          stroke={`url(#${BRAND_LOOP_GRADIENT_ID})`}
          strokeWidth="1.5"
          strokeMiterlimit="10"
          opacity="0.55"
        />

        {/* The traveller. Same path, bright, 14% of the lap visible at a time. */}
        <path
          d={LOOP_PATH}
          pathLength="100"
          mask="url(#spark-mesh-clear)"
          fill="none"
          stroke={`url(#${BRAND_LOOP_GRADIENT_ID})`}
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeMiterlimit="10"
          className="spark-trace"
        />

        {/* Vertices. The crossing is drawn by the spark below, not here. */}
        <g fill={`url(#${BRAND_LOOP_GRADIENT_ID})`}>
          {LOOP_NODES.filter((node) => !node.crossing).map((node) => (
            <circle
              key={`${node.x},${node.y}`}
              cx={node.x}
              cy={node.y}
              r="1.15"
              className="spark-node"
              style={sparkStyle({ '--spark-phase': nodeDelay(node.phase) })}
            />
          ))}
        </g>

        {/* The positioning transform sits on a wrapper, not on the path. A CSS
            `transform` in the keyframes replaces an element's own transform
            attribute rather than composing with it, so animating the path
            directly would throw away the scale that sizes it. */}
        <g transform={TRACED_SPARK_TRANSFORM}>
          <path
            d={SPARK_PATH}
            fill={`url(#${BRAND_SPARK_GRADIENT_ID})`}
            className="spark-core"
            style={sparkStyle({ '--spark-phase': nodeDelay(0) })}
          />
        </g>
      </g>
    </svg>
  );
}
