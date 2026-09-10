'use client';

import { useEffect, useMemo, useState } from 'react';
import { ResourceTable, type FieldDef, type ColumnDef } from '@/components/admin/resource-table';

interface SubscriptionPlanRow {
  id: string;
  name: string;
}

interface SubscriptionPlanPriceRow {
  id: string;
  planId: string;
  billingInterval: 'monthly' | 'biannual' | 'yearly';
  price: string;
  currency: string;
  providerPriceId: { stripe?: string; paystack?: string } | null;
}

export default function SubscriptionPlanPricesPage() {
  const [plans, setPlans] = useState<SubscriptionPlanRow[]>([]);

  useEffect(() => {
    fetch('/api/admin/subscription-plans')
      .then((res) => (res.ok ? res.json() : { items: [] }))
      .then((json) => setPlans(json.items ?? []))
      .catch(() => setPlans([]));
  }, []);

  const planName = useMemo(() => {
    const map = new Map(plans.map((p) => [p.id, p.name]));
    return (id: string) => map.get(id) ?? id;
  }, [plans]);

  const fields: FieldDef[] = useMemo(
    () => [
      {
        key: 'planId',
        label: 'Plan',
        type: 'select',
        required: true,
        options: plans.map((p) => ({ label: p.name, value: p.id })),
      },
      {
        key: 'billingInterval',
        label: 'Billing interval',
        type: 'select',
        required: true,
        options: [
          { label: 'Monthly', value: 'monthly' },
          { label: 'Biannual', value: 'biannual' },
          { label: 'Yearly', value: 'yearly' },
        ],
      },
      { key: 'price', label: 'Price', type: 'number', required: true, placeholder: 'e.g. 29.00' },
      { key: 'currency', label: 'Currency', type: 'text', defaultValue: 'USD', placeholder: 'USD' },
      {
        key: 'providerPriceId',
        label: 'Provider price IDs (JSON)',
        type: 'json',
        placeholder: '{ "stripe": "price_...", "paystack": "PLN_..." }',
        helpText: 'Recurring Price/Plan object id per rail. OxaPay has none — priced inline per invoice.',
      },
    ],
    [plans],
  );

  const columns: ColumnDef<SubscriptionPlanPriceRow>[] = [
    { key: 'planId', label: 'Plan', render: (row) => planName(row.planId) },
    { key: 'billingInterval', label: 'Interval' },
    { key: 'price', label: 'Price', render: (row) => `${row.price} ${row.currency}` },
    {
      key: 'providerPriceId',
      label: 'Provider IDs',
      render: (row) =>
        row.providerPriceId && (row.providerPriceId.stripe || row.providerPriceId.paystack)
          ? [
              row.providerPriceId.stripe ? `stripe:${row.providerPriceId.stripe}` : null,
              row.providerPriceId.paystack ? `paystack:${row.providerPriceId.paystack}` : null,
            ]
              .filter(Boolean)
              .join(' / ')
          : '—',
    },
  ];

  return (
    <ResourceTable<SubscriptionPlanPriceRow>
      title="Subscription Plan Prices"
      description="Per-interval pricing for each plan, plus the recurring Price/Plan object id on the providers that have one (Stripe, Paystack). OxaPay is priced inline per invoice at checkout."
      apiPath="/api/admin/subscription-plan-prices"
      fields={fields}
      columns={columns}
      emptyLabel="No prices yet. Add a plan first, then price it per interval here."
    />
  );
}
