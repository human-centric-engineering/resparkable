'use client';

/**
 * CreditAccountsTable: the per-user balance table, with a "Grant credits"
 * action per row.
 *
 * Deliberately simpler than `UserTable`: no client-side search/sort/pagination
 * of its own (the accounts list is server-fetched once by the page), just the
 * one action this tab exists for. After a successful grant, `router.refresh()`
 * re-fetches the server component's props rather than reimplementing a second
 * fetch/merge path here.
 */

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle, Coins, Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { apiClient, APIClientError } from '@/lib/api/client';
import { RESPARKABLE_API } from '@/lib/framework/resparkable/api/endpoints';
import type { ResparkableAdminCreditAccountRow } from '@/lib/framework/resparkable/validations';

interface Props {
  accounts: ResparkableAdminCreditAccountRow[];
  currencyLabel: string;
}

export function CreditAccountsTable({ accounts, currencyLabel }: Props): React.ReactElement {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>User</TableHead>
          <TableHead className="text-right">Balance</TableHead>
          <TableHead className="w-40" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {accounts.length === 0 ? (
          <TableRow>
            <TableCell colSpan={3} className="text-muted-foreground text-center">
              No users yet.
            </TableCell>
          </TableRow>
        ) : (
          accounts.map((account) => (
            <TableRow key={account.userId}>
              <TableCell>
                <div className="font-medium">{account.userName ?? account.userEmail}</div>
                {account.userName && (
                  <div className="text-muted-foreground text-xs">{account.userEmail}</div>
                )}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {account.balanceCredits.toLocaleString()} {currencyLabel}
              </TableCell>
              <TableCell className="text-right">
                <GrantCreditsDialog userId={account.userId} userLabel={account.userEmail} />
              </TableCell>
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  );
}

function GrantCreditsDialog({
  userId,
  userLabel,
}: {
  userId: string;
  userLabel: string;
}): React.ReactElement {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [amount, setAmount] = React.useState('');
  const [note, setNote] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const parsedAmount = Number.parseFloat(amount);
  const amountValid = Number.isFinite(parsedAmount) && parsedAmount !== 0;

  async function handleGrant(): Promise<void> {
    setSubmitting(true);
    setError(null);
    try {
      await apiClient.post<unknown>(RESPARKABLE_API.ADMIN.BILLING_GRANTS, {
        body: { userId, amount: parsedAmount, ...(note.trim() ? { note: note.trim() } : {}) },
      });
      setOpen(false);
      setAmount('');
      setNote('');
      router.refresh();
    } catch (err) {
      setError(
        err instanceof APIClientError || err instanceof Error
          ? err.message
          : 'Failed to grant credits, please try again.'
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          <Coins className="mr-2 h-4 w-4" />
          Grant credits
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Grant credits to {userLabel}</DialogTitle>
          <DialogDescription>
            Writes an admin-grant ledger entry and adjusts their balance immediately. A negative
            amount is a correction.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="grant-amount">Amount</Label>
            <Input
              id="grant-amount"
              type="number"
              step="any"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              aria-invalid={amount !== '' && !amountValid}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="grant-note">Note (optional)</Label>
            <Textarea
              id="grant-note"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              maxLength={500}
              rows={2}
            />
          </div>
          {error && (
            <p className="text-destructive flex items-center gap-2 text-sm" role="alert">
              <AlertCircle className="h-4 w-4" />
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void handleGrant()}
            disabled={!amountValid || submitting}
          >
            {submitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Granting…
              </>
            ) : (
              'Grant'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
