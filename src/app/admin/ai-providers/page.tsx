'use client';

import { Badge } from '@/components/ui/badge';
import { ResourceTable, type FieldDef, type ColumnDef } from '@/components/admin/resource-table';

interface AiProviderRow {
  id: string;
  name: string;
  byokEligible: boolean;
  platformPooledKeyAvailable: boolean;
  createdAt: string | null;
}

const fields: FieldDef[] = [
  { key: 'name', label: 'Name', type: 'text', placeholder: 'e.g. Anthropic', required: true },
  { key: 'byokEligible', label: 'BYOK eligible', type: 'boolean' },
  { key: 'platformPooledKeyAvailable', label: 'Platform pooled key available', type: 'boolean' },
];

const columns: ColumnDef<AiProviderRow>[] = [
  { key: 'name', label: 'Provider' },
  {
    key: 'byokEligible',
    label: 'BYOK',
    render: (row) => (
      <Badge variant={row.byokEligible ? 'default' : 'outline'}>
        {row.byokEligible ? 'Eligible' : 'Not eligible'}
      </Badge>
    ),
  },
  {
    key: 'platformPooledKeyAvailable',
    label: 'Pooled key',
    render: (row) => (
      <Badge variant={row.platformPooledKeyAvailable ? 'default' : 'outline'}>
        {row.platformPooledKeyAvailable ? 'Available' : 'None'}
      </Badge>
    ),
  },
];

export default function AiProvidersPage() {
  return (
    <ResourceTable<AiProviderRow>
      title="AI Providers"
      description="Providers available to the Mastra model gateway. Models are configured separately under AI Models."
      apiPath="/api/admin/ai-providers"
      fields={fields}
      columns={columns}
      emptyLabel="No providers yet. Add one to get started."
    />
  );
}
