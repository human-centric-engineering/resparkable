// @vitest-environment happy-dom

/**
 * ResourceDialog Component Tests
 *
 * The shell the four resource forms (projects, goals, areas, entities) share.
 * Its one real branch is `id ? PATCH : POST` — presence of an id is the only
 * signal distinguishing an edit from a create — and its one safety property is
 * that a failed submit surfaces the API's own message via `FormError` without
 * closing the dialog or refreshing, so the user's input survives the retry.
 *
 * A minimal caller-owned `useForm` stands in for a real resource form, per the
 * header note: the shell never builds the form itself.
 *
 * Test Coverage:
 * - No id → POSTs to the collection with the caller's toBody() output
 * - An id → PATCHes the item path, not the collection
 * - Success closes the dialog (onOpenChange(false)) and refreshes the router
 * - Failure shows the API's message via FormError, and does NOT close or refresh
 * - The submit button is disabled while the request is in flight
 * - submitLabel defaults to "Create" / "Save changes" based on id, and a custom
 *   submitLabel overrides both
 * - rev (phase 58): sent in the PATCH body when given; a 409 shows
 *   EDIT_CONFLICT_MESSAGE, broadcasts the conflicting record as changed, and
 *   keeps the user's typed value instead of closing the dialog; a non-409
 *   error still shows its own message rather than the conflict copy
 *
 * @see components/resparkable/ui/resource-dialog.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useForm } from 'react-hook-form';
import { useRouter } from 'next/navigation';

import { EDIT_CONFLICT_MESSAGE, ResourceDialog } from '@/components/resparkable/ui/resource-dialog';
import {
  DataChangeProvider,
  useDataRevision,
} from '@/components/resparkable/workspace/data-change-context';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import { keysForChange } from '@/lib/framework/resparkable/ui/workspace/change-scope';
import { createMockRouter } from '@/tests/types/mocks';

vi.mock('@/lib/api/client', () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  APIClientError: class APIClientError extends Error {},
}));

import { apiClient, APIClientError } from '@/lib/api/client';

const mockPost = vi.mocked(apiClient.post);
const mockPatch = vi.mocked(apiClient.patch);
const mockRefresh = vi.fn();

interface Values {
  name: string;
}

function Harness({
  id,
  rev,
  onOpenChange,
  submitLabel,
}: {
  id?: string;
  rev?: number;
  onOpenChange: (open: boolean) => void;
  submitLabel?: string;
}) {
  const form = useForm<Values>({ defaultValues: { name: 'Q4 launch' } });

  return (
    <ResourceDialog
      open
      onOpenChange={onOpenChange}
      collection={RESPARKABLE_API.PROJECTS}
      id={id}
      rev={rev}
      title={id ? 'Edit project' : 'New project'}
      form={form}
      toBody={(values) => ({ name: values.name })}
      submitLabel={submitLabel}
    >
      <input aria-label="Name" {...form.register('name')} />
    </ResourceDialog>
  );
}

/** Surfaces a change-scope revision count so a test can observe a broadcast
 * without reaching into the refresh plumbing itself. */
function RevisionProbe({ watchKeys }: { watchKeys: string[] }) {
  const revision = useDataRevision(watchKeys);
  return <div data-testid="revision">{revision}</div>;
}

describe('ResourceDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPost.mockResolvedValue({ id: 'new_1' });
    mockPatch.mockResolvedValue({ id: 'proj_1' });
    vi.mocked(useRouter).mockReturnValue(createMockRouter({ refresh: mockRefresh }));
  });

  it('POSTs to the collection when there is no id (create)', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(<Harness onOpenChange={onOpenChange} />);

    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(mockPost).toHaveBeenCalledWith(RESPARKABLE_API.PROJECTS, {
        body: { name: 'Q4 launch' },
      });
    });
    expect(mockPatch).not.toHaveBeenCalled();
  });

  it('PATCHes the item path when an id is present (edit)', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(<Harness id="proj_1" onOpenChange={onOpenChange} />);

    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => {
      expect(mockPatch).toHaveBeenCalledWith(
        RESPARKABLE_API.itemPath(RESPARKABLE_API.PROJECTS, 'proj_1'),
        {
          body: { name: 'Q4 launch' },
        }
      );
    });
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('closes the dialog and refreshes the router on a successful submit', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(<Harness onOpenChange={onOpenChange} />);

    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it('shows the API error and does NOT close or refresh when the submit fails', async () => {
    mockPost.mockRejectedValueOnce(
      Object.assign(new Error('That name is already in use.'), { name: 'APIClientError' })
    );
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(<Harness onOpenChange={onOpenChange} />);

    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(screen.getByText('That name is already in use.')).toBeInTheDocument();
    });
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('disables the submit button while the request is in flight', async () => {
    let resolveSubmit!: (value: { id: string }) => void;
    mockPost.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSubmit = resolve;
      })
    );
    const user = userEvent.setup();
    render(<Harness onOpenChange={vi.fn()} />);

    const button = screen.getByRole('button', { name: 'Create' });
    await user.click(button);

    await waitFor(() => {
      expect(button).toBeDisabled();
    });

    resolveSubmit({ id: 'new_1' });
    await waitFor(() => {
      expect(button).not.toBeDisabled();
    });
  });

  it('uses a custom submitLabel over the id-derived default', async () => {
    render(<Harness id="proj_1" onOpenChange={vi.fn()} submitLabel="Save & close" />);

    expect(screen.getByRole('button', { name: 'Save & close' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument();
  });
});

describe('ResourceDialog: rev (optimistic concurrency, phase 58)', () => {
  const projectChangeKeys = keysForChange({ type: 'project', id: 'proj_1' });

  beforeEach(() => {
    vi.clearAllMocks();
    mockPost.mockResolvedValue({ id: 'new_1' });
    mockPatch.mockResolvedValue({ id: 'proj_1' });
    vi.mocked(useRouter).mockReturnValue(createMockRouter({ refresh: mockRefresh }));
  });

  it('includes rev in the PATCH body when the caller supplies one', async () => {
    const user = userEvent.setup();
    render(<Harness id="proj_1" rev={5} onOpenChange={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => {
      expect(mockPatch).toHaveBeenCalledWith(
        RESPARKABLE_API.itemPath(RESPARKABLE_API.PROJECTS, 'proj_1'),
        { body: { name: 'Q4 launch', rev: 5 } }
      );
    });
  });

  it('on a 409 shows EDIT_CONFLICT_MESSAGE, broadcasts the record as changed, keeps the typed value, and does not save', async () => {
    const conflict = Object.assign(new APIClientError('ignored by the handler'), { status: 409 });
    mockPatch.mockRejectedValueOnce(conflict);
    const user = userEvent.setup();
    const onOpenChange = vi.fn();

    render(
      <DataChangeProvider>
        <Harness id="proj_1" rev={5} onOpenChange={onOpenChange} />
        <RevisionProbe watchKeys={projectChangeKeys} />
      </DataChangeProvider>
    );

    // The user's own edit, still in the box when the conflict lands.
    const input = screen.getByLabelText('Name');
    await user.clear(input);
    await user.type(input, 'My own retitle');

    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    // Shows the fixed conflict copy rather than the server's own message.
    await waitFor(() => {
      expect(screen.getByText(EDIT_CONFLICT_MESSAGE)).toBeInTheDocument();
    });
    expect(screen.queryByText('ignored by the handler')).not.toBeInTheDocument();

    // Broadcasts the project as changed, so a detail tab showing proj_1
    // (and the projects list) know to refetch.
    expect(screen.getByTestId('revision')).toHaveTextContent('2');

    // The dialog stays open with what the user typed, not reset or closed.
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(input).toHaveValue('My own retitle');
  });

  it('shows its own message, not the conflict copy, for a non-409 error', async () => {
    const validationError = Object.assign(new APIClientError('That name is too long.'), {
      status: 400,
    });
    mockPatch.mockRejectedValueOnce(validationError);
    const user = userEvent.setup();
    const onOpenChange = vi.fn();

    render(<Harness id="proj_1" rev={5} onOpenChange={onOpenChange} />);

    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => {
      expect(screen.getByText('That name is too long.')).toBeInTheDocument();
    });
    expect(screen.queryByText(EDIT_CONFLICT_MESSAGE)).not.toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});
