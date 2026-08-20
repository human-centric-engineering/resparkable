/**
 * ActivityItem — one entry in the Activity pane's feed.
 *
 * The build plan's shorthand for this type is `{ kind: 'discovery',
 * ...ConnectionRowWire }` — taken literally that spread would collide with
 * (and silently win over) `ConnectionRowWire.kind`, which is the *link's*
 * kind (`relates_to`, …), not the feed-item discriminant. Nesting the row
 * under `connection` instead keeps the two `kind` fields apart and is what
 * actually lets a later `{kind:'event', event: …}` / `{kind:'notice', …}`
 * union member get added without a rework, which is the property the plan
 * is after. Only `discovery` is real today.
 */

import type { ConnectionRowWire } from '@/lib/framework/resparkable/ui/payloads';

export interface DiscoveryItem {
  kind: 'discovery';
  connection: ConnectionRowWire;
}

export type ActivityItem = DiscoveryItem;
