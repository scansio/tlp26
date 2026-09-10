'use client';

import { useCallback, useEffect, useState } from 'react';
import { Loader2, Pencil, Plus, Trash2, AlertCircle } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';

// ---------------------------------------------------------------------------
// Generic admin resource CRUD shell.
//
// Renders a list + create/edit dialogs + delete (or active-toggle) for a
// single REST-ish resource backed by src/lib/admin/crud-route.ts. Built
// generically so Phase 5 can point it at subscription_plans,
// subscription_plan_prices, and promo_codes without a new UI per table —
// only `fields`/`columns`/`apiPath` change per resource.
// ---------------------------------------------------------------------------

export type FieldType = 'text' | 'number' | 'boolean' | 'select' | 'json';

export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  options?: { label: string; value: string }[]; // for type: 'select'
  placeholder?: string;
  helpText?: string;
  required?: boolean;
  /** Omit this field from the edit form (e.g. immutable FK set only on create). */
  createOnly?: boolean;
}

export interface ColumnDef<T> {
  key: string;
  label: string;
  render?: (row: T) => React.ReactNode;
}

export interface ResourceTableProps<T extends { id: string }> {
  title: string;
  description?: string;
  apiPath: string; // e.g. '/api/admin/ai-providers'
  fields: FieldDef[];
  columns: ColumnDef<T>[];
  /** If set, rows show a toggle bound to this boolean field instead of a Delete button. */
  activeField?: string;
  /** Extra per-row action rendered next to Edit/Delete (e.g. a "Run eval" stub button). */
  renderRowExtra?: (row: T) => React.ReactNode;
  emptyLabel?: string;
}

type FormValues = Record<string, string | number | boolean | null>;

function defaultFormValues(fields: FieldDef[]): FormValues {
  const values: FormValues = {};
  for (const f of fields) {
    values[f.key] = f.type === 'boolean' ? false : '';
  }
  return values;
}

function rowToFormValues(row: Record<string, unknown>, fields: FieldDef[]): FormValues {
  const values: FormValues = {};
  for (const f of fields) {
    const raw = row[f.key];
    if (f.type === 'boolean') {
      values[f.key] = Boolean(raw);
    } else if (f.type === 'json') {
      values[f.key] = raw == null ? '' : JSON.stringify(raw, null, 2);
    } else if (raw == null) {
      values[f.key] = '';
    } else {
      values[f.key] = raw as string | number;
    }
  }
  return values;
}

/** Converts form state back into a JSON-postable body, per field type. */
function formValuesToPayload(values: FormValues, fields: FieldDef[]): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const f of fields) {
    const v = values[f.key];
    if (f.type === 'number') {
      payload[f.key] = v === '' || v == null ? null : Number(v);
    } else if (f.type === 'json') {
      payload[f.key] = v === '' || v == null ? undefined : JSON.parse(String(v));
    } else if (f.type === 'boolean') {
      payload[f.key] = Boolean(v);
    } else {
      payload[f.key] = v === '' ? null : v;
    }
  }
  return payload;
}

function FieldInput({
  field,
  value,
  onChange,
}: {
  field: FieldDef;
  value: FormValues[string];
  onChange: (v: FormValues[string]) => void;
}) {
  if (field.type === 'boolean') {
    return (
      <div className="flex items-center justify-between rounded-md border px-3 py-2">
        <span className="text-sm">{field.label}</span>
        <Switch checked={Boolean(value)} onCheckedChange={(c) => onChange(c)} />
      </div>
    );
  }

  if (field.type === 'select') {
    return (
      <div className="space-y-2">
        <label className="text-sm font-medium">{field.label}</label>
        <select
          className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          value={(value as string) ?? ''}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">-- Select --</option>
          {field.options?.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>
    );
  }

  if (field.type === 'json') {
    return (
      <div className="space-y-2">
        <label className="text-sm font-medium">{field.label}</label>
        <textarea
          className="flex min-h-24 w-full rounded-md border border-input bg-background px-3 py-2 text-xs font-mono shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          placeholder={field.placeholder}
          value={(value as string) ?? ''}
          onChange={(e) => onChange(e.target.value)}
        />
        {field.helpText && <p className="text-xs text-muted-foreground">{field.helpText}</p>}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <label className="text-sm font-medium">{field.label}</label>
      <Input
        type={field.type === 'number' ? 'number' : 'text'}
        placeholder={field.placeholder}
        value={(value as string | number) ?? ''}
        onChange={(e) => onChange(e.target.value)}
      />
      {field.helpText && <p className="text-xs text-muted-foreground">{field.helpText}</p>}
    </div>
  );
}

export function ResourceTable<T extends { id: string }>({
  title,
  description,
  apiPath,
  fields,
  columns,
  activeField,
  renderRowExtra,
  emptyLabel = 'No rows yet.',
}: ResourceTableProps<T>) {
  const [rows, setRows] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);

  const [createOpen, setCreateOpen] = useState(false);
  const [createValues, setCreateValues] = useState<FormValues>(() => defaultFormValues(fields));
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');

  const [editTarget, setEditTarget] = useState<T | null>(null);
  const [editValues, setEditValues] = useState<FormValues>({});
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState('');

  const [removeTarget, setRemoveTarget] = useState<T | null>(null);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState('');

  const fetchRows = useCallback(async () => {
    try {
      const res = await fetch(apiPath);
      if (res.ok) {
        const json = await res.json();
        setRows(json.items ?? []);
      }
    } catch {
      // silently ignore — list just stays empty/stale
    } finally {
      setLoading(false);
    }
  }, [apiPath]);

  useEffect(() => {
    fetchRows();
  }, [fetchRows]);

  async function handleCreate() {
    setCreating(true);
    setCreateError('');
    try {
      const res = await fetch(apiPath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formValuesToPayload(createValues, fields)),
      });
      const json = await res.json();
      if (!res.ok) {
        setCreateError(json.error ?? 'Failed to create.');
        return;
      }
      setCreateOpen(false);
      setCreateValues(defaultFormValues(fields));
      await fetchRows();
    } catch {
      setCreateError('Network error. Please try again.');
    } finally {
      setCreating(false);
    }
  }

  function openEdit(row: T) {
    setEditTarget(row);
    setEditValues(rowToFormValues(row as Record<string, unknown>, fields));
    setEditError('');
  }

  async function handleSaveEdit() {
    if (!editTarget) return;
    setSaving(true);
    setEditError('');
    try {
      const res = await fetch(`${apiPath}/${editTarget.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formValuesToPayload(editValues, fields.filter((f) => !f.createOnly))),
      });
      const json = await res.json();
      if (!res.ok) {
        setEditError(json.error ?? 'Failed to save.');
        return;
      }
      setEditTarget(null);
      await fetchRows();
    } catch {
      setEditError('Network error. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  async function handleToggleActive(row: T) {
    if (!activeField) return;
    const current = (row as Record<string, unknown>)[activeField];
    try {
      const res = await fetch(`${apiPath}/${row.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [activeField]: !current }),
      });
      if (res.ok) await fetchRows();
    } catch {
      // silently ignore — toggle just won't reflect until next refresh
    }
  }

  async function handleRemove() {
    if (!removeTarget) return;
    setRemoving(true);
    setRemoveError('');
    try {
      const res = await fetch(`${apiPath}/${removeTarget.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const json = await res.json();
        setRemoveError(json.error ?? 'Failed to delete.');
        return;
      }
      setRemoveTarget(null);
      await fetchRows();
    } catch {
      setRemoveError('Network error. Please try again.');
    } finally {
      setRemoving(false);
    }
  }

  return (
    <Card className="p-6 space-y-4">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold">{title}</h2>
          {description && <p className="text-sm text-muted-foreground mt-0.5">{description}</p>}
        </div>

        <Dialog open={createOpen} onOpenChange={(open) => {
          setCreateOpen(open);
          if (!open) {
            setCreateValues(defaultFormValues(fields));
            setCreateError('');
          }
        }}>
          <DialogTrigger asChild>
            <Button size="sm">
              <Plus className="w-4 h-4 mr-2" />
              Add
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add {title.replace(/s$/, '')}</DialogTitle>
              <DialogDescription>Fill in the fields below to create a new row.</DialogDescription>
            </DialogHeader>

            <div className="space-y-4">
              {fields.map((f) => (
                <FieldInput
                  key={f.key}
                  field={f}
                  value={createValues[f.key]}
                  onChange={(v) => setCreateValues((prev) => ({ ...prev, [f.key]: v }))}
                />
              ))}
            </div>

            {createError && (
              <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                {createError}
              </div>
            )}

            <DialogFooter>
              <DialogClose asChild>
                <Button variant="outline" disabled={creating}>Cancel</Button>
              </DialogClose>
              <Button onClick={handleCreate} disabled={creating}>
                {creating ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                Create
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-10">
          <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
        </div>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground py-6 text-center">{emptyLabel}</p>
      ) : (
        <ul className="divide-y">
          {rows.map((row) => {
            const rowRecord = row as Record<string, unknown>;
            return (
            <li key={row.id} className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center">
              <div className="flex-1 min-w-0 flex flex-wrap gap-x-6 gap-y-1">
                {columns.map((col) => (
                  <div key={col.key} className="min-w-0">
                    <div className="text-xs text-muted-foreground">{col.label}</div>
                    <div className="text-sm font-medium truncate max-w-[16rem]">
                      {col.render ? col.render(row) : String(rowRecord[col.key] ?? '—')}
                    </div>
                  </div>
                ))}
              </div>

              <div className="flex items-center gap-2 shrink-0">
                {renderRowExtra?.(row)}

                {activeField && (
                  <div className="flex items-center gap-2">
                    <Badge variant={rowRecord[activeField] ? 'default' : 'outline'}>
                      {rowRecord[activeField] ? 'Active' : 'Inactive'}
                    </Badge>
                    <Switch
                      checked={Boolean(rowRecord[activeField])}
                      onCheckedChange={() => handleToggleActive(row)}
                    />
                  </div>
                )}

                <Button variant="outline" size="sm" onClick={() => openEdit(row)}>
                  <Pencil className="w-4 h-4" />
                  <span className="sr-only">Edit</span>
                </Button>

                {!activeField && (
                  <Dialog
                    open={removeTarget?.id === row.id}
                    onOpenChange={(open) => {
                      if (!open) {
                        setRemoveTarget(null);
                        setRemoveError('');
                      }
                    }}
                  >
                    <DialogTrigger asChild>
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-destructive hover:text-destructive hover:bg-destructive/10"
                        onClick={() => setRemoveTarget(row)}
                      >
                        <Trash2 className="w-4 h-4" />
                        <span className="sr-only">Delete</span>
                      </Button>
                    </DialogTrigger>
                    <DialogContent>
                      <DialogHeader>
                        <DialogTitle>Delete this row?</DialogTitle>
                        <DialogDescription>This action cannot be undone.</DialogDescription>
                      </DialogHeader>
                      {removeError && <p className="text-sm text-destructive">{removeError}</p>}
                      <DialogFooter>
                        <DialogClose asChild>
                          <Button variant="outline" disabled={removing}>Cancel</Button>
                        </DialogClose>
                        <Button variant="destructive" disabled={removing} onClick={handleRemove}>
                          {removing ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                          Delete
                        </Button>
                      </DialogFooter>
                    </DialogContent>
                  </Dialog>
                )}
              </div>
            </li>
          );
          })}
        </ul>
      )}

      {/* Edit dialog */}
      <Dialog open={editTarget !== null} onOpenChange={(open) => !open && setEditTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit {title.replace(/s$/, '')}</DialogTitle>
            <DialogDescription>Update the fields below and save.</DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {fields.filter((f) => !f.createOnly).map((f) => (
              <FieldInput
                key={f.key}
                field={f}
                value={editValues[f.key]}
                onChange={(v) => setEditValues((prev) => ({ ...prev, [f.key]: v }))}
              />
            ))}
          </div>

          {editError && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              {editError}
            </div>
          )}

          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" disabled={saving}>Cancel</Button>
            </DialogClose>
            <Button onClick={handleSaveEdit} disabled={saving}>
              {saving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
