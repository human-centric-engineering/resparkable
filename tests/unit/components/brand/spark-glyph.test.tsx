/**
 * SparkGlyph / SparkIcon / SparkRule (components/brand/spark-glyph.tsx)
 *
 * Three small SVG mark components with prop-driven branches:
 *  - `SparkGlyph`'s `traced` prop swaps stroke widths/opacity and adds the
 *    travelling trace path + vertex dots (minus the two crossing nodes).
 *  - all three components' `title` prop flips them between decorative
 *    (`aria-hidden`, no role) and named (`role="img"`, `aria-label`).
 *  - `SparkRule`'s `withGlyph` prop swaps a bare hairline for a hairline +
 *    centred `SparkGlyph`.
 *
 * These tests assert the actual DOM shape each branch produces — attribute
 * values, node counts, transforms — computed against the real geometry
 * constants, not hardcoded numbers that would drift silently from them.
 *
 * @see components/brand/spark-glyph.tsx · components/brand/geometry.ts
 */

import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { SparkGlyph, SparkIcon, SparkRule } from '@/components/brand/spark-glyph';
import {
  LOOP_NODES,
  TRACED_SPARK_TRANSFORM,
  TRACED_SPARK_CLEARANCE,
  LAP_SECONDS,
  nodeDelay,
} from '@/components/brand/geometry';

describe('SparkGlyph', () => {
  it('is decorative by default: hidden from the accessibility tree, no role', () => {
    const { container } = render(<SparkGlyph />);
    const svg = container.querySelector('svg');

    expect(svg).not.toBeNull();
    expect(svg?.getAttribute('role')).toBeNull();
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    expect(svg?.getAttribute('aria-label')).toBeNull();
  });

  it('becomes a named image when given a title', () => {
    const { container } = render(<SparkGlyph title="Resparkable" />);
    const svg = container.querySelector('svg');

    expect(svg?.getAttribute('role')).toBe('img');
    expect(svg?.getAttribute('aria-hidden')).toBeNull();
    expect(svg?.getAttribute('aria-label')).toBe('Resparkable');
  });

  it('merges a caller className onto the base shrink-0 class', () => {
    const { container } = render(<SparkGlyph className="h-4 w-8" />);
    const svg = container.querySelector('svg');

    expect(svg?.classList.contains('shrink-0')).toBe(true);
    expect(svg?.classList.contains('h-4')).toBe(true);
    expect(svg?.classList.contains('w-8')).toBe(true);
  });

  it('sets the lap duration as a CSS custom property from LAP_SECONDS', () => {
    const { container } = render(<SparkGlyph />);
    const svg = container.querySelector<SVGSVGElement>('svg');

    expect(svg?.style.getPropertyValue('--spark-lap')).toBe(`${LAP_SECONDS}s`);
  });

  it('untraced: draws the plain-weight clearance mask with no transform', () => {
    const { container } = render(<SparkGlyph />);
    const maskPath = container.querySelector('mask path');

    expect(maskPath?.getAttribute('stroke-width')).toBe('2.8');
    expect(maskPath?.getAttribute('transform')).toBeNull();
  });

  it('untraced: draws the loop at full weight and full opacity, with no trace or vertices', () => {
    const { container } = render(<SparkGlyph />);
    // The loop stroke is the only bare (classless) direct-child <path> when untraced.
    const loopPath = container.querySelector('svg > path:not([class])');

    expect(loopPath?.getAttribute('stroke-width')).toBe('4.6');
    expect(loopPath?.getAttribute('opacity')).toBe('1');
    expect(container.querySelector('.spark-trace')).toBeNull();
    expect(container.querySelectorAll('circle.spark-node')).toHaveLength(0);
  });

  it('untraced: draws the spark core with no positioning transform', () => {
    const { container } = render(<SparkGlyph />);
    const sparkPath = container.querySelector('svg > g > path');

    expect(sparkPath?.parentElement?.getAttribute('transform')).toBeNull();
    expect(sparkPath?.classList.contains('spark-core')).toBe(false);
  });

  it('traced: shrinks the clearance mask and moves it to the crossing', () => {
    const { container } = render(<SparkGlyph traced />);
    const maskPath = container.querySelector('mask path');

    expect(maskPath?.getAttribute('transform')).toBe(TRACED_SPARK_TRANSFORM);
    expect(maskPath?.getAttribute('stroke-width')).toBe(String(TRACED_SPARK_CLEARANCE));
  });

  it('traced: dims the ribbon loop and thins its stroke', () => {
    const { container } = render(<SparkGlyph traced />);
    const loopPath = container.querySelector('svg > path:not([class])');

    expect(loopPath?.getAttribute('stroke-width')).toBe('1.6');
    expect(loopPath?.getAttribute('opacity')).toBe('0.55');
  });

  it('traced: adds the travelling trace path over the loop', () => {
    const { container } = render(<SparkGlyph traced />);
    const trace = container.querySelector('path.spark-trace');

    expect(trace).not.toBeNull();
    expect(trace?.getAttribute('stroke-width')).toBe('1.8');
    expect(trace?.getAttribute('pathLength')).toBe('100');
  });

  it('traced: draws one vertex dot per non-crossing node, skipping the two crossings', () => {
    const { container } = render(<SparkGlyph traced />);
    const nonCrossingCount = LOOP_NODES.filter((node) => !node.crossing).length;
    const crossingCount = LOOP_NODES.filter((node) => node.crossing).length;

    // Sanity on the fixture itself, so this test fails loudly if geometry.ts
    // ever stops shipping exactly two crossing nodes.
    expect(crossingCount).toBe(2);

    const dots = container.querySelectorAll('circle.spark-node');
    expect(dots).toHaveLength(nonCrossingCount);
  });

  it('traced: phases each vertex dot from its own node.phase via nodeDelay', () => {
    const { container } = render(<SparkGlyph traced />);
    const firstNonCrossing = LOOP_NODES.filter((node) => !node.crossing)[0];
    const dot = container.querySelector<SVGCircleElement>(
      `circle[cx="${firstNonCrossing.x}"][cy="${firstNonCrossing.y}"]`
    );

    expect(dot?.style.getPropertyValue('--spark-phase')).toBe(nodeDelay(firstNonCrossing.phase));
  });

  it('traced: repositions the spark core to the crossing and phases it at 0', () => {
    const { container } = render(<SparkGlyph traced />);
    const sparkPath = container.querySelector<SVGPathElement>('svg > g > path');

    expect(sparkPath?.parentElement?.getAttribute('transform')).toBe(TRACED_SPARK_TRANSFORM);
    expect(sparkPath?.classList.contains('spark-core')).toBe(true);
    expect(sparkPath?.style.getPropertyValue('--spark-phase')).toBe(nodeDelay(0));
  });
});

describe('SparkIcon', () => {
  it('is decorative by default: hidden from the accessibility tree, no role', () => {
    const { container } = render(<SparkIcon />);
    const svg = container.querySelector('svg');

    expect(svg?.getAttribute('role')).toBeNull();
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    expect(svg?.getAttribute('aria-label')).toBeNull();
  });

  it('becomes a named image when given a title', () => {
    const { container } = render(<SparkIcon title="Ask Sparkey" />);
    const svg = container.querySelector('svg');

    expect(svg?.getAttribute('role')).toBe('img');
    expect(svg?.getAttribute('aria-hidden')).toBeNull();
    expect(svg?.getAttribute('aria-label')).toBe('Ask Sparkey');
  });

  it('merges a caller className onto the base shrink-0 class', () => {
    const { container } = render(<SparkIcon className="h-5 w-5" />);
    const svg = container.querySelector('svg');

    expect(svg?.classList.contains('shrink-0')).toBe(true);
    expect(svg?.classList.contains('h-5')).toBe(true);
  });

  it('spreads unknown props onto the svg element, e.g. to drop into an icon-shaped slot', () => {
    const onClick = vi.fn();
    const { container } = render(<SparkIcon data-testid="sparkey-icon" onClick={onClick} />);
    const svg = container.querySelector('svg');

    expect(svg?.getAttribute('data-testid')).toBe('sparkey-icon');

    svg?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('draws a single spark path with no loop, mask, or trace elements', () => {
    const { container } = render(<SparkIcon />);

    expect(container.querySelectorAll('path')).toHaveLength(1);
    expect(container.querySelector('mask')).toBeNull();
    expect(container.querySelector('.spark-trace')).toBeNull();
  });
});

describe('SparkRule', () => {
  it('renders only a hairline, with no glyph, when withGlyph is false', () => {
    const { container } = render(<SparkRule withGlyph={false} />);

    expect(container.querySelector('svg')).toBeNull();
    const rule = container.firstElementChild;
    expect(rule?.getAttribute('aria-hidden')).toBe('true');
    expect(rule).toHaveClass('h-px');
  });

  it('renders the glyph centred between two hairlines by default', () => {
    const { container } = render(<SparkRule />);

    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    // Sized down for the rule, per the withGlyph implementation.
    expect(svg?.classList.contains('h-[14px]')).toBe(true);
    expect(svg?.classList.contains('opacity-60')).toBe(true);

    const spans = container.querySelectorAll('span');
    expect(spans).toHaveLength(2);
  });

  it('is decorative even with the glyph present', () => {
    const { container } = render(<SparkRule withGlyph />);
    const rule = container.firstElementChild;

    expect(rule?.getAttribute('aria-hidden')).toBe('true');
  });

  it('applies a caller className to the outer wrapper in both modes', () => {
    const withGlyph = render(<SparkRule className="my-8" />);
    expect(withGlyph.container.firstElementChild).toHaveClass('my-8');

    const withoutGlyph = render(<SparkRule className="my-8" withGlyph={false} />);
    expect(withoutGlyph.container.firstElementChild).toHaveClass('my-8');
  });
});
