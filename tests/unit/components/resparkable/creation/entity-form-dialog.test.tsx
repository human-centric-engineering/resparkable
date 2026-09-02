// @vitest-environment happy-dom

/**
 * EntityFormDialog Component Tests
 *
 * This component is a switch, so the tests are about which way it switches and
 * what that costs. Three branches, and each one is a decision recorded in the
 * source header rather than an implementation detail:
 *
 * **Create routes to `CreateDialog`.** Unchanged, and asserted here so the edit
 * work below cannot quietly break it — the three form components
 * (`ProjectForm`/`GoalForm`/`AreaForm`) all reach `CreateDialog` through this
 * file and nothing else covers the fork itself.
 *
 * **Edit now offers chat as well as a form.** It used to route to a plain
 * `ResourceDialog` on the grounds that "Tell me more" already covered chat.
 * That reasoning was wrong: `ContextChatDrawer` is bound to the *context*
 * agent, which holds capture only and cannot write a field. The edit half is
 * bound to `resparkable-companion`, which holds `resparkable_upsert_*`. The
 * test asserts the toggle is there, because its absence is exactly what the
 * old behaviour looked like and nothing else would fail.
 *
 * **`time-block` stays form-only.** `ResparkableChat`'s `entityContext` has no
 * shape for one, so a chat pane could not refer to what you were editing. This
 * is the branch a future "make it consistent" edit would most plausibly remove,
 * so it is pinned.
 *
 * The last test covers the seam rather than the switch: closing the dialog has
 * to announce what changed, because there is no way to know client-side that an
 * edit landed via chat (the stream reports which tool ran, not its result). It
 * asserts through the real `DataChangeProvider` and a real `TabRefreshBoundary`
 * — a mocked notify would pass whether or not the two agree on the key format.
 *
 * @see components/resparkable/creation/entity-form-dialog.tsx
 * @see components/resparkable/sparkey/entity-editor-panel.tsx
 */

import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useForm } from 'react-hook-form';

import { EntityFormDialog } from '@/components/resparkable/creation/entity-form-dialog';
import type { CreatableEntityType } from '@/components/resparkable/creation/create-dialog';
import { DataChangeProvider } from '@/components/resparkable/workspace/data-change-context';
import {
  TabRefreshBoundary,
  useTabRefreshGeneration,
} from '@/components/resparkable/workspace/tabs/tab-refresh-context';
import type { TabState } from '@/lib/framework/resparkable/ui/workspace/tab-registry';

vi.mock('next/navigation', () => ({ useRouter: vi.fn() }));

vi.mock('@/lib/api/client', () => ({
  apiClient: { post: vi.fn(), patch: vi.fn() },
  APIClientError: class APIClientError extends Error {},
}));

// The chat half streams over SSE and owns a composer. Neither is what this
// file is about, and mounting the real one would make every case here depend on
// the chat transport staying green.
vi.mock('@/components/resparkable/chat/resparkable-chat', () => ({
  ResparkableChat: ({ placeholder }: { placeholder?: string }) => (
    <div data-testid="chat-half">{placeholder}</div>
  ),
}));

import { useRouter } from 'next/navigation';
import { createMockRouter } from '@/tests/types/mocks';

interface Values extends Record<string, string> {
  name: string;
}

/** Supplies the `useForm` instance the real form components pass down. */
function Harness({
  entityType = 'project',
  existingId,
  onOpenChange = () => {},
}: {
  entityType?: CreatableEntityType;
  existingId?: string;
  onOpenChange?: (open: boolean) => void;
}) {
  const form = useForm<Values>({ defaultValues: { name: 'Q3 Roadmap' } });
  return (
    <EntityFormDialog
      open
      onOpenChange={onOpenChange}
      entityType={entityType}
      collection="/api/v1/resparkable/projects"
      {...(existingId ? { existingId } : {})}
      editTitle="Edit project"
      editDescription="A body of work with tasks under it."
      form={form}
      toBody={(values) => ({ name: values.name })}
    >
      <input aria-label="Name" {...form.register('name')} />
    </EntityFormDialog>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  vi.mocked(useRouter).mockReturnValue(createMockRouter());
});

describe('create', () => {
  it('routes to the create dialog, not the edit panel', () => {
    localStorage.setItem('resparkable.create-mode.v1', JSON.stringify('form'));
    render(<Harness />);

    expect(screen.getByRole('heading', { name: 'New project' })).toBeInTheDocument();
  });
});

describe('edit', () => {
  it('offers the chat/form toggle, which the old form-only branch did not', () => {
    render(<Harness existingId="p1" />);

    expect(screen.getByRole('heading', { name: 'Edit project' })).toBeInTheDocument();
    expect(screen.getByRole('radiogroup')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'chat' })).toBeInTheDocument();
  });

  it('starts on the form, so the default edit gesture is unchanged', () => {
    render(<Harness existingId="p1" />);

    // `resparkable.edit-mode.v1` defaults to 'form', deliberately independent of
    // the create-mode preference: wanting chat for a new thing says nothing
    // about wanting it for an existing one.
    expect(screen.getByRole('radio', { name: 'form' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByLabelText('Name')).toHaveValue('Q3 Roadmap');
  });

  it('slides to the chat half, addressed to the record being edited', async () => {
    const user = userEvent.setup();
    render(<Harness existingId="p1" />);

    await user.click(screen.getByRole('radio', { name: 'chat' }));

    expect(screen.getByRole('radio', { name: 'chat' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('chat-half')).toHaveTextContent('this project');
  });

  it('keeps a time block form-only, since chat has no context shape for one', () => {
    render(<Harness entityType="time-block" existingId="tb1" />);

    expect(screen.getByRole('heading', { name: 'Edit project' })).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
    expect(screen.queryByTestId('chat-half')).not.toBeInTheDocument();
  });
});

describe('closing announces what changed', () => {
  const projectsTab: TabState = {
    id: 'tab-1',
    kind: 'projects',
    params: {},
    source: 'launcher',
  };
  // Documents, not Inbox. Inbox looks like the obvious "unrelated" tab and is
  // not one: it fetches projects too, for the promote dialog's picker, so
  // `change-scope.ts` has it subscribed to `project` on purpose.
  const documentsTab: TabState = {
    id: 'tab-2',
    kind: 'documents',
    params: {},
    source: 'launcher',
  };

  function Probe({ label }: { label: string }) {
    return <span data-testid={label}>{useTabRefreshGeneration()}</span>;
  }

  it('reaches a Projects tab in another pane, and leaves a Documents tab alone', async () => {
    const user = userEvent.setup();
    function Scene() {
      const [open, setOpen] = React.useState(true);
      const form = useForm<Values>({ defaultValues: { name: 'Q3 Roadmap' } });
      return (
        <DataChangeProvider>
          <EntityFormDialog
            open={open}
            onOpenChange={setOpen}
            entityType="project"
            collection="/api/v1/resparkable/projects"
            existingId="p1"
            editTitle="Edit project"
            form={form}
            toBody={(values) => ({ name: values.name })}
          >
            <input aria-label="Name" {...form.register('name')} />
          </EntityFormDialog>
          <TabRefreshBoundary tab={projectsTab}>
            <Probe label="projects" />
          </TabRefreshBoundary>
          <TabRefreshBoundary tab={documentsTab}>
            <Probe label="documents" />
          </TabRefreshBoundary>
        </DataChangeProvider>
      );
    }
    render(<Scene />);

    // Escape is a real close path and, unlike a save, one Radix owns — which is
    // the case the shared `handleOpenChange` exists for.
    await user.keyboard('{Escape}');

    expect(screen.getByTestId('projects')).toHaveTextContent('1');
    expect(screen.getByTestId('documents')).toHaveTextContent('0');
  });
});
