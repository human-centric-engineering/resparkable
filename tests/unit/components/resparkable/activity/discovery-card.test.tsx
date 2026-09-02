// @vitest-environment happy-dom

/**
 * Unit Tests: DiscoveryCard.
 *
 * `onDecide` is a prop here — `ActivityPane` owns the actual PATCH and the
 * optimistic-removal `Set`, covered in `activity-pane.test.tsx`. What this
 * file covers is the card's own contract: both ends of the connection are
 * named, the rationale stays hidden until "See why" is opened, and the two
 * accept/reject buttons report the right id and status.
 *
 * @see components/resparkable/activity/discovery-card.tsx
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { DiscoveryCard } from '@/components/resparkable/activity/discovery-card';
import type { DiscoveryItem } from '@/components/resparkable/activity/activity-types';
import type { ConnectionRowWire } from '@/lib/framework/resparkable/ui/payloads';

function connection(overrides: Partial<ConnectionRowWire> = {}): ConnectionRowWire {
  return {
    id: 'link_1',
    kind: 'relates_to',
    status: 'suggested',
    origin: 'rule',
    strength: 0.68,
    rationale: 'Both discuss the Q4 filing',
    createdAt: '2026-07-20T09:00:00.000Z',
    reviewedAt: null,
    source: { type: 'thought', id: 'th_1', title: 'A note', subtitle: null, archivedAt: null },
    target: { type: 'project', id: 'proj_1', title: 'Q4 launch', subtitle: null, archivedAt: null },
    ...overrides,
  };
}

function item(overrides: Partial<ConnectionRowWire> = {}): DiscoveryItem {
  return { kind: 'discovery', connection: connection(overrides) };
}

describe('DiscoveryCard', () => {
  it('names both ends of the connection, with its strength', () => {
    render(<DiscoveryCard item={item()} onDecide={vi.fn()} />);

    expect(screen.getByText('A note')).toBeInTheDocument();
    expect(screen.getByText('Q4 launch')).toBeInTheDocument();
    expect(screen.getByText('68% similar')).toBeInTheDocument();
  });

  it('keeps the rationale hidden until "See why" is opened', async () => {
    const user = userEvent.setup();
    render(<DiscoveryCard item={item()} onDecide={vi.fn()} />);

    expect(screen.queryByText('Both discuss the Q4 filing')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'See why' }));

    expect(screen.getByText('Both discuss the Q4 filing')).toBeInTheDocument();
  });

  it('renders no accordion when there is no rationale', () => {
    render(<DiscoveryCard item={item({ rationale: null })} onDecide={vi.fn()} />);

    expect(screen.queryByRole('button', { name: 'See why' })).not.toBeInTheDocument();
  });

  it('accepts a suggestion', async () => {
    const user = userEvent.setup();
    const onDecide = vi.fn();
    render(<DiscoveryCard item={item()} onDecide={onDecide} />);

    await user.click(screen.getByRole('button', { name: 'Accept this connection' }));

    expect(onDecide).toHaveBeenCalledWith('link_1', 'accepted');
  });

  it('rejects with a tombstone, delivering what the button promises', async () => {
    const user = userEvent.setup();
    const onDecide = vi.fn();
    render(<DiscoveryCard item={item()} onDecide={onDecide} />);

    await user.click(
      screen.getByRole('button', { name: 'Not related — don’t suggest this again' })
    );

    expect(onDecide).toHaveBeenCalledWith('link_1', 'rejected');
  });

  it('labels a user-created suggestion as "you"', () => {
    render(<DiscoveryCard item={item({ origin: 'user' })} onDecide={vi.fn()} />);
    expect(screen.getByText('you')).toBeInTheDocument();
  });

  it('labels an agent-created suggestion as "the agent"', () => {
    render(<DiscoveryCard item={item({ origin: 'llm' })} onDecide={vi.fn()} />);
    expect(screen.getByText('the agent')).toBeInTheDocument();
  });

  it('labels a rule-based suggestion as "the sweep"', () => {
    render(<DiscoveryCard item={item({ origin: 'rule' })} onDecide={vi.fn()} />);
    expect(screen.getByText('the sweep')).toBeInTheDocument();
  });
});
