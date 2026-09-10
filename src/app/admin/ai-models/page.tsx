'use client';

import { useEffect, useMemo, useState } from 'react';
import { FlaskConical } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ResourceTable, type FieldDef, type ColumnDef } from '@/components/admin/resource-table';

interface AiProviderRow {
  id: string;
  name: string;
}

interface AiModelRow {
  id: string;
  providerId: string;
  modelId: string;
  status: 'active' | 'beta' | 'deprecated';
  gateway: string;
  contextMax: number | null;
  capabilities: { toolCalling: boolean; structuredOutput: boolean; streaming: boolean } | null;
  evalScore: string | null;
  evalRunId: string | null;
  byokEligible: boolean;
}

const STATUS_VARIANT: Record<AiModelRow['status'], 'default' | 'outline' | 'destructive'> = {
  active: 'default',
  beta: 'outline',
  deprecated: 'destructive',
};

function handleRunEval(row: AiModelRow) {
  // TODO(phase-later): wire this up to the hackathon eval harness in `eval/`
  // (see HACKATHON.md) — kick off a run for this model and persist
  // eval_score / eval_run_id back onto this row. Stub only for now.
  console.log('Run eval requested for model', row.modelId);
}

export default function AiModelsPage() {
  const [providers, setProviders] = useState<AiProviderRow[]>([]);

  useEffect(() => {
    fetch('/api/admin/ai-providers')
      .then((res) => (res.ok ? res.json() : { items: [] }))
      .then((json) => setProviders(json.items ?? []))
      .catch(() => setProviders([]));
  }, []);

  const providerName = useMemo(() => {
    const map = new Map(providers.map((p) => [p.id, p.name]));
    return (id: string) => map.get(id) ?? id;
  }, [providers]);

  const fields: FieldDef[] = useMemo(
    () => [
      {
        key: 'providerId',
        label: 'Provider',
        type: 'select',
        required: true,
        options: providers.map((p) => ({ label: p.name, value: p.id })),
      },
      { key: 'modelId', label: 'Model ID', type: 'text', placeholder: 'e.g. anthropic/claude-sonnet-4-5', required: true },
      {
        key: 'status',
        label: 'Status',
        type: 'select',
        defaultValue: 'active',
        options: [
          { label: 'Active', value: 'active' },
          { label: 'Beta', value: 'beta' },
          { label: 'Deprecated', value: 'deprecated' },
        ],
      },
      { key: 'gateway', label: 'Gateway', type: 'text', placeholder: 'models-dev, or a custom gateway id' },
      { key: 'contextMax', label: 'Context max (tokens)', type: 'number', placeholder: 'e.g. 200000' },
      {
        key: 'capabilities',
        label: 'Capabilities (JSON)',
        type: 'json',
        placeholder: '{ "toolCalling": true, "structuredOutput": true, "streaming": true }',
        helpText: 'toolCalling / structuredOutput / streaming booleans.',
      },
      { key: 'evalScore', label: 'Eval score', type: 'number', helpText: 'From the eval harness (eval/) — set manually until wired up.' },
      { key: 'evalRunId', label: 'Eval run ID', type: 'text' },
      { key: 'byokEligible', label: 'BYOK eligible', type: 'boolean' },
    ],
    [providers],
  );

  const columns: ColumnDef<AiModelRow>[] = [
    { key: 'modelId', label: 'Model' },
    { key: 'providerId', label: 'Provider', render: (row) => providerName(row.providerId) },
    {
      key: 'status',
      label: 'Status',
      render: (row) => <Badge variant={STATUS_VARIANT[row.status]}>{row.status}</Badge>,
    },
    { key: 'gateway', label: 'Gateway' },
    {
      key: 'evalScore',
      label: 'Eval score',
      render: (row) => (row.evalScore != null ? row.evalScore : '—'),
    },
  ];

  return (
    <ResourceTable<AiModelRow>
      title="AI Models"
      description="Model allowlist per provider. Status controls whether an agent may select this model."
      apiPath="/api/admin/ai-models"
      fields={fields}
      columns={columns}
      emptyLabel="No models yet. Add a provider first, then add models here."
      renderRowExtra={(row) => (
        <Button variant="outline" size="sm" onClick={() => handleRunEval(row)} title="Stub — not yet wired to the eval harness">
          <FlaskConical className="w-4 h-4 mr-1.5" />
          Run eval
        </Button>
      )}
    />
  );
}
