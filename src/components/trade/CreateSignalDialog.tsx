'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';

interface CreateSignalDialogProps {
  /** Called after a signal is successfully created, so the page can refresh the queue. */
  onCreated: () => void;
}

interface FormState {
  symbol: string;
  direction: 'LONG' | 'SHORT';
  timeframe: string;
  entryPrice: string;
  stopLoss: string;
  takeProfit: string;
  marketType: '' | 'spot' | 'swap';
  leverage: string;
  marginMode: '' | 'cross' | 'isolated';
  riskPct: string;
}

const INITIAL_STATE: FormState = {
  symbol: '',
  direction: 'LONG',
  timeframe: '1h',
  entryPrice: '',
  stopLoss: '',
  takeProfit: '',
  marketType: '',
  leverage: '',
  marginMode: '',
  riskPct: '',
};

export function CreateSignalDialog({ onCreated }: CreateSignalDialogProps) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<FormState>(INITIAL_STATE);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function reset() {
    setForm(INITIAL_STATE);
    setError(null);
    setSuccessMessage(null);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setSuccessMessage(null);

    try {
      const res = await fetch('/api/trade-signals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol: form.symbol,
          direction: form.direction,
          timeframe: form.timeframe,
          entryPrice: form.entryPrice,
          stopLoss: form.stopLoss,
          takeProfit: form.takeProfit,
          marketType: form.marketType || undefined,
          leverage: form.leverage || undefined,
          marginMode: form.marginMode || undefined,
          riskPct: form.riskPct || undefined,
        }),
      });

      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error((body as { error?: string }).error ?? `Request failed: ${res.status}`);
      }

      setSuccessMessage((body as { message?: string }).message ?? 'Signal created.');
      onCreated();
      setTimeout(() => {
        setOpen(false);
        reset();
      }, 1200);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create signal.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="h-11 w-full shrink-0 md:h-8 md:w-auto">
          Create Signal
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create a manual signal</DialogTitle>
          <DialogDescription>
            Place a trade directly — it flows through the same approval, sizing, and SL/TP
            management as AI-generated signals. If you&apos;re in auto-execution mode it attempts to
            fill immediately; otherwise it lands in your Pending queue.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2 sm:col-span-1">
              <label className="text-xs text-muted-foreground mb-1 block">Symbol</label>
              <Input
                placeholder="BTC/USDT"
                value={form.symbol}
                onChange={(e) => update('symbol', e.target.value)}
                required
              />
            </div>
            <div className="col-span-2 sm:col-span-1">
              <label className="text-xs text-muted-foreground mb-1 block">Direction</label>
              <select
                className="border-input flex h-9 w-full rounded-md border bg-transparent px-3 py-1 text-sm shadow-xs"
                value={form.direction}
                onChange={(e) => update('direction', e.target.value as 'LONG' | 'SHORT')}
              >
                <option value="LONG">LONG</option>
                <option value="SHORT">SHORT</option>
              </select>
            </div>

            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Entry price</label>
              <Input
                type="number"
                step="any"
                placeholder="0.00"
                value={form.entryPrice}
                onChange={(e) => update('entryPrice', e.target.value)}
                required
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Timeframe</label>
              <Input
                placeholder="1h"
                value={form.timeframe}
                onChange={(e) => update('timeframe', e.target.value)}
              />
            </div>

            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Stop loss</label>
              <Input
                type="number"
                step="any"
                placeholder="0.00"
                value={form.stopLoss}
                onChange={(e) => update('stopLoss', e.target.value)}
                required
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Take profit</label>
              <Input
                type="number"
                step="any"
                placeholder="0.00"
                value={form.takeProfit}
                onChange={(e) => update('takeProfit', e.target.value)}
                required
              />
            </div>

            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Market type</label>
              <select
                className="border-input flex h-9 w-full rounded-md border bg-transparent px-3 py-1 text-sm shadow-xs"
                value={form.marketType}
                onChange={(e) => update('marketType', e.target.value as FormState['marketType'])}
              >
                <option value="">Profile default</option>
                <option value="spot">Spot</option>
                <option value="swap">Swap (perp)</option>
              </select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Margin mode</label>
              <select
                className="border-input flex h-9 w-full rounded-md border bg-transparent px-3 py-1 text-sm shadow-xs"
                value={form.marginMode}
                onChange={(e) => update('marginMode', e.target.value as FormState['marginMode'])}
              >
                <option value="">Profile default</option>
                <option value="cross">Cross</option>
                <option value="isolated">Isolated</option>
              </select>
            </div>

            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Leverage</label>
              <Input
                type="number"
                min="1"
                placeholder="Profile default"
                value={form.leverage}
                onChange={(e) => update('leverage', e.target.value)}
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Risk % override</label>
              <Input
                type="number"
                step="any"
                min="0.1"
                max="10"
                placeholder="Profile default"
                value={form.riskPct}
                onChange={(e) => update('riskPct', e.target.value)}
              />
            </div>
          </div>

          {error && (
            <div className="rounded-md bg-red-50 p-2.5 text-sm text-red-800 dark:bg-red-900/20 dark:text-red-300">
              {error}
            </div>
          )}
          {successMessage && (
            <div className="rounded-md bg-green-50 p-2.5 text-sm text-green-800 dark:bg-green-900/20 dark:text-green-300">
              {successMessage}
            </div>
          )}

          <DialogFooter>
            <Button type="submit" disabled={submitting} className="w-full sm:w-auto">
              {submitting ? 'Creating…' : 'Create Signal'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
