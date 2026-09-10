'use client';

import { Badge } from '@/components/ui/badge';
import { ResourceTable, type FieldDef, type ColumnDef } from '@/components/admin/resource-table';

interface SubscriptionPlanRow {
  id: string;
  name: string;
  autoTradeRunsPerDay: number;
  chatMessagesPerDay: number;
  allowsByok: boolean;
  allowsPersonalizedMemory: boolean;
  jobPriority: number;
  active: boolean;
}

const fields: FieldDef[] = [
  { key: 'name', label: 'Name', type: 'text', placeholder: 'e.g. free, pro, byok', required: true },
  { key: 'autoTradeRunsPerDay', label: 'Auto-trade runs / day', type: 'number', defaultValue: 3 },
  { key: 'chatMessagesPerDay', label: 'Chat messages / day', type: 'number', defaultValue: 15 },
  { key: 'allowsByok', label: 'Allows BYOK', type: 'boolean' },
  { key: 'allowsPersonalizedMemory', label: 'Allows personalized memory', type: 'boolean' },
  {
    key: 'jobPriority',
    label: 'Worker job priority',
    type: 'number',
    defaultValue: 0,
    helpText: 'Higher wins auto_trade_jobs claim ordering (ORDER BY priority DESC).',
  },
];

const columns: ColumnDef<SubscriptionPlanRow>[] = [
  { key: 'name', label: 'Plan' },
  { key: 'autoTradeRunsPerDay', label: 'Auto-trade/day' },
  { key: 'chatMessagesPerDay', label: 'Chat/day' },
  { key: 'jobPriority', label: 'Priority' },
  {
    key: 'allowsByok',
    label: 'BYOK',
    render: (row) => <Badge variant={row.allowsByok ? 'default' : 'outline'}>{row.allowsByok ? 'Yes' : 'No'}</Badge>,
  },
];

export default function SubscriptionPlansPage() {
  return (
    <ResourceTable<SubscriptionPlanRow>
      title="Subscription Plans"
      description="Plan tiers ('free', 'pro', 'byok', ...) and their usage caps. A plan is never deleted once real subscribers reference it — use Active to soft-disable instead."
      apiPath="/api/admin/subscription-plans"
      fields={fields}
      columns={columns}
      activeField="active"
      emptyLabel="No plans yet. Add 'free' first — it's the fallback for any user without an active subscription."
    />
  );
}
