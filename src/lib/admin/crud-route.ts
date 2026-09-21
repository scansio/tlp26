import { NextResponse } from 'next/server';
import { eq, asc, type AnyColumn } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { ZodError, type ZodType } from 'zod';
import { db } from '@/db';
import { requireAdmin } from './auth';

// ---------------------------------------------------------------------------
// Generic admin CRUD route factory.
//
// Builds the list/create handlers (for `/api/admin/<resource>/route.ts`) and
// update/delete handlers (for `/api/admin/<resource>/[id]/route.ts`) for a
// single Drizzle table. Every handler enforces the admin flag first.
//
// This is intentionally generic across resource shape (not just ai_providers
// / ai_models) so Phase 5 can reuse it for subscription_plans,
// subscription_plan_prices, and promo_codes without copy-pasting the
// boilerplate — but it does NOT try to guess relationships, joins, or
// pagination; callers needing those add a bit of custom logic around it.
//
// Drizzle's PgTable generics are deliberately erased to `any` here: modeling
// a fully generic "any Postgres table" function in Drizzle's type system
// fights the type-checker for no real safety benefit (the actual shape
// checking happens at the call site's Zod schema, and Drizzle still
// validates column names/types at runtime against the real table).
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyPgTable = PgTable<any>;

interface CollectionRouteOptions {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  table: any;
  /** Validates the request body for POST (create). */
  insertSchema: ZodType;
  /** Column to sort the list by (defaults to insertion order if omitted). */
  orderBy?: AnyColumn;
}

interface ItemRouteOptions {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  table: any;
  idColumn: AnyColumn;
  /** Validates the request body for PATCH (partial update). */
  updateSchema: ZodType;
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

function isForeignKeyViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23503';
}

/** Builds `{ GET, POST }` for a resource's collection route. */
export function createAdminCollectionRoute({ table, insertSchema, orderBy }: CollectionRouteOptions) {
  const anyTable = table as AnyPgTable;

  async function GET() {
    const admin = await requireAdmin();
    if (!admin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    const query = db.select().from(anyTable);
    const rows = orderBy ? await query.orderBy(asc(orderBy)) : await query;
    return NextResponse.json({ items: rows });
  }

  async function POST(req: Request) {
    const admin = await requireAdmin();
    if (!admin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    try {
      const body = await req.json();
      const parsed = insertSchema.parse(body) as Record<string, unknown>;
      const [created] = await db.insert(anyTable).values(parsed).returning();
      return NextResponse.json({ item: created }, { status: 201 });
    } catch (err) {
      if (err instanceof ZodError) {
        return NextResponse.json({ error: 'Invalid input', issues: err.issues }, { status: 400 });
      }
      if (isUniqueViolation(err)) {
        return NextResponse.json({ error: 'A row with these unique fields already exists' }, { status: 409 });
      }
      if (isForeignKeyViolation(err)) {
        return NextResponse.json({ error: 'Referenced row does not exist' }, { status: 409 });
      }
      console.error('[admin-crud] create failed', err);
      return NextResponse.json({ error: 'Failed to create row' }, { status: 500 });
    }
  }

  return { GET, POST };
}

/** Builds `{ PATCH, DELETE }` for a resource's `/[id]` item route. */
export function createAdminItemRoute({ table, idColumn, updateSchema }: ItemRouteOptions) {
  const anyTable = table as AnyPgTable;

  async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
    const admin = await requireAdmin();
    if (!admin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    const { id } = await params;
    try {
      const body = await req.json();
      const parsed = updateSchema.parse(body) as Record<string, unknown>;
      if (Object.keys(parsed).length === 0) {
        return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
      }
      const [updated] = await db
        .update(anyTable)
        .set({ ...parsed, updatedAt: new Date() })
        .where(eq(idColumn, id))
        .returning();
      if (!updated) {
        return NextResponse.json({ error: 'Not found' }, { status: 404 });
      }
      return NextResponse.json({ item: updated });
    } catch (err) {
      if (err instanceof ZodError) {
        return NextResponse.json({ error: 'Invalid input', issues: err.issues }, { status: 400 });
      }
      if (isUniqueViolation(err)) {
        return NextResponse.json({ error: 'A row with these unique fields already exists' }, { status: 409 });
      }
      if (isForeignKeyViolation(err)) {
        return NextResponse.json({ error: 'Referenced row does not exist' }, { status: 409 });
      }
      console.error('[admin-crud] update failed', err);
      return NextResponse.json({ error: 'Failed to update row' }, { status: 500 });
    }
  }

  async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
    const admin = await requireAdmin();
    if (!admin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    const { id } = await params;
    try {
      const [deleted] = await db.delete(anyTable).where(eq(idColumn, id)).returning();
      if (!deleted) {
        return NextResponse.json({ error: 'Not found' }, { status: 404 });
      }
      return NextResponse.json({ deleted: true, id });
    } catch (err) {
      if (isForeignKeyViolation(err)) {
        return NextResponse.json(
          { error: 'Cannot delete: other rows still reference this one' },
          { status: 409 },
        );
      }
      console.error('[admin-crud] delete failed', err);
      return NextResponse.json({ error: 'Failed to delete row' }, { status: 500 });
    }
  }

  return { PATCH, DELETE };
}
