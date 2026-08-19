/**
 * buildSlidesFromSelection — the pure core of Present mode's "Pre-planned
 * deck" (`plan.md` §22.1.2): turn a set of chosen Graph nodes into an
 * ordered deck, no model call.
 *
 * ## What "selection" is, and what it deliberately isn't yet
 *
 * `GraphView` has no node multi-select today — a click re-centres the URL
 * rather than picking anything, and Phase 3 committed to leaving it
 * unmodified. Rather than invent a canvas gesture as a side effect of this
 * phase, selection here is an explicit `ReadonlySet<string>` of
 * `"type:id"` keys against an already-fetched `GraphPayloadWire` — real
 * data (the same payload `GraphTab` renders), just chosen through
 * `NodeSelector`'s checklist rather than the graph canvas. See the build
 * plan's deferred follow-ups for the candidate designs considered for a
 * real canvas gesture, including one that needs its own design pass
 * because it calls a model.
 *
 * ## Order comes from the selection, not the payload
 *
 * A `Set`'s iteration order is insertion order, so walking `selectedKeys`
 * (not `payload.nodes`) means the deck plays back in the order a person
 * checked things — the order they'd naturally narrate them in — rather
 * than whatever order the graph endpoint happened to return.
 *
 * ## The `connector`
 *
 * `ResparkableLink.rationale` already answers "why are these related" for
 * any accepted or suggested edge — when consecutive slides in the deck
 * were directly linked in the graph, that rationale becomes the slide's
 * `connector`: a presenter's one-line reminder of why this idea follows
 * the last one, read straight off data that already existed rather than
 * synthesised.
 */

import type { GraphPayloadWire } from '@/lib/framework/resparkable/ui/payloads';

export interface Slide {
  /** `"type:id"` — matches the key `GraphView`/`NodeSelector` use for the same node. */
  key: string;
  type: string;
  id: string;
  title: string;
  /** The node's `subtitle`, if it has one — the closest thing to a snippet the graph payload carries. */
  body: string;
  /** The connecting edge's rationale, when one links this slide to the previous one. */
  connector: string | null;
}

function nodeKey(type: string, id: string): string {
  return `${type}:${id}`;
}

/** Order-independent key for an edge between two nodes — rationale reads the same either direction. */
function pairKey(a: string, b: string): string {
  return [a, b].sort().join('|');
}

export function buildSlidesFromSelection(
  payload: GraphPayloadWire,
  selectedKeys: ReadonlySet<string>
): Slide[] {
  const nodesByKey = new Map(payload.nodes.map((node) => [nodeKey(node.type, node.id), node]));

  const rationaleByPair = new Map<string, string>();
  for (const edge of payload.edges) {
    if (!edge.rationale) continue;
    const pair = pairKey(
      nodeKey(edge.sourceType, edge.sourceId),
      nodeKey(edge.targetType, edge.targetId)
    );
    rationaleByPair.set(pair, edge.rationale);
  }

  const slides: Slide[] = [];
  let previousKey: string | null = null;

  for (const key of selectedKeys) {
    const node = nodesByKey.get(key);
    // A selected key that no longer resolves (the payload changed under it)
    // is skipped rather than rendered as a slide about nothing.
    if (!node) continue;

    const connector = previousKey ? (rationaleByPair.get(pairKey(previousKey, key)) ?? null) : null;

    slides.push({
      key,
      type: node.type,
      id: node.id,
      title: node.title,
      body: node.subtitle ?? '',
      connector,
    });
    previousKey = key;
  }

  return slides;
}
