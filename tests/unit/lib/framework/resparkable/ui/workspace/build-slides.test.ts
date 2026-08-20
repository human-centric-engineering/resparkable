/**
 * Unit Tests: buildSlidesFromSelection.
 *
 * Pure function — no rendering, no network. The two things worth pinning
 * down beyond "it maps nodes to slides": deck order follows the *selection*
 * (insertion order of the `Set`), not the payload's own node order, and a
 * `connector` only appears when consecutive slides were actually linked by
 * an edge carrying a rationale — never fabricated, never carried over from
 * a non-adjacent pair.
 *
 * @see lib/framework/resparkable/ui/workspace/build-slides.ts
 */

import { describe, it, expect } from 'vitest';

import { buildSlidesFromSelection } from '@/lib/framework/resparkable/ui/workspace/build-slides';
import type { GraphPayloadWire } from '@/lib/framework/resparkable/ui/payloads';

function payload(overrides: Partial<GraphPayloadWire> = {}): GraphPayloadWire {
  return {
    focus: { type: 'project', id: 'proj_1' },
    nodes: [
      { type: 'project', id: 'proj_1', title: 'Q4 launch', subtitle: 'The big push', depth: 0 },
      { type: 'thought', id: 'th_1', title: 'A note', subtitle: null, depth: 1 },
      { type: 'entity', id: 'ent_1', title: 'Acme Corp', subtitle: 'Client', depth: 1 },
    ],
    edges: [
      {
        linkId: 'link_1',
        sourceType: 'project',
        sourceId: 'proj_1',
        targetType: 'thought',
        targetId: 'th_1',
        kind: 'relates_to',
        status: 'accepted',
        strength: 0.8,
        rationale: 'Both discuss the Q4 filing',
      },
      {
        linkId: 'link_2',
        sourceType: 'thought',
        sourceId: 'th_1',
        targetType: 'entity',
        targetId: 'ent_1',
        kind: 'relates_to',
        status: 'suggested',
        strength: null,
        rationale: null,
      },
    ],
    truncated: false,
    nodeCap: 150,
    depth: 2,
    ...overrides,
  };
}

describe('buildSlidesFromSelection', () => {
  it('builds one slide per selected node, with its title and subtitle', () => {
    const slides = buildSlidesFromSelection(payload(), new Set(['project:proj_1']));

    expect(slides).toEqual([
      {
        key: 'project:proj_1',
        type: 'project',
        id: 'proj_1',
        title: 'Q4 launch',
        body: 'The big push',
        connector: null,
      },
    ]);
  });

  it('falls back to an empty body when the node has no subtitle', () => {
    const slides = buildSlidesFromSelection(payload(), new Set(['thought:th_1']));
    expect(slides[0]?.body).toBe('');
  });

  it('orders the deck by selection order, not payload order', () => {
    const slides = buildSlidesFromSelection(payload(), new Set(['entity:ent_1', 'project:proj_1']));

    expect(slides.map((slide) => slide.key)).toEqual(['entity:ent_1', 'project:proj_1']);
  });

  it('attaches the connecting edge’s rationale to the slide that follows it', () => {
    const slides = buildSlidesFromSelection(payload(), new Set(['project:proj_1', 'thought:th_1']));

    expect(slides[0]?.connector).toBeNull();
    expect(slides[1]?.connector).toBe('Both discuss the Q4 filing');
  });

  it('reads the rationale the same way regardless of edge direction', () => {
    // link_1 runs project -> thought; selecting thought first, then project,
    // still has to find it.
    const slides = buildSlidesFromSelection(payload(), new Set(['thought:th_1', 'project:proj_1']));

    expect(slides[1]?.connector).toBe('Both discuss the Q4 filing');
  });

  it('leaves the connector null when the pair has no rationale', () => {
    const slides = buildSlidesFromSelection(payload(), new Set(['thought:th_1', 'entity:ent_1']));
    expect(slides[1]?.connector).toBeNull();
  });

  it('leaves the connector null when consecutive slides were never linked at all', () => {
    const slides = buildSlidesFromSelection(payload(), new Set(['project:proj_1', 'entity:ent_1']));
    expect(slides[1]?.connector).toBeNull();
  });

  it('skips a selected key that no longer resolves in the payload', () => {
    const slides = buildSlidesFromSelection(
      payload(),
      new Set(['project:proj_1', 'entity:gone', 'thought:th_1'])
    );

    expect(slides.map((slide) => slide.key)).toEqual(['project:proj_1', 'thought:th_1']);
    // The skipped key must not break the adjacency the connector relies on.
    expect(slides[1]?.connector).toBe('Both discuss the Q4 filing');
  });

  it('returns an empty deck for an empty selection', () => {
    expect(buildSlidesFromSelection(payload(), new Set())).toEqual([]);
  });
});
