'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { BillingInterval } from '@/lib/billing/period';

const PROVIDERS: { value: 'stripe' | 'paystack' | 'oxapay'; label: string }[] = [
  { value: 'stripe', label: 'Card (international)' },
  { value: 'paystack', label: 'Card (NGN)' },
  { value: 'oxapay', label: 'Crypto' },
];

export function CheckoutButton({
  planId,
  billingInterval,
}: {
  planId: string;
  billingInterval: BillingInterval;
}) {
  const [provider, setProvider] = useState<'stripe' | 'paystack' | 'oxapay'>('stripe');
  const [promoCode, setPromoCode] = useState('');
  const [showPromo, setShowPromo] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleUpgrade() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/billing/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          planId,
          billingInterval,
          provider,
          promoCode: promoCode.trim() || undefined,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { checkoutUrl?: string; error?: string };
      if (!res.ok || !body.checkoutUrl) {
        setError(body.error ?? 'Failed to start checkout. Please try again.');
        setLoading(false);
        return;
      }
      window.location.href = body.checkoutUrl;
    } catch {
      setError('Failed to start checkout. Please try again.');
      setLoading(false);
    }
  }

  return (
    <div className="space-y-2">
      <Select value={provider} onValueChange={(v) => setProvider(v as typeof provider)}>
        <SelectTrigger className="h-11 w-full md:h-9">
          <SelectValue placeholder="Payment method" />
        </SelectTrigger>
        <SelectContent>
          {PROVIDERS.map((p) => (
            <SelectItem key={p.value} value={p.value}>
              {p.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {showPromo ? (
        <Input
          value={promoCode}
          onChange={(e) => setPromoCode(e.target.value)}
          placeholder="Promo code"
          className="h-11 w-full md:h-9"
        />
      ) : (
        <button
          type="button"
          onClick={() => setShowPromo(true)}
          className="text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
        >
          Have a promo code?
        </button>
      )}

      <Button onClick={handleUpgrade} disabled={loading} className="h-11 w-full md:h-9">
        {loading ? 'Redirecting…' : 'Upgrade'}
      </Button>

      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
