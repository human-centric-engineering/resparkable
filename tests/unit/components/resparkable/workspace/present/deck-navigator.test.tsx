/**
 * Unit Tests: DeckNavigator.
 *
 * @see components/resparkable/workspace/present/deck-navigator.tsx
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { DeckNavigator } from '@/components/resparkable/workspace/present/deck-navigator';
import type { Slide } from '@/lib/framework/resparkable/ui/workspace/build-slides';

const SLIDES: Slide[] = [
  {
    key: 'a',
    type: 'project',
    id: 'proj_1',
    title: 'Q4 launch',
    body: 'The big push',
    connector: null,
  },
  {
    key: 'b',
    type: 'thought',
    id: 'th_1',
    title: 'A note',
    body: '',
    connector: 'Both discuss the Q4 filing',
  },
];

describe('DeckNavigator', () => {
  it('renders nothing for an empty deck', () => {
    const { container } = render(
      <DeckNavigator slides={[]} currentIndex={0} onPrev={vi.fn()} onNext={vi.fn()} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the current slide’s title, body and position', () => {
    render(<DeckNavigator slides={SLIDES} currentIndex={0} onPrev={vi.fn()} onNext={vi.fn()} />);

    expect(screen.getByText('Q4 launch')).toBeInTheDocument();
    expect(screen.getByText('The big push')).toBeInTheDocument();
    expect(screen.getByText('1 of 2')).toBeInTheDocument();
  });

  it('shows the connector only when the slide has one', () => {
    const { rerender } = render(
      <DeckNavigator slides={SLIDES} currentIndex={0} onPrev={vi.fn()} onNext={vi.fn()} />
    );
    expect(screen.queryByText(/Why this follows/)).not.toBeInTheDocument();

    rerender(<DeckNavigator slides={SLIDES} currentIndex={1} onPrev={vi.fn()} onNext={vi.fn()} />);
    expect(screen.getByText(/Why this follows: Both discuss the Q4 filing/)).toBeInTheDocument();
  });

  it('disables Previous on the first slide and Next on the last', () => {
    render(<DeckNavigator slides={SLIDES} currentIndex={0} onPrev={vi.fn()} onNext={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Previous slide' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next slide' })).toBeEnabled();
  });

  it('calls onNext/onPrev when clicked', async () => {
    const user = userEvent.setup();
    const onNext = vi.fn();
    const onPrev = vi.fn();
    render(<DeckNavigator slides={SLIDES} currentIndex={1} onPrev={onPrev} onNext={onNext} />);

    await user.click(screen.getByRole('button', { name: 'Previous slide' }));
    expect(onPrev).toHaveBeenCalledTimes(1);

    expect(screen.getByRole('button', { name: 'Next slide' })).toBeDisabled();
  });
});
