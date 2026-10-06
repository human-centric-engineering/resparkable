// @vitest-environment happy-dom

/**
 * Unit Tests: the `feed` tab adapter (phase 59).
 *
 * @see components/resparkable/workspace/tabs/feed-tab.tsx
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/components/resparkable/groups/group-feed', () => ({
  GroupFeed: () => <div>the group feed</div>,
}));

import { FeedTab } from '@/components/resparkable/workspace/tabs/feed-tab';
import { keysForTab } from '@/lib/framework/resparkable/ui/workspace/change-scope';
import { TAB_REGISTRY } from '@/lib/framework/resparkable/ui/workspace/tab-registry';

describe('FeedTab', () => {
  it('renders the group feed', () => {
    render(<FeedTab />);

    expect(screen.getByText('the group feed')).toBeInTheDocument();
  });

  it('has no page of its own, and refreshes on a write to anything it can show', () => {
    expect(TAB_REGISTRY.feed.routeBacked).toBe(false);
    expect(keysForTab('feed', {})).toEqual(expect.arrayContaining(['task', 'thought', 'project']));
  });
});
