'use client';

/**
 * NodeSelector — how "Deck" mode's selection actually gets built.
 *
 * `GraphView` has no click-to-select today (a click re-centres the URL),
 * and Phase 3 committed to leaving it unmodified — see
 * `build-slides.ts`'s own header comment for the fuller reasoning. This
 * checklist is the selection surface instead: real nodes from an
 * already-fetched `GraphPayloadWire`, chosen in the order a person checks
 * them, which is also the order `buildSlidesFromSelection()` plays them
 * back in.
 */

import * as React from 'react';

import type { GraphNodeWire } from '@/lib/framework/resparkable/ui/payloads';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';

export interface NodeSelectorProps {
  nodes: GraphNodeWire[];
  selectedKeys: ReadonlySet<string>;
  onToggle: (key: string) => void;
  onBuild: () => void;
}

function keyOf(node: GraphNodeWire): string {
  return `${node.type}:${node.id}`;
}

export function NodeSelector({
  nodes,
  selectedKeys,
  onToggle,
  onBuild,
}: NodeSelectorProps): React.ReactElement {
  return (
    <div className="flex h-full flex-col gap-2">
      <ul className="flex-1 space-y-1 overflow-y-auto">
        {nodes.map((node) => {
          const key = keyOf(node);
          const checked = selectedKeys.has(key);
          const inputId = `present-node-${key}`;

          return (
            <li key={key}>
              <label
                htmlFor={inputId}
                className={cn(
                  'flex cursor-pointer items-center gap-2 rounded-md border p-2 text-sm transition-colors',
                  checked ? 'border-primary bg-primary/5' : 'hover:bg-muted/50 border-transparent'
                )}
              >
                <Checkbox id={inputId} checked={checked} onCheckedChange={() => onToggle(key)} />
                <span className="min-w-0 flex-1 truncate">{node.title}</span>
                {node.subtitle && (
                  <span className="text-muted-foreground truncate text-xs">{node.subtitle}</span>
                )}
              </label>
            </li>
          );
        })}
      </ul>

      <Button size="sm" onClick={onBuild} disabled={selectedKeys.size === 0}>
        Build deck ({selectedKeys.size})
      </Button>
    </div>
  );
}
