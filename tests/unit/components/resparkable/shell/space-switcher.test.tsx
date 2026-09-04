// @vitest-environment happy-dom

/**
 * Unit Tests: the workspace switcher (phase 47).
 *
 * The control that makes a mis-targeted read possible, so the assertions are
 * about what a switch does to the URL rather than about how it looks:
 *
 *   1. **Switching is navigation**, to the same page with a different
 *      `?space=`. That is what makes a workspace a link, the back button work
 *      between workspaces, and two browser tabs able to hold two of them. None
 *      of those three had to be built, and all three break the moment this
 *      becomes a state change.
 *   2. **Every other search param survives.** Switching workspace while looking
 *      at Tuesday should still be looking at Tuesday.
 *   3. **Personal REMOVES the param** rather than setting it to the user id, so
 *      the URL is the one the product had before groups existed.
 *   4. **One workspace renders nothing.** A switcher with a single entry costs
 *      header space to say what the header already says.
 *
 * @see components/resparkable/shell/space-switcher.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

import { SpaceSwitcher } from '@/components/resparkable/shell/space-switcher';
import type { OpenableSpaceWire } from '@/lib/framework/resparkable/ui/payloads';

vi.mock('next/navigation', () => ({
  usePathname: vi.fn(),
  useRouter: vi.fn(),
  useSearchParams: vi.fn(),
}));

const push = vi.fn();

const PERSONAL: OpenableSpaceWire = {
  spaceId: 'user_a',
  name: 'Personal',
  kind: 'personal',
  role: 'owner',
  groupId: null,
};
const GROUP: OpenableSpaceWire = {
  spaceId: 'spc_group_1',
  name: 'Study Group B',
  kind: 'group',
  role: 'member',
  groupId: 'grp_1',
};
const OTHER_GROUP: OpenableSpaceWire = {
  spaceId: 'spc_group_2',
  name: 'Allotment',
  kind: 'group',
  role: 'admin',
  groupId: 'grp_2',
};

function at(pathname: string, search = ''): void {
  vi.mocked(usePathname).mockReturnValue(pathname);
  vi.mocked(useSearchParams).mockReturnValue(new URLSearchParams(search) as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useRouter).mockReturnValue({ push } as never);
  at('/resparkable');
});

describe('SpaceSwitcher', () => {
  it('renders nothing when there is only one workspace', () => {
    const { container } = render(<SpaceSwitcher spaces={[PERSONAL]} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the list could not be read', () => {
    // The layout degrades to `[]` rather than taking the shell down. The
    // workspace still resolves from the URL underneath a missing switcher.
    const { container } = render(<SpaceSwitcher spaces={[]} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('names the active workspace, and says so to a screen reader', () => {
    at('/resparkable', 'space=spc_group_1');

    render(<SpaceSwitcher spaces={[PERSONAL, GROUP]} />);

    expect(
      screen.getByRole('button', { name: /Workspace: Study Group B\. Switch workspace/ })
    ).toBeInTheDocument();
  });

  it('falls back to the first workspace when the URL names an unknown one', () => {
    // The page underneath is already 404ing here. A switcher that still names a
    // workspace is what the reader needs in order to get out of it.
    at('/resparkable', 'space=spc_deleted');

    render(<SpaceSwitcher spaces={[PERSONAL, GROUP]} />);

    expect(screen.getByRole('button', { name: /Workspace: Personal/ })).toBeInTheDocument();
  });

  it('switches by navigating to the same page with the new workspace', async () => {
    const user = userEvent.setup();
    render(<SpaceSwitcher spaces={[PERSONAL, GROUP]} />);

    await user.click(screen.getByRole('button', { name: /Switch workspace/ }));
    await user.click(screen.getByRole('menuitem', { name: /Study Group B/ }));

    expect(push).toHaveBeenCalledWith('/resparkable?space=spc_group_1');
  });

  it('keeps every other search param across a switch', async () => {
    const user = userEvent.setup();
    at('/resparkable/plan', 'day=2026-09-03');

    render(<SpaceSwitcher spaces={[PERSONAL, GROUP]} />);
    await user.click(screen.getByRole('button', { name: /Switch workspace/ }));
    await user.click(screen.getByRole('menuitem', { name: /Study Group B/ }));

    // Switching workspace while looking at Tuesday should still be looking at
    // Tuesday.
    expect(push).toHaveBeenCalledWith('/resparkable/plan?day=2026-09-03&space=spc_group_1');
  });

  it('removes the param entirely when switching back to personal', async () => {
    const user = userEvent.setup();
    at('/resparkable', 'space=spc_group_1');

    render(<SpaceSwitcher spaces={[PERSONAL, GROUP]} />);
    await user.click(screen.getByRole('button', { name: /Switch workspace/ }));
    await user.click(screen.getByRole('menuitem', { name: /Personal/ }));

    // Not `?space=user_a`. Personal has one spelling, and it is the URL the
    // product had before groups existed, so every old bookmark still resolves.
    expect(push).toHaveBeenCalledWith('/resparkable');
  });

  it('keeps other params when switching back to personal', async () => {
    const user = userEvent.setup();
    at('/resparkable/plan', 'day=2026-09-03&space=spc_group_1');

    render(<SpaceSwitcher spaces={[PERSONAL, GROUP]} />);
    await user.click(screen.getByRole('button', { name: /Switch workspace/ }));
    await user.click(screen.getByRole('menuitem', { name: /Personal/ }));

    expect(push).toHaveBeenCalledWith('/resparkable/plan?day=2026-09-03');
  });

  it('lists personal and groups in one menu, labelled by kind', async () => {
    const user = userEvent.setup();
    render(<SpaceSwitcher spaces={[PERSONAL, OTHER_GROUP, GROUP]} />);

    await user.click(screen.getByRole('button', { name: /Switch workspace/ }));

    // §24.2: one switcher, grouped and labelled. A member should not have to
    // know whose a workspace is in order to open it.
    expect(screen.getByText('Yours')).toBeInTheDocument();
    expect(screen.getByText('Groups')).toBeInTheDocument();
    expect(screen.getAllByRole('menuitem')).toHaveLength(3);
  });

  it('shows the role on a group workspace and not on a personal one', async () => {
    const user = userEvent.setup();
    render(<SpaceSwitcher spaces={[PERSONAL, GROUP]} />);

    await user.click(screen.getByRole('button', { name: /Switch workspace/ }));

    expect(screen.getByRole('menuitem', { name: /Study Group B member/ })).toBeInTheDocument();
    // A personal workspace is always `owner`; a label saying so is noise.
    expect(screen.getByRole('menuitem', { name: /^Personal$/ })).toBeInTheDocument();
  });
});
