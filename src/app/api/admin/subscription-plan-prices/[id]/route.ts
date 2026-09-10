import { subscriptionPlanPrices } from '@/db/schema';
import { createAdminItemRoute } from '@/lib/admin/crud-route';
import { subscriptionPlanPriceUpdateSchema } from '@/lib/admin/billing-schemas';

// Admin-only (enforced in src/middleware.ts + requireAdmin() inside the handlers).
export const { PATCH, DELETE } = createAdminItemRoute({
  table: subscriptionPlanPrices,
  idColumn: subscriptionPlanPrices.id,
  updateSchema: subscriptionPlanPriceUpdateSchema,
});
