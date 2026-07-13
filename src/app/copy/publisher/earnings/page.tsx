'use client';

/**
 * Publisher Earnings Dashboard — /copy/publisher/earnings
 *
 * Displays:
 *  - Summary stat cards: total fees earned, platform cut, net earnings, trade count
 *  - Monthly bar chart (SVG, no external chart lib required)
 *  - Per-subscriber breakdown table
 *  - Recent individual earning records
 *
 * All amounts are in USDT (or the platform's quote currency).
 * Payment processing is out of scope for MVP — amounts are accrued and displayed only.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Totals {
  totalFeeAmount: number;
  totalPlatformCut: number;
  totalPublisherNet: number;
  totalTrades: number;
}

interface SubscriberRow {
  subscriberId: string;
  tradeCount: number;
  totalProfit: number;
  totalFee: number;
  totalNet: number;
}

interface MonthRow {
  period: string | null;
  tradeCount: number;
  totalFee: number;
  totalNet: number;
}

interface EarningRecord {
  id: string;
  subscriberId: string;
  tradeId: string | null;
  profitAmount: number;
  feeAmount: number;
  platformCutAmount: number;
  publisherNetAmount: number;
  period: string | null;
  createdAt: string | null;
}

interface EarningsData {
  publisherId: string;
  feePercent: string | null;
  totals: Totals;
  bySubscriber: SubscriberRow[];
  byMonth: MonthRow[];
  recentEarnings: EarningRecord[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmt(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

function fmtShort(s: string | null | undefined): string {
  if (!s) return '—';
  return `${s.slice(0, 8)}…`;
}

function formatDate(s: string | null): string {
  if (!s) return '—';
  return new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ---------------------------------------------------------------------------
// Stat card
// ---------------------------------------------------------------------------

function StatCard({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: 'green' | 'muted';
}) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p
        className={`text-2xl font-bold mt-1 ${
          accent === 'green' ? 'text-green-600 dark:text-green-400' : ''
        }`}
      >
        {value}
      </p>
      {sub && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Minimal SVG bar chart for monthly earnings
// ---------------------------------------------------------------------------

function MonthlyChart({ data }: { data: MonthRow[] }) {
  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-32 text-muted-foreground text-sm">
        No monthly data yet
      </div>
    );
  }

  const maxVal = Math.max(...data.map((d) => d.totalNet), 1);
  const barWidth = Math.min(40, Math.floor(400 / data.length) - 4);

  return (
    <div className="overflow-x-auto">
      <svg
        viewBox={`0 0 ${data.length * (barWidth + 6)} 120`}
        className="w-full h-32"
        aria-label="Monthly earnings chart"
      >
        {data.map((d, i) => {
          const h = Math.max(4, (d.totalNet / maxVal) * 90);
          const x = i * (barWidth + 6);
          const y = 100 - h;
          return (
            <g key={d.period ?? i}>
              <rect
                x={x}
                y={y}
                width={barWidth}
                height={h}
                rx={2}
                className="fill-primary opacity-80"
              />
              <text
                x={x + barWidth / 2}
                y={114}
                textAnchor="middle"
                fontSize={7}
                className="fill-muted-foreground"
              >
                {d.period?.slice(5) ?? '—'}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function PublisherEarningsPage() {
  const [data, setData] = useState<EarningsData | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/copy/publisher/earnings')
      .then(async (res) => {
        if (res.status === 404) {
          setError('No publisher profile found. Create one first.');
          setData(null);
          return;
        }
        if (!res.ok) {
          setError('Failed to load earnings data.');
          setData(null);
          return;
        }
        const json = (await res.json()) as EarningsData;
        setData(json);
      })
      .catch(() => {
        setError('Network error. Please try again.');
        setData(null);
      });
  }, []);

  if (data === undefined) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <p className="text-muted-foreground">Loading…</p>
      </div>
    );
  }

  if (error || data === null) {
    return (
      <div className="max-w-2xl mx-auto py-10 px-4 space-y-4">
        <div className="flex items-center gap-4">
          <Link href="/copy/publisher">
            <Button variant="outline" size="sm">Back to Profile</Button>
          </Link>
          <h1 className="text-2xl font-bold">Publisher Earnings</h1>
        </div>
        <Card className="p-6 border-destructive">
          <p className="text-destructive">{error ?? 'Unknown error'}</p>
          {!data && (
            <p className="text-sm text-muted-foreground mt-2">
              <Link href="/copy/publisher" className="underline">Create a publisher profile</Link>{' '}
              to start earning performance fees.
            </p>
          )}
        </Card>
      </div>
    );
  }

  const { totals, bySubscriber, byMonth, recentEarnings, feePercent } = data;

  return (
    <div className="max-w-4xl mx-auto py-10 px-4 space-y-8">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-3">
            <Link href="/copy/publisher">
              <Button variant="outline" size="sm">Back to Profile</Button>
            </Link>
            <h1 className="text-2xl font-bold">Publisher Earnings</h1>
          </div>
          <p className="text-muted-foreground mt-1 text-sm">
            Performance fees accrued from subscriber profits.
            {feePercent && (
              <span className="ml-1">
                Current fee rate:{' '}
                <Badge variant="secondary">{parseFloat(feePercent).toFixed(1)}%</Badge>
              </span>
            )}
          </p>
        </div>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard
          label="Net Earnings (You Keep)"
          value={`$${fmt(totals.totalPublisherNet)}`}
          sub="After platform cut"
          accent="green"
        />
        <StatCard
          label="Gross Fees Accrued"
          value={`$${fmt(totals.totalFeeAmount)}`}
          sub="Before platform cut"
        />
        <StatCard
          label="Platform Cut"
          value={`$${fmt(totals.totalPlatformCut)}`}
          sub={`${process.env.NEXT_PUBLIC_PLATFORM_CUT_PCT ?? '20'}% of gross`}
          accent="muted"
        />
        <StatCard
          label="Profitable Trades Billed"
          value={String(totals.totalTrades)}
          sub="Across all subscribers"
        />
      </div>

      {/* Monthly chart */}
      <Card className="p-6 space-y-4">
        <div>
          <h2 className="text-lg font-semibold">Monthly Earnings (Net)</h2>
          <p className="text-sm text-muted-foreground">
            Your net earnings per calendar month after the platform cut.
          </p>
        </div>
        <MonthlyChart data={byMonth} />
        {byMonth.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th className="text-left pb-2 text-muted-foreground font-medium">Month</th>
                  <th className="text-right pb-2 text-muted-foreground font-medium">Trades</th>
                  <th className="text-right pb-2 text-muted-foreground font-medium">Gross Fee</th>
                  <th className="text-right pb-2 text-muted-foreground font-medium">Net Earnings</th>
                </tr>
              </thead>
              <tbody>
                {byMonth.map((m) => (
                  <tr key={m.period ?? 'none'} className="border-b last:border-0">
                    <td className="py-2">{m.period ?? '—'}</td>
                    <td className="py-2 text-right">{m.tradeCount}</td>
                    <td className="py-2 text-right">${fmt(m.totalFee)}</td>
                    <td className="py-2 text-right text-green-600 dark:text-green-400 font-medium">
                      ${fmt(m.totalNet)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Per-subscriber breakdown */}
      <Card className="p-6 space-y-4">
        <div>
          <h2 className="text-lg font-semibold">Per-Subscriber Breakdown</h2>
          <p className="text-sm text-muted-foreground">
            Fees earned from each subscriber, sorted by gross fee descending.
          </p>
        </div>
        {bySubscriber.length === 0 ? (
          <p className="text-muted-foreground text-sm py-4">No earnings yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th className="text-left pb-2 text-muted-foreground font-medium">Subscriber</th>
                  <th className="text-right pb-2 text-muted-foreground font-medium">Trades</th>
                  <th className="text-right pb-2 text-muted-foreground font-medium">Subscriber Profit</th>
                  <th className="text-right pb-2 text-muted-foreground font-medium">Gross Fee</th>
                  <th className="text-right pb-2 text-muted-foreground font-medium">Net to You</th>
                </tr>
              </thead>
              <tbody>
                {bySubscriber.map((s) => (
                  <tr key={s.subscriberId} className="border-b last:border-0">
                    <td className="py-2 font-mono text-xs">{fmtShort(s.subscriberId)}</td>
                    <td className="py-2 text-right">{s.tradeCount}</td>
                    <td className="py-2 text-right">${fmt(s.totalProfit)}</td>
                    <td className="py-2 text-right">${fmt(s.totalFee)}</td>
                    <td className="py-2 text-right text-green-600 dark:text-green-400 font-medium">
                      ${fmt(s.totalNet)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Recent individual earnings */}
      <Card className="p-6 space-y-4">
        <div>
          <h2 className="text-lg font-semibold">Recent Earning Records</h2>
          <p className="text-sm text-muted-foreground">
            Last 50 individual fee accruals. Actual payment handled via manual settlement or future billing.
          </p>
        </div>
        {recentEarnings.length === 0 ? (
          <p className="text-muted-foreground text-sm py-4">No earnings yet. Fees accrue when subscribers close profitable copied trades.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th className="text-left pb-2 text-muted-foreground font-medium">Date</th>
                  <th className="text-left pb-2 text-muted-foreground font-medium">Period</th>
                  <th className="text-left pb-2 text-muted-foreground font-medium">Subscriber</th>
                  <th className="text-right pb-2 text-muted-foreground font-medium">Profit</th>
                  <th className="text-right pb-2 text-muted-foreground font-medium">Fee</th>
                  <th className="text-right pb-2 text-muted-foreground font-medium">Net</th>
                </tr>
              </thead>
              <tbody>
                {recentEarnings.map((e) => (
                  <tr key={e.id} className="border-b last:border-0">
                    <td className="py-2 whitespace-nowrap">{formatDate(e.createdAt)}</td>
                    <td className="py-2">{e.period ?? '—'}</td>
                    <td className="py-2 font-mono text-xs">{fmtShort(e.subscriberId)}</td>
                    <td className="py-2 text-right">${fmt(e.profitAmount)}</td>
                    <td className="py-2 text-right">${fmt(e.feeAmount)}</td>
                    <td className="py-2 text-right text-green-600 dark:text-green-400 font-medium">
                      ${fmt(e.publisherNetAmount)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
