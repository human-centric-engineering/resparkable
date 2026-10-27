/**
 * PerOrgUsageTable — each org's spend this month against its monthly cap
 * (§110 t-790).
 *
 * Fed by `GET /api/v1/admin/orchestration/costs/orgs`, one call for every
 * row. Rendered only with more than one org, or spend from an erased org:
 * at `single` the one org's spend is already the month total on the summary
 * cards. The detached
 * row is spend whose org has been erased; it still counts towards the global
 * cap, so it is shown rather than dropped.
 */

import Link from 'next/link';

import { FieldHelp } from '@/components/ui/field-help';
import { Tip } from '@/components/ui/tooltip';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { UtilisationBar } from '@/components/admin/orchestration/costs/per-agent-cost-table';
import { Usd } from '@/components/admin/orchestration/costs/usd';
import type { OrgUsageReport } from '@/lib/orchestration/llm/cost-reports';

export interface PerOrgUsageTableProps {
  report: OrgUsageReport;
}

function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

export function PerOrgUsageTable({ report }: PerOrgUsageTableProps) {
  const detached = report.detached && report.detached.count > 0 ? report.detached : null;

  return (
    <Card data-testid="per-org-usage-table">
      <CardHeader>
        <CardTitle className="flex items-center gap-1 text-base">
          Spend by organisation ({report.period})
          <FieldHelp title="Spend by organisation">
            <p>
              Each organisation&apos;s AI spend for this calendar month (UTC), against the monthly
              cap set on the organisation. When an organisation reaches its cap, its calls to paid
              providers are refused until the next month.
            </p>
            <p className="mt-2">
              <strong>No org</strong> is spend from organisations that have been deleted. It still
              counts towards the global monthly budget.
            </p>
          </FieldHelp>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Organisation</TableHead>
              <TableHead className="text-right">
                <Tip label="LLM spend this calendar month (UTC)">
                  <span>Spend</span>
                </Tip>
              </TableHead>
              <TableHead className="text-right">
                <Tip label="Number of metered AI calls this month">
                  <span>Calls</span>
                </Tip>
              </TableHead>
              <TableHead className="text-right">
                <Tip label="Input + output tokens this month">
                  <span>Tokens</span>
                </Tip>
              </TableHead>
              <TableHead className="text-right">
                <Tip label="The organisation's monthly budget cap in USD — blank means no cap of its own">
                  <span>Cap</span>
                </Tip>
              </TableHead>
              <TableHead>
                <Tip label="Percentage of the monthly cap spent — green up to 50%, amber 51–80%, red above 80%">
                  <span>Utilisation</span>
                </Tip>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {report.orgs.map((row) => (
              <TableRow key={row.orgId}>
                <TableCell className="font-medium">
                  <Link href={`/admin/orgs/${row.orgId}`} className="hover:underline">
                    {row.name}
                  </Link>
                  {row.status !== 'ACTIVE' && (
                    <Badge variant="destructive" className="ml-2 px-1.5 py-0 text-[10px]">
                      {row.status.toLowerCase()}
                    </Badge>
                  )}
                  <div className="text-muted-foreground font-mono text-xs">{row.slug}</div>
                </TableCell>
                <TableCell className="text-right">
                  <Usd value={row.totalCostUsd} />
                </TableCell>
                <TableCell className="text-right tabular-nums">{formatCount(row.count)}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatCount(row.inputTokens + row.outputTokens)}
                </TableCell>
                <TableCell className="text-right">
                  <Usd value={row.monthlyBudgetUsd} />
                </TableCell>
                <TableCell>
                  {row.monthlyBudgetUsd === 0 ? (
                    <span className="text-muted-foreground text-xs">Paid calls off</span>
                  ) : (
                    <UtilisationBar utilisation={row.utilisation} />
                  )}
                </TableCell>
              </TableRow>
            ))}
            {detached && (
              <TableRow data-testid="per-org-usage-detached">
                <TableCell className="text-muted-foreground italic">No org</TableCell>
                <TableCell className="text-right">
                  <Usd value={detached.totalCostUsd} />
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatCount(detached.count)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatCount(detached.inputTokens + detached.outputTokens)}
                </TableCell>
                <TableCell />
                <TableCell />
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
