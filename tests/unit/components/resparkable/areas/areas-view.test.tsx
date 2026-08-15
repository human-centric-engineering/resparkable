/**
 * AreasView Component Tests
 *
 * "Life": the standing parts of someone's life, and what's on their mind
 * about each one right now. No targets, no capacity, no balancing:
 * Resparkable is a reflection and understanding tool, not an optimisation
 * one (`.context/framework/resparkable/design-principles.md`).
 *
 * Test Coverage:
 * - The summary line counts areas (singular/plural) or says the space is empty
 * - Archived areas are badged
 * - The empty state explains what areas are for
 * - Create dialog opens from the header button and from the empty state's action
 * - Edit dialog opens pre-filled with the clicked area, then closes on escape
 * - The colour swatch and description render when an area has them
 *
 * @see components/resparkable/areas/areas-view.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { AreasView } from '@/components/resparkable/areas/areas-view';
import type { AreaWire } from '@/lib/framework/resparkable/ui/payloads';

vi.mock('@/lib/api/client', () => ({
  apiClient: { post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  APIClientError: class APIClientError extends Error {},
}));

beforeEach(() => {
  // The create dialog's chat/form toggle (create-mode-toggle.tsx) defaults to
  // chat; these tests are about the form, so pin the stored preference.
  localStorage.setItem('resparkable.create-mode.v1', JSON.stringify('form'));
});

function area(overrides: Partial<AreaWire> = {}): AreaWire {
  return {
    id: 'area_1',
    name: 'Health',
    slug: 'health',
    description: null,
    colour: null,
    sortOrder: 0,
    archivedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('AreasView', () => {
  it('counts a single area in the singular', () => {
    render(<AreasView areas={[area()]} />);

    expect(screen.getByText('1 part of your life')).toBeInTheDocument();
  });

  it('counts multiple areas in the plural', () => {
    render(<AreasView areas={[area({ id: 'a' }), area({ id: 'b' })]} />);

    expect(screen.getByText('2 parts of your life')).toBeInTheDocument();
  });

  it('says the space is empty when there are no areas', () => {
    render(<AreasView areas={[]} />);

    expect(screen.getByText("Nothing here yet, and that's fine")).toBeInTheDocument();
  });

  it('badges an archived area', () => {
    render(<AreasView areas={[area({ archivedAt: '2026-01-01T00:00:00.000Z' })]} />);

    expect(screen.getByText('archived')).toBeInTheDocument();
  });

  it('explains what areas are for when there are none', () => {
    render(<AreasView areas={[]} />);

    expect(screen.getByText("What's going on in your life right now?")).toBeInTheDocument();
    expect(screen.getByText(/Sparkey uses this to understand your life/i)).toBeInTheDocument();
  });

  it('opens the create dialog from the header "Add what matters" button', async () => {
    const user = userEvent.setup();
    render(<AreasView areas={[area()]} />);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /add what matters/i }));

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'New life area' })).toBeInTheDocument();
    // A create form, not an edit — the name field starts blank.
    expect(within(dialog).getByLabelText('Name')).toHaveValue('');
  });

  it('opens the create dialog from the empty state\'s "Add the first" button', async () => {
    const user = userEvent.setup();
    render(<AreasView areas={[]} />);

    await user.click(screen.getByRole('button', { name: 'Add the first' }));

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'New life area' })).toBeInTheDocument();
  });

  it('opens the edit dialog pre-filled with the clicked area, then closes on escape', async () => {
    const user = userEvent.setup();
    render(<AreasView areas={[area({ name: 'Career' })]} />);

    await user.click(screen.getByRole('button', { name: 'Edit Career' }));

    const dialog = screen.getByRole('dialog');
    expect(
      within(dialog).getByRole('heading', { name: 'Edit this part of your life' })
    ).toBeInTheDocument();
    // Pre-filled from the clicked area, not blank — proves `editing` carries the row through.
    expect(within(dialog).getByLabelText('Name')).toHaveValue('Career');

    await user.keyboard('{Escape}');

    // The wrapped onOpenChange resets `editing` to null rather than leaving stale state.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('renders the colour swatch and description when an area has them', () => {
    render(
      <AreasView areas={[area({ colour: '#0d9488', description: 'Anything client-facing.' })]} />
    );

    expect(screen.getByText('Anything client-facing.')).toBeInTheDocument();
    const swatch = document.querySelector('span[aria-hidden="true"].rounded-full');
    expect(swatch).toHaveStyle({ backgroundColor: '#0d9488' });
  });
});
