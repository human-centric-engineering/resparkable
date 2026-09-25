// @vitest-environment happy-dom

/**
 * GroupBudget Component Tests (§23.12, phase 50).
 *
 * `budget.admin` is `null` for anybody who is not an admin, so the assertions
 * that matter are about what a member's browser never receives at all, not
 * about a role check hiding a rendered element:
 *
 *   1. **A member sees the balance and nothing about anyone else.** No
 *      per-person table, no admin-only alert controls.
 *   2. **An admin sees the table and the funding-mode control.**
 *   3. **A top-up posts the typed amount and reflects the server's balance
 *      back**, not an optimistic guess.
 *   4. **A member who cannot top up in a self-funded group is told who can**,
 *      rather than being shown a form that would 403.
 *
 * @see components/resparkable/groups/group-budget.tsx
 */

import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/lib/api/client', () => ({
  apiClient: { post: vi.fn(), get: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  APIClientError: class extends Error {},
}));

// Radix `Select` renders its dropdown through a portal happy-dom does not
// support, so the funding-mode control is mocked to a native `<select>`: the
// same approach `share-dialog.test.tsx` takes. The goal is to prove this panel
// wires `onValueChange` to the right PATCH, not to re-test Radix.
vi.mock('@/components/ui/select', () => {
  function SelectTrigger({ children }: { id?: string; children: React.ReactNode }) {
    return <>{children}</>;
  }

  function Select({
    value,
    onValueChange,
    children,
  }: {
    value: string;
    onValueChange: (value: string) => void;
    children: React.ReactNode;
  }) {
    const trigger = React.Children.toArray(children).find(
      (child): child is React.ReactElement<{ id?: string }> =>
        React.isValidElement(child) && child.type === SelectTrigger
    );
    return (
      <select
        id={trigger?.props.id}
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
      >
        {children}
      </select>
    );
  }

  return {
    Select,
    SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
      <option value={value}>{children}</option>
    ),
    SelectTrigger,
    SelectValue: () => null,
  };
});

import { GroupBudget } from '@/components/resparkable/groups/group-budget';
import { apiClient } from '@/lib/api/client';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import type { GroupBudgetWire } from '@/lib/framework/resparkable/ui/payloads';

const MEMBER_BUDGET: GroupBudgetWire = {
  balanceCredits: 40,
  fundingMode: 'member_contributions',
  canTopUp: true,
  yourPersonalBalanceCredits: 15,
  you: { dailyCreditCap: null, spentLastDayCredits: 0 },
  admin: null,
};

const ADMIN_BUDGET: GroupBudgetWire = {
  balanceCredits: 100,
  fundingMode: 'self_funded',
  canTopUp: true,
  yourPersonalBalanceCredits: 50,
  you: { dailyCreditCap: null, spentLastDayCredits: 0 },
  admin: {
    lowBalanceAlertCredits: null,
    largeRunAlertPercent: null,
    windowDays: 30,
    members: [
      {
        userId: 'user_a',
        role: 'admin',
        dailyCreditCap: null,
        spentCredits: 5,
        contributedCredits: 0,
      },
      {
        userId: 'user_b',
        role: 'member',
        dailyCreditCap: 10,
        spentCredits: 2,
        contributedCredits: 20,
      },
    ],
  },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GroupBudget', () => {
  it('shows a member the balance, and nothing about anyone else', () => {
    render(
      <GroupBudget yourRole="member" groupId="grp_1" budget={MEMBER_BUDGET} viewerUserId="user_b" />
    );

    expect(screen.getByText('40')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByText('Only admins see this part.')).not.toBeInTheDocument();
  });

  it('shows an admin the per-person table and the funding-mode control', () => {
    render(
      <GroupBudget yourRole="member" groupId="grp_1" budget={ADMIN_BUDGET} viewerUserId="user_c" />
    );

    expect(screen.getByText('Only admins see this part.')).toBeInTheDocument();
    expect(screen.getByRole('combobox')).toBeInTheDocument();

    const table = screen.getByRole('table');
    // Both members appear, spend and contributions read from the row, not
    // recomputed by the component.
    expect(table).toHaveTextContent('user_a');
    expect(table).toHaveTextContent('user_b');
    expect(table).toHaveTextContent('5');
    expect(table).toHaveTextContent('20');
  });

  it('posts the typed amount and shows the balance the server returned', async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.post).mockResolvedValue({ balanceCredits: 65 });

    render(
      <GroupBudget yourRole="member" groupId="grp_1" budget={MEMBER_BUDGET} viewerUserId="user_b" />
    );
    // `getByLabelText` also matches the FieldHelp info button nested inside the
    // same `<label>`, so the amount field is the one number input on this view.
    await user.type(screen.getByRole('spinbutton'), '10');
    await user.click(screen.getByRole('button', { name: 'Add' }));

    expect(apiClient.post).toHaveBeenCalledWith(RESPARKABLE_API.groupTopUp('grp_1'), {
      body: { credits: 10 },
    });
    // Reflects what the server reported, not `balanceCredits + credits` guessed
    // client-side.
    expect(await screen.findByText('65')).toBeInTheDocument();
  });

  it('tells a member in a self-funded group that admins add the credits', () => {
    const cannotTopUp: GroupBudgetWire = {
      ...MEMBER_BUDGET,
      fundingMode: 'self_funded',
      canTopUp: false,
    };

    render(
      <GroupBudget yourRole="member" groupId="grp_1" budget={cannotTopUp} viewerUserId="user_b" />
    );

    expect(screen.getByText('In this group, admins add the credits.')).toBeInTheDocument();
    expect(screen.queryByLabelText(/Add credits from your own balance/)).not.toBeInTheDocument();
  });

  it('tells a viewer in a member-contributions group they cannot add or spend credits', () => {
    const viewerCannotTopUp: GroupBudgetWire = {
      ...MEMBER_BUDGET,
      fundingMode: 'member_contributions',
      canTopUp: false,
    };

    render(
      <GroupBudget
        yourRole="viewer"
        groupId="grp_1"
        budget={viewerCannotTopUp}
        viewerUserId="user_v"
      />
    );

    expect(screen.getByText('Viewers do not add or spend credits.')).toBeInTheDocument();
  });

  it('tells a viewer the same in a self-funded group, not that admins add credits', () => {
    // Third review pass: the message used to follow the funding mode only, so a
    // viewer was told to ask an admin for something they could never do.
    render(
      <GroupBudget
        yourRole="viewer"
        groupId="grp_1"
        budget={{ ...MEMBER_BUDGET, fundingMode: 'self_funded', canTopUp: false }}
        viewerUserId="user_v"
      />
    );

    expect(screen.getByText('Viewers do not add or spend credits.')).toBeInTheDocument();
    expect(screen.queryByText('In this group, admins add the credits.')).toBeNull();
  });

  it('does nothing when the typed top-up amount is not a usable number', async () => {
    const user = userEvent.setup();

    render(
      <GroupBudget yourRole="member" groupId="grp_1" budget={MEMBER_BUDGET} viewerUserId="user_b" />
    );
    await user.type(screen.getByRole('spinbutton'), '-5');
    await user.click(screen.getByRole('button', { name: 'Add' }));

    expect(apiClient.post).not.toHaveBeenCalled();
  });

  it('keeps the balance shown when the top-up request fails', async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.post).mockRejectedValue(new Error('server exploded'));

    render(
      <GroupBudget yourRole="member" groupId="grp_1" budget={MEMBER_BUDGET} viewerUserId="user_b" />
    );
    await user.type(screen.getByRole('spinbutton'), '10');
    await user.click(screen.getByRole('button', { name: 'Add' }));

    // The balance is still what it was: no optimistic credit, no server figure
    // to replace it with.
    expect(await screen.findByText('server exploded')).toBeInTheDocument();
    expect(screen.getByText('40')).toBeInTheDocument();
  });

  it('shows a member their own daily limit sentence when one is set', () => {
    const capped: GroupBudgetWire = {
      ...MEMBER_BUDGET,
      you: { dailyCreditCap: 20, spentLastDayCredits: 7 },
    };

    render(<GroupBudget yourRole="member" groupId="grp_1" budget={capped} viewerUserId="user_b" />);

    expect(
      screen.getByText(/You can use up to 20 credits here in any 24 hours\. You have used 7\./)
    ).toBeInTheDocument();
  });
});

describe('GroupBudget admin controls', () => {
  it('labels the viewer’s own row "You" and everyone else by id', () => {
    render(
      <GroupBudget yourRole="member" groupId="grp_1" budget={ADMIN_BUDGET} viewerUserId="user_a" />
    );

    const table = screen.getByRole('table');
    expect(table).toHaveTextContent('You');
    expect(table).toHaveTextContent('user_b');
    expect(table).not.toHaveTextContent('user_a');
  });

  it('shows a viewer row as plain text, not an editable cap input', () => {
    const withViewer: GroupBudgetWire = {
      ...ADMIN_BUDGET,
      admin: {
        ...ADMIN_BUDGET.admin!,
        members: [
          ...ADMIN_BUDGET.admin!.members,
          {
            userId: 'user_viewer',
            role: 'viewer',
            dailyCreditCap: null,
            spentCredits: 0,
            contributedCredits: 0,
          },
        ],
      },
    };

    render(
      <GroupBudget yourRole="member" groupId="grp_1" budget={withViewer} viewerUserId="user_a" />
    );

    expect(screen.getByText('Viewer')).toBeInTheDocument();
    expect(screen.queryByLabelText(`Daily limit for user_viewer`)).not.toBeInTheDocument();
    // Both non-viewer members still get an editable input.
    expect(screen.getByLabelText('Daily limit for you')).toBeInTheDocument();
    expect(screen.getByLabelText('Daily limit for user_b')).toBeInTheDocument();
  });

  it('patches the funding mode when an admin changes it, by group and mode', async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.patch).mockResolvedValue(undefined);

    render(
      <GroupBudget yourRole="member" groupId="grp_1" budget={ADMIN_BUDGET} viewerUserId="user_a" />
    );
    await user.selectOptions(screen.getByRole('combobox'), 'member_contributions');

    expect(apiClient.patch).toHaveBeenCalledWith(RESPARKABLE_API.groupBudget('grp_1'), {
      body: { fundingMode: 'member_contributions' },
    });
  });

  it('rolls the funding mode back to what it was when the PATCH fails', async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.patch).mockRejectedValue(new Error('nope'));

    render(
      <GroupBudget yourRole="member" groupId="grp_1" budget={ADMIN_BUDGET} viewerUserId="user_a" />
    );
    const select = screen.getByRole<HTMLSelectElement>('combobox');
    await user.selectOptions(select, 'member_contributions');

    await screen.findByText('nope');
    expect(select.value).toBe('self_funded');
  });

  it('saves the alert thresholds, sending null for a blank field', async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.patch).mockResolvedValue(undefined);

    render(
      <GroupBudget yourRole="member" groupId="grp_1" budget={ADMIN_BUDGET} viewerUserId="user_a" />
    );
    await user.type(
      screen.getByRole('spinbutton', { name: /Email me when the balance falls to/ }),
      '50'
    );
    // Large-run field is left blank on purpose.
    await user.click(screen.getByRole('button', { name: 'Save alerts' }));

    expect(apiClient.patch).toHaveBeenCalledWith(RESPARKABLE_API.groupBudget('grp_1'), {
      body: { lowBalanceAlertCredits: 50, largeRunAlertPercent: null },
    });
  });

  it('sends nothing when an alert field is not a usable number, and says why', async () => {
    const user = userEvent.setup();

    render(
      <GroupBudget yourRole="member" groupId="grp_1" budget={ADMIN_BUDGET} viewerUserId="user_a" />
    );
    const input = screen.getByRole('spinbutton', { name: /or one run uses more than/ });
    await user.type(input, '-3');
    // A click on the submit button never reaches React's onSubmit here: the
    // input's own `min={1}` makes -3 fail the browser's native constraint
    // validation first, which happy-dom enforces the same way a real browser
    // does. Dispatching `submit` directly is what exercises this component's
    // own check, the one the low-level `min`/`max` attributes cannot express
    // (a blank box, which is "off" and has no numeric value to violate).
    fireEvent.submit(input.closest('form') as HTMLFormElement);

    expect(
      await screen.findByText(
        'The large run alert must be a whole number from 1 to 100, or blank for off.'
      )
    ).toBeInTheDocument();
    expect(apiClient.patch).not.toHaveBeenCalled();
  });

  it('sends nothing when the low-balance field is not a usable number, and says why', async () => {
    const user = userEvent.setup();

    render(
      <GroupBudget yourRole="member" groupId="grp_1" budget={ADMIN_BUDGET} viewerUserId="user_a" />
    );
    const input = screen.getByRole('spinbutton', { name: /Email me when the balance falls to/ });
    await user.type(input, '-5');
    // Same reason as the large-run case above: -5 fails the input's own
    // `min={0}` before a real submit-button click would ever reach React.
    fireEvent.submit(input.closest('form') as HTMLFormElement);

    expect(
      await screen.findByText(
        'The low balance alert must be a number of credits, or blank for off.'
      )
    ).toBeInTheDocument();
    expect(apiClient.patch).not.toHaveBeenCalled();
  });

  it.each(['12.5', '0', '101'])(
    'sends nothing for a large-run share of %s, which the server would refuse',
    async (share) => {
      // Sent together, a bad share would sink the low-balance setting too.
      const user = userEvent.setup();

      render(
        <GroupBudget
          yourRole="member"
          groupId="grp_1"
          budget={ADMIN_BUDGET}
          viewerUserId="user_a"
        />
      );
      await user.type(screen.getByRole('spinbutton', { name: /or one run uses more than/ }), share);
      await user.click(screen.getByRole('button', { name: 'Save alerts' }));

      expect(apiClient.patch).not.toHaveBeenCalled();
    }
  );

  it('updates your own limit line when you save a cap for yourself', async () => {
    // Third review pass: the line above read the page's props and stayed stale.
    const user = userEvent.setup();
    vi.mocked(apiClient.patch).mockResolvedValue(undefined);

    render(
      <GroupBudget yourRole="admin" groupId="grp_1" budget={ADMIN_BUDGET} viewerUserId="user_a" />
    );
    expect(screen.queryByText(/You can use up to/)).toBeNull();

    await user.type(screen.getByLabelText('Daily limit for you'), '5');
    await user.tab();

    expect(screen.getByText(/You can use up to 5 credits here/)).toBeInTheDocument();
  });

  it('refuses a top-up above the server’s ceiling in plain words, without a request', async () => {
    const user = userEvent.setup();

    render(
      <GroupBudget yourRole="admin" groupId="grp_1" budget={ADMIN_BUDGET} viewerUserId="user_a" />
    );
    await user.type(
      screen.getByRole('spinbutton', { name: /Add credits from your own balance/ }),
      '2000000'
    );
    await user.click(screen.getByRole('button', { name: 'Add' }));

    expect(apiClient.post).not.toHaveBeenCalled();
    expect(await screen.findByText(/Add between 0 and 1,000,000 credits/)).toBeInTheDocument();
  });

  it('saves a member’s daily cap on blur', async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.patch).mockResolvedValue(undefined);

    render(
      <GroupBudget yourRole="member" groupId="grp_1" budget={ADMIN_BUDGET} viewerUserId="user_a" />
    );
    const capInput = screen.getByLabelText('Daily limit for user_b');
    await user.clear(capInput);
    await user.type(capInput, '30');
    await user.tab();

    expect(apiClient.patch).toHaveBeenCalledWith(
      RESPARKABLE_API.groupMemberCap('grp_1', 'user_b'),
      { body: { dailyCreditCap: 30 } }
    );
  });

  it('clears a member’s daily cap by blurring a blank field', async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.patch).mockResolvedValue(undefined);

    render(
      <GroupBudget yourRole="member" groupId="grp_1" budget={ADMIN_BUDGET} viewerUserId="user_a" />
    );
    const capInput = screen.getByLabelText('Daily limit for user_b');
    await user.clear(capInput);
    await user.tab();

    expect(apiClient.patch).toHaveBeenCalledWith(
      RESPARKABLE_API.groupMemberCap('grp_1', 'user_b'),
      { body: { dailyCreditCap: null } }
    );
  });

  it('does not call the API when a typed cap is not a usable number, and says why', async () => {
    const user = userEvent.setup();

    render(
      <GroupBudget yourRole="member" groupId="grp_1" budget={ADMIN_BUDGET} viewerUserId="user_a" />
    );
    const capInput = screen.getByLabelText('Daily limit for user_b');
    await user.clear(capInput);
    // A number input still accepts a leading minus sign while typing; the
    // service-layer rule (never negative) is what `parseOptional` enforces.
    await user.type(capInput, '-5');
    await user.tab();

    expect(
      await screen.findByText('A daily limit must be a number of credits, or blank for no limit.')
    ).toBeInTheDocument();
    expect(apiClient.patch).not.toHaveBeenCalled();
  });

  it('sends nothing when a cap box is blurred without being changed', async () => {
    const user = userEvent.setup();

    render(
      <GroupBudget yourRole="member" groupId="grp_1" budget={ADMIN_BUDGET} viewerUserId="user_a" />
    );
    const capInput = screen.getByLabelText('Daily limit for user_b');
    await user.click(capInput);
    await user.tab();

    expect(apiClient.patch).not.toHaveBeenCalled();
  });

  it('sends nothing on a later blur after a cap save succeeded, unless the value changes again', async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.patch).mockResolvedValue(undefined);

    render(
      <GroupBudget yourRole="member" groupId="grp_1" budget={ADMIN_BUDGET} viewerUserId="user_a" />
    );
    const capInput = screen.getByLabelText('Daily limit for user_b');
    await user.clear(capInput);
    await user.type(capInput, '30');
    await user.tab();

    expect(apiClient.patch).toHaveBeenCalledTimes(1);

    vi.mocked(apiClient.patch).mockClear();
    await user.click(capInput);
    await user.tab();

    expect(apiClient.patch).not.toHaveBeenCalled();
  });
});

describe('GroupBudget balance follows prop changes', () => {
  it('updates the shown balance when a new balanceCredits prop arrives, without remounting', () => {
    const { rerender } = render(
      <GroupBudget yourRole="member" groupId="grp_1" budget={MEMBER_BUDGET} viewerUserId="user_b" />
    );

    expect(screen.getByText('40')).toBeInTheDocument();

    rerender(
      <GroupBudget
        yourRole="member"
        groupId="grp_1"
        budget={{ ...MEMBER_BUDGET, balanceCredits: 65 }}
        viewerUserId="user_b"
      />
    );

    expect(screen.getByText('65')).toBeInTheDocument();
  });
});
