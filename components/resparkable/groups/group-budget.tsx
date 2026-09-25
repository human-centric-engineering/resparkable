'use client';

/**
 * A group's credits: the balance everyone sees, the top-up, and the admin half.
 *
 * ## Two audiences, one component, and the split is the server's
 *
 * `budget.admin` is `null` for anybody who is not an admin, so there is nothing
 * here to hide with a role check: the per-person figures never reach a member's
 * browser at all (§23.12, "an admin sees spend, and nobody sees productivity").
 * The role checks below only decide which controls to draw.
 *
 * ## The daily limit is not a productivity control
 *
 * Its help text says what it is for (a workflow left looping overnight) and not
 * what it could be misread as. §23.12 says an admin UI that presents it as "a
 * member is using too much" has misread it, so the copy never compares members.
 *
 * Not on the space-carrying client, for the reason `group-detail.tsx` gives.
 */

import * as React from 'react';

import { SaveStatus, useSaveStatus } from '@/components/resparkable/ui/save-status';
import { Button } from '@/components/ui/button';
import { FieldHelp } from '@/components/ui/field-help';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { apiClient } from '@/lib/api/client';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import type { GroupBudgetWire } from '@/lib/framework/resparkable/ui/payloads';

export interface GroupBudgetProps {
  groupId: string;
  budget: GroupBudgetWire;
  /** The caller's role, so a viewer is told why they cannot add credits. */
  yourRole: string;
  viewerUserId: string;
}

type FundingMode = GroupBudgetWire['fundingMode'];

/** The server's ceiling on any one amount (`validations.ts`). */
const MAX_CREDITS = 1_000_000;

/**
 * A blank box means "off" or "no limit"; anything else must be a number from
 * zero to the server's ceiling, so a value it would refuse is refused here in
 * plain words instead.
 */
function parseOptional(value: string): number | null | undefined {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= MAX_CREDITS ? parsed : undefined;
}

/**
 * The large-run share: blank is off, otherwise a whole number from 1 to 100,
 * which is what the server accepts. Anything else is refused here so a bad
 * percentage cannot take the low-balance setting down with it in one PATCH.
 */
function parsePercent(value: string): number | null | undefined {
  const parsed = parseOptional(value);
  if (parsed === null || parsed === undefined) return parsed;
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 100 ? parsed : undefined;
}

export function GroupBudget({
  groupId,
  budget,
  yourRole,
  viewerUserId,
}: GroupBudgetProps): React.ReactElement {
  const [balance, setBalance] = React.useState(budget.balanceCredits);
  const [personal, setPersonal] = React.useState(budget.yourPersonalBalanceCredits);
  // A `router.refresh()` brings new figures. Follow them without remounting,
  // so nothing an admin is typing below is lost.
  React.useEffect(() => setBalance(budget.balanceCredits), [budget.balanceCredits]);
  React.useEffect(
    () => setPersonal(budget.yourPersonalBalanceCredits),
    [budget.yourPersonalBalanceCredits]
  );
  const [amount, setAmount] = React.useState('');
  // Your own limit, which an admin can change for themselves in the table below.
  const [yourCap, setYourCap] = React.useState(budget.you.dailyCreditCap);
  React.useEffect(() => setYourCap(budget.you.dailyCreditCap), [budget.you.dailyCreditCap]);
  const { state, message, run } = useSaveStatus();

  async function topUp(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const credits = Number(amount);
    if (!Number.isFinite(credits) || credits <= 0 || credits > MAX_CREDITS) {
      await run(() =>
        Promise.reject(new Error(`Add between 0 and ${MAX_CREDITS.toLocaleString()} credits.`))
      );
      return;
    }

    const box: { result: { balanceCredits: number } | null } = { result: null };
    const ok = await run(async () => {
      box.result = await apiClient.post(RESPARKABLE_API.groupTopUp(groupId), {
        body: { credits },
      });
    });
    if (ok && box.result) {
      setBalance(box.result.balanceCredits);
      setPersonal((prev) => Math.round((prev - credits) * 100) / 100);
      setAmount('');
    }
  }

  return (
    <section className="flex flex-col gap-4">
      <div>
        <h3 className="mb-2 flex items-center gap-1.5 text-sm font-medium">
          Credits
          <FieldHelp title="The group's credits">
            <p>
              Everyone in the group spends from this balance when they use a feature that costs
              credits. Nobody&apos;s own credits are ever used instead: when the group runs out,
              those features stop until someone adds more.
            </p>
            <p>Viewers never spend credits.</p>
          </FieldHelp>
        </h3>
        <p className="text-sm">
          The group has <strong>{balance}</strong> credits.
        </p>
        {yourCap !== null && (
          <p className="text-muted-foreground mt-1 text-xs">
            You can use up to {yourCap} credits here in any 24 hours. You have used{' '}
            {budget.you.spentLastDayCredits}.
          </p>
        )}
      </div>

      {budget.canTopUp ? (
        <form className="flex items-end gap-2" onSubmit={(event) => void topUp(event)}>
          <div className="flex-1">
            <Label htmlFor="group-top-up" className="mb-1 flex items-center gap-1.5 text-xs">
              Add credits from your own balance
              <FieldHelp title="Adding credits">
                <p>
                  The credits come out of your own balance and go to the group. You have {personal}{' '}
                  of your own.
                </p>
                <p>This cannot be undone: once added, they are the group&apos;s.</p>
              </FieldHelp>
            </Label>
            <Input
              id="group-top-up"
              type="number"
              min={0}
              step="any"
              inputMode="decimal"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              placeholder="10"
            />
          </div>
          <Button type="submit" size="sm" disabled={!amount.trim() || state === 'saving'}>
            Add
          </Button>
        </form>
      ) : (
        <p className="text-muted-foreground text-xs">
          {yourRole === 'viewer'
            ? 'Viewers do not add or spend credits.'
            : 'In this group, admins add the credits.'}
        </p>
      )}

      <SaveStatus state={state} message={message} />

      {budget.admin && (
        <GroupBudgetAdmin
          groupId={groupId}
          fundingMode={budget.fundingMode}
          admin={budget.admin}
          viewerUserId={viewerUserId}
          onCapSaved={(userId, cap) => {
            if (userId === viewerUserId) setYourCap(cap);
          }}
        />
      )}
    </section>
  );
}

function GroupBudgetAdmin({
  groupId,
  fundingMode: initialMode,
  admin,
  viewerUserId,
  onCapSaved,
}: {
  groupId: string;
  fundingMode: FundingMode;
  admin: NonNullable<GroupBudgetWire['admin']>;
  viewerUserId: string;
  onCapSaved: (userId: string, cap: number | null) => void;
}): React.ReactElement {
  const [fundingMode, setFundingMode] = React.useState<FundingMode>(initialMode);
  const [lowBalance, setLowBalance] = React.useState(
    admin.lowBalanceAlertCredits === null ? '' : String(admin.lowBalanceAlertCredits)
  );
  const [largeRun, setLargeRun] = React.useState(
    admin.largeRunAlertPercent === null ? '' : String(admin.largeRunAlertPercent)
  );
  const [caps, setCaps] = React.useState<Record<string, string>>(() =>
    Object.fromEntries(
      admin.members.map((member) => [
        member.userId,
        member.dailyCreditCap === null ? '' : String(member.dailyCreditCap),
      ])
    )
  );
  // What the server last accepted for each cap, to tell a changed box from one
  // that was only visited.
  const savedCaps = React.useRef<Record<string, string>>(caps);
  const { state, message, run } = useSaveStatus();

  async function changeMode(next: string): Promise<void> {
    if (next !== 'self_funded' && next !== 'member_contributions') return;
    const previous = fundingMode;
    setFundingMode(next);
    const ok = await run(() =>
      apiClient.patch(RESPARKABLE_API.groupBudget(groupId), { body: { fundingMode: next } })
    );
    if (!ok) setFundingMode(previous);
  }

  /** Say why nothing was saved, in the same status line a save uses. */
  function refuse(message: string): Promise<boolean> {
    return run(() => Promise.reject(new Error(message)));
  }

  async function saveAlerts(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const lowBalanceAlertCredits = parseOptional(lowBalance);
    const largeRunAlertPercent = parsePercent(largeRun);
    if (lowBalanceAlertCredits === undefined) {
      await refuse('The low balance alert must be a number of credits, or blank for off.');
      return;
    }
    if (largeRunAlertPercent === undefined) {
      await refuse('The large run alert must be a whole number from 1 to 100, or blank for off.');
      return;
    }
    await run(() =>
      apiClient.patch(RESPARKABLE_API.groupBudget(groupId), {
        body: { lowBalanceAlertCredits, largeRunAlertPercent },
      })
    );
  }

  async function saveCap(userId: string): Promise<void> {
    const typed = caps[userId] ?? '';
    // Leaving a box without changing it saves nothing, so tabbing through the
    // table neither sends a request per row nor writes back a value another
    // admin has since changed.
    if (typed.trim() === (savedCaps.current[userId] ?? '').trim()) return;
    const dailyCreditCap = parseOptional(typed);
    if (dailyCreditCap === undefined) {
      await refuse('A daily limit must be a number of credits, or blank for no limit.');
      return;
    }
    const ok = await run(() =>
      apiClient.patch(RESPARKABLE_API.groupMemberCap(groupId, userId), {
        body: { dailyCreditCap },
      })
    );
    if (ok) {
      savedCaps.current = { ...savedCaps.current, [userId]: typed };
      onCapSaved(userId, dailyCreditCap);
    }
  }

  return (
    <div className="border-border/60 flex flex-col gap-4 rounded-md border px-3 py-3">
      <p className="text-muted-foreground text-[11px]">Only admins see this part.</p>

      <div className="flex items-center gap-2">
        <Label htmlFor="group-funding-mode" className="flex items-center gap-1.5 text-xs">
          Who adds credits
          <FieldHelp title="Who adds credits">
            <p>
              <strong>Admins only</strong>: admins add credits from their own balance.
            </p>
            <p>
              <strong>Any member</strong>: members can add credits from their own balance too.
              Viewers never can.
            </p>
            <p>
              Either way, adding credits is something a person does on purpose. Nobody&apos;s own
              credits are ever taken to pay for the group.
            </p>
          </FieldHelp>
        </Label>
        <Select value={fundingMode} onValueChange={(next) => void changeMode(next)}>
          <SelectTrigger id="group-funding-mode" className="h-8 w-40 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="self_funded">Admins only</SelectItem>
            <SelectItem value="member_contributions">Any member</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <form className="flex flex-wrap items-end gap-3" onSubmit={(event) => void saveAlerts(event)}>
        <div>
          <Label htmlFor="group-low-balance" className="mb-1 flex items-center gap-1.5 text-xs">
            Email me when the balance falls to
            <FieldHelp title="Low balance alert">
              <p>
                Admins get an email when the group&apos;s balance falls to this many credits or
                below. Leave it blank to switch it off.
              </p>
              <p>It is sent once as the balance crosses the line, not after every run.</p>
            </FieldHelp>
          </Label>
          <Input
            id="group-low-balance"
            className="w-32"
            type="number"
            min={0}
            step="any"
            inputMode="decimal"
            value={lowBalance}
            onChange={(event) => setLowBalance(event.target.value)}
            placeholder="Off"
          />
        </div>
        <div>
          <Label htmlFor="group-large-run" className="mb-1 flex items-center gap-1.5 text-xs">
            or one run uses more than (%)
            <FieldHelp title="Large run alert">
              <p>
                Admins get an email when a single run uses more than this share of the credits that
                were left before it. Leave it blank to switch it off.
              </p>
            </FieldHelp>
          </Label>
          <Input
            id="group-large-run"
            className="w-24"
            type="number"
            min={1}
            max={100}
            step={1}
            inputMode="numeric"
            value={largeRun}
            onChange={(event) => setLargeRun(event.target.value)}
            placeholder="Off"
          />
        </div>
        <Button type="submit" size="sm" variant="outline" disabled={state === 'saving'}>
          Save alerts
        </Button>
      </form>

      <div>
        <h4 className="mb-2 flex items-center gap-1.5 text-xs font-medium">
          Credits by person, last {admin.windowDays} days
          <FieldHelp title="Daily limit">
            <p>
              A daily limit caps what one person can spend from the group in any 24 hours. It is a
              safety net for something left running by mistake, such as a workflow that loops
              overnight.
            </p>
            <p>Leave it blank for no limit. Members see their own limit and nobody else&apos;s.</p>
          </FieldHelp>
        </h4>
        <table className="w-full text-xs">
          <thead className="text-muted-foreground text-left">
            <tr>
              <th className="py-1 font-normal">Person</th>
              <th className="py-1 font-normal">Spent</th>
              <th className="py-1 font-normal">Added</th>
              <th className="py-1 font-normal">Daily limit</th>
            </tr>
          </thead>
          <tbody>
            {admin.members.map((member) => (
              <tr key={member.userId} className="border-border/60 border-t">
                <td className="max-w-40 truncate py-1.5">
                  {member.userId === viewerUserId ? 'You' : member.userId}
                </td>
                <td className="py-1.5">{member.spentCredits}</td>
                <td className="py-1.5">{member.contributedCredits}</td>
                <td className="py-1.5">
                  {member.role === 'viewer' ? (
                    <span className="text-muted-foreground">Viewer</span>
                  ) : (
                    <Input
                      className="h-7 w-24 text-xs"
                      type="number"
                      min={0}
                      step="any"
                      inputMode="decimal"
                      aria-label={`Daily limit for ${member.userId === viewerUserId ? 'you' : member.userId}`}
                      value={caps[member.userId] ?? ''}
                      onChange={(event) =>
                        setCaps((prev) => ({ ...prev, [member.userId]: event.target.value }))
                      }
                      onBlur={() => void saveCap(member.userId)}
                      placeholder="None"
                    />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <SaveStatus state={state} message={message} />
    </div>
  );
}
