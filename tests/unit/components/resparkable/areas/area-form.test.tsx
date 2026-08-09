/**
 * AreaForm Component Tests
 *
 * An Area is deliberately not an optimisation construct: there is no weekly
 * hour target, and nothing about an Area feeds the priority scorer
 * (`.context/framework/resparkable/design-principles.md`). The form's only
 * job is `name`, `description` (the "why this matters" field, with a
 * `<FieldHelp>` popover) and `colour`.
 *
 * Test Coverage:
 * - Renders in create mode with empty defaults (no colour)
 * - Renders in edit mode seeded from the record (name, colour)
 * - `form.reset(defaults)` runs when the dialog reopens on a different area
 * - A blank name is rejected before any request is made
 * - The exact submit body: description/colour trimmed to `null` when empty
 * - Description and colour are trimmed when both are provided
 * - PATCH is used, with the id, on an edit submit
 *
 * @see components/resparkable/areas/area-form.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRouter } from 'next/navigation';

import { AreaForm } from '@/components/resparkable/areas/area-form';
import type { AreaWire } from '@/lib/framework/resparkable/ui/payloads';

vi.mock('@/lib/api/client', () => ({
  apiClient: { post: vi.fn(), patch: vi.fn() },
  APIClientError: class APIClientError extends Error {},
}));

import { apiClient } from '@/lib/api/client';

const mockedPost = apiClient.post as ReturnType<typeof vi.fn>;
const mockedPatch = apiClient.patch as ReturnType<typeof vi.fn>;
const mockedRouter = useRouter as unknown as ReturnType<typeof vi.fn>;
const refresh = vi.fn();

function area(overrides: Partial<AreaWire> = {}): AreaWire {
  return {
    id: 'area_1',
    name: 'Health',
    slug: 'health',
    description: 'Fitness, sleep, medical.',
    colour: '#0d9488',
    sortOrder: 0,
    archivedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedPost.mockResolvedValue({});
  mockedPatch.mockResolvedValue({});
  mockedRouter.mockReturnValue({
    push: vi.fn(),
    replace: vi.fn(),
    refresh,
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  });
});

function postedBody(): Record<string, unknown> {
  return mockedPost.mock.calls[0]?.[1]?.body as Record<string, unknown>;
}

describe('AreaForm', () => {
  it('renders in create mode with empty defaults', () => {
    render(<AreaForm open onOpenChange={vi.fn()} />);

    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('');
    expect(screen.getByRole('textbox', { name: /^colour/i })).toHaveValue('');
  });

  it("renders in edit mode seeded from the record's name and colour", () => {
    render(<AreaForm open onOpenChange={vi.fn()} area={area()} />);

    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Health');
    expect(screen.getByRole('textbox', { name: /^colour/i })).toHaveValue('#0d9488');
  });

  it('resets to the newly-opened area rather than keeping the previous one', () => {
    const areaA = area({ id: 'area_a', name: 'Area A' });
    const areaB = area({ id: 'area_b', name: 'Area B' });

    const { rerender } = render(<AreaForm open onOpenChange={vi.fn()} area={areaA} />);
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Area A');

    rerender(<AreaForm open={false} onOpenChange={vi.fn()} area={areaB} />);
    rerender(<AreaForm open onOpenChange={vi.fn()} area={areaB} />);

    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Area B');
  });

  it('rejects a blank name before any request is made', async () => {
    const user = userEvent.setup();
    render(<AreaForm open onOpenChange={vi.fn()} />);

    await user.click(screen.getByRole('textbox', { name: 'Name' }));
    await user.click(screen.getByRole('button', { name: /^create$/i }));

    await waitFor(() => expect(screen.getByText('Give it a name')).toBeInTheDocument());
    expect(mockedPost).not.toHaveBeenCalled();
  });

  it('sends the exact body, with blank description/colour as null', async () => {
    const user = userEvent.setup();
    render(<AreaForm open onOpenChange={vi.fn()} />);

    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Family');
    await user.click(screen.getByRole('button', { name: /^create$/i }));

    await waitFor(() => expect(mockedPost).toHaveBeenCalled());
    expect(mockedPost).toHaveBeenCalledWith('/api/v1/resparkable/areas', {
      body: {
        name: 'Family',
        description: null,
        colour: null,
      },
    });
  });

  it('trims description and colour when both are provided', async () => {
    const user = userEvent.setup();
    render(<AreaForm open onOpenChange={vi.fn()} />);

    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Career');
    await user.type(
      screen.getByRole('textbox', { name: /why this matters right now/i }),
      '  Work and side projects  '
    );
    await user.type(screen.getByRole('textbox', { name: /^colour/i }), '  #ff6600  ');
    await user.click(screen.getByRole('button', { name: /^create$/i }));

    await waitFor(() => expect(mockedPost).toHaveBeenCalled());
    const body = postedBody();
    expect(body.description).toBe('Work and side projects');
    expect(body.colour).toBe('#ff6600');
  });

  it('PATCHes the area id on an edit submit', async () => {
    const user = userEvent.setup();
    render(<AreaForm open onOpenChange={vi.fn()} area={area()} />);

    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() =>
      expect(mockedPatch).toHaveBeenCalledWith(
        '/api/v1/resparkable/areas/area_1',
        expect.objectContaining({ body: expect.objectContaining({ name: 'Health' }) })
      )
    );
  });
});
