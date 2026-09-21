import { promoCodes } from '@/db/schema';
import { createAdminCollectionRoute } from '@/lib/admin/crud-route';
import { promoCodeInsertSchema } from '@/lib/admin/billing-schemas';

// Admin-only (enforced in src/middleware.ts + requireAdmin() inside the handlers).
export const { GET, POST } = createAdminCollectionRoute({
  table: promoCodes,
  insertSchema: promoCodeInsertSchema,
  orderBy: promoCodes.code,
});
