/**
 * Unit Tests: the in-content link seam.
 *
 * This component exists to settle a disagreement, so the tests are written
 * against the disagreement rather than against the implementation: the same
 * link, rendered in two places, has to do the two different right things.
 *
 * The modifier-click cases matter more than they look. Intercepting a click
 * is easy; intercepting only the clicks a person meant for the app, and
 * leaving ⌘-click, middle-click and "open in new window" to the browser, is
 * the part that makes it still a link rather than a button wearing an
 * underline. A regression there is invisible until someone tries to open a
 * project in a second window and gets nothing.
 *
 * @see components/resparkable/workspace/workspace-link.tsx
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { WorkspaceLink } from '@/components/resparkable/workspace/workspace-link';
import { Button } from '@/components/ui/button';
import { useOptionalWorkspace } from '@/components/resparkable/workspace/workspace-context';
import { RESPARKABLE_ROUTES } from '@/lib/framework/resparkable/ui/routes';

vi.mock('@/components/resparkable/workspace/workspace-context', () => ({
  useOptionalWorkspace: vi.fn(),
}));

const openTab = vi.fn();

/** Only `openTab` is read by this component; the rest of the context is irrelevant here. */
function insideWorkspace(): void {
  vi.mocked(useOptionalWorkspace).mockReturnValue({ openTab } as unknown as ReturnType<
    typeof useOptionalWorkspace
  >);
}

function outsideWorkspace(): void {
  vi.mocked(useOptionalWorkspace).mockReturnValue(null);
}

beforeEach(() => {
  openTab.mockReset();
  insideWorkspace();
});

describe('inside the workspace', () => {
  it('opens the tab the href names instead of navigating', async () => {
    const user = userEvent.setup();
    render(<WorkspaceLink href={RESPARKABLE_ROUTES.project('p1')}>Q3 Roadmap</WorkspaceLink>);

    await user.click(screen.getByRole('link', { name: 'Q3 Roadmap' }));

    expect(openTab).toHaveBeenCalledWith('project', { id: 'p1' });
  });

  it('carries the query string into the tab, not just the pathname', async () => {
    const user = userEvent.setup();
    render(<WorkspaceLink href={RESPARKABLE_ROUTES.searchFor('roadmap')}>Search</WorkspaceLink>);

    await user.click(screen.getByRole('link', { name: 'Search' }));

    // A Search tab opened with no query in it would be an empty box, which is
    // what a pathname-only resolver would have produced.
    expect(openTab).toHaveBeenCalledWith('search', expect.objectContaining({ query: 'roadmap' }));
  });

  it('keeps the real href on the element, so copy-link and the status bar still work', () => {
    render(<WorkspaceLink href={RESPARKABLE_ROUTES.entity('e1')}>Ada</WorkspaceLink>);

    expect(screen.getByRole('link', { name: 'Ada' })).toHaveAttribute(
      'href',
      RESPARKABLE_ROUTES.entity('e1')
    );
  });

  it('leaves a modified click to the browser, so ⌘-click still opens a real tab', async () => {
    const user = userEvent.setup();
    render(<WorkspaceLink href={RESPARKABLE_ROUTES.project('p1')}>Q3 Roadmap</WorkspaceLink>);

    await user.keyboard('{Meta>}');
    await user.click(screen.getByRole('link', { name: 'Q3 Roadmap' }));
    await user.keyboard('{/Meta}');

    expect(openTab).not.toHaveBeenCalled();
  });

  it('leaves a middle click to the browser too', async () => {
    const user = userEvent.setup();
    render(<WorkspaceLink href={RESPARKABLE_ROUTES.project('p1')}>Q3 Roadmap</WorkspaceLink>);

    await user.pointer({
      keys: '[MouseMiddle]',
      target: screen.getByRole('link', { name: 'Q3 Roadmap' }),
    });

    expect(openTab).not.toHaveBeenCalled();
  });

  it('still opens a tab when wrapped in <Button asChild>', async () => {
    const user = userEvent.setup();
    // Radix's `Slot` clones this element and passes its own props down. The
    // component spreads those *before* installing its handler for exactly this
    // reason; a regression to spreading them after would have `Slot`'s own
    // props quietly win and the click fall through to plain navigation.
    render(
      <Button asChild>
        <WorkspaceLink href={RESPARKABLE_ROUTES.INBOX}>Go to the inbox</WorkspaceLink>
      </Button>
    );

    await user.click(screen.getByRole('link', { name: 'Go to the inbox' }));

    expect(openTab).toHaveBeenCalledWith('inbox', {});
  });

  it('runs onNavigate before opening, so the dialog a link sits in can close itself', async () => {
    const user = userEvent.setup();
    const order: string[] = [];
    openTab.mockImplementation(() => order.push('openTab'));
    render(
      <WorkspaceLink
        href={RESPARKABLE_ROUTES.project('p1')}
        onNavigate={() => order.push('onNavigate')}
      >
        Q3 Roadmap
      </WorkspaceLink>
    );

    await user.click(screen.getByRole('link', { name: 'Q3 Roadmap' }));

    expect(order).toEqual(['onNavigate', 'openTab']);
  });
});

describe('falling back to ordinary navigation', () => {
  it('does not intercept when there is no workspace above it', async () => {
    const user = userEvent.setup();
    outsideWorkspace();
    render(<WorkspaceLink href={RESPARKABLE_ROUTES.project('p1')}>Q3 Roadmap</WorkspaceLink>);

    await user.click(screen.getByRole('link', { name: 'Q3 Roadmap' }));

    expect(openTab).not.toHaveBeenCalled();
  });

  it('does not intercept an href that belongs to no tab kind', async () => {
    const user = userEvent.setup();
    // `/resparkable/chat` is a redirect, not a tab. Real navigation is the
    // only thing that can resolve it.
    render(<WorkspaceLink href={RESPARKABLE_ROUTES.CHAT}>Ask Sparkey</WorkspaceLink>);

    await user.click(screen.getByRole('link', { name: 'Ask Sparkey' }));

    expect(openTab).not.toHaveBeenCalled();
  });

  it('does not intercept a destination outside Resparkable', async () => {
    const user = userEvent.setup();
    render(<WorkspaceLink href="/admin">Admin</WorkspaceLink>);

    await user.click(screen.getByRole('link', { name: 'Admin' }));

    expect(openTab).not.toHaveBeenCalled();
  });

  it('honours `external` even for an href that would otherwise resolve', async () => {
    const user = userEvent.setup();
    render(
      <WorkspaceLink href={RESPARKABLE_ROUTES.project('p1')} external>
        Q3 Roadmap
      </WorkspaceLink>
    );

    await user.click(screen.getByRole('link', { name: 'Q3 Roadmap' }));

    expect(openTab).not.toHaveBeenCalled();
  });
});
