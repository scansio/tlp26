import { promoCodes } from '@/db/schema';
import { createAdminItemRoute } from '@/lib/admin/crud-route';
import { promoCodeUpdateSchema } from '@/lib/admin/billing-schemas';

// Admin-only (enforced in src/middleware.ts + requireAdmin() inside the handlers).
export const { PATCH, DELETE } = createAdminItemRoute({
  table: promoCodes,
  idColumn: promoCodes.id,
  updateSchema: promoCodeUpdateSchema,
});
