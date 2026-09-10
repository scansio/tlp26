'use client';

import { useEffect, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { ResourceTable, type FieldDef, type ColumnDef } from '@/components/admin/resource-table';

interface SubscriptionPlanRow {
  id: string;
  name: string;
}

interface PromoCodeRow {
  id: string;
  code: string;
  discountType: 'percent' | 'fixed';
  discountValue: string;
  discountScope: 'first_period' | 'recurring';
  applicablePlanIds: string[] | null;
  maxRedemptions: number | null;
  redemptionsUsed: number;
  active: boolean;
}

export default function PromoCodesPage() {
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

  const fields: FieldDef[] = [
    { key: 'code', label: 'Code', type: 'text', required: true, placeholder: 'e.g. LAUNCH25' },
    {
      key: 'discountType',
      label: 'Discount type',
      type: 'select',
      required: true,
      options: [
        { label: 'Percent', value: 'percent' },
        { label: 'Fixed amount', value: 'fixed' },
      ],
    },
    { key: 'discountValue', label: 'Discount value', type: 'number', required: true, placeholder: 'e.g. 25 (percent) or 10.00 (fixed)' },
    {
      key: 'discountScope',
      label: 'Applies to',
      type: 'select',
      defaultValue: 'first_period',
      options: [
        { label: 'First billing period only', value: 'first_period' },
        { label: 'Every renewal (recurring)', value: 'recurring' },
      ],
    },
    {
      key: 'applicablePlanIds',
      label: 'Applicable plan IDs (JSON array, empty = all plans)',
      type: 'json',
      placeholder: `["${plans[0]?.id ?? '<plan-id>'}"]`,
      helpText: 'Leave empty/null for "applies to all plans". Plan names: ' + plans.map((p) => `${p.name}=${p.id}`).join(', '),
    },
    { key: 'maxRedemptions', label: 'Max redemptions', type: 'number', placeholder: 'blank = unlimited' },
    { key: 'startsAt', label: 'Starts at (ISO date, optional)', type: 'text', placeholder: '2026-01-01T00:00:00Z' },
    { key: 'expiresAt', label: 'Expires at (ISO date, optional)', type: 'text', placeholder: '2026-12-31T23:59:59Z' },
  ];

  const columns: ColumnDef<PromoCodeRow>[] = [
    { key: 'code', label: 'Code' },
    {
      key: 'discountType',
      label: 'Discount',
      render: (row) => `${row.discountValue}${row.discountType === 'percent' ? '%' : ''} (${row.discountScope})`,
    },
    {
      key: 'applicablePlanIds',
      label: 'Plans',
      render: (row) => (row.applicablePlanIds?.length ? row.applicablePlanIds.map(planName).join(', ') : 'all plans'),
    },
    {
      key: 'redemptionsUsed',
      label: 'Redeemed',
      render: (row) => `${row.redemptionsUsed}${row.maxRedemptions != null ? ` / ${row.maxRedemptions}` : ''}`,
    },
    {
      key: 'active',
      label: 'Status',
      render: (row) => <Badge variant={row.active ? 'default' : 'outline'}>{row.active ? 'Active' : 'Inactive'}</Badge>,
    },
  ];

  return (
    <ResourceTable<PromoCodeRow>
      title="Promo Codes"
      description="Redeemed server-side at checkout — the discount is always recomputed from discount_type/discount_value, never trusted from the client. redemptions_used only increments once the webhook confirms payment, so an abandoned checkout doesn't burn a redemption."
      apiPath="/api/admin/promo-codes"
      fields={fields}
      columns={columns}
      activeField="active"
      emptyLabel="No promo codes yet."
    />
  );
}
