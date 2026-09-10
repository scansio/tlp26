import { subscriptionPlanPrices } from '@/db/schema';
import { createAdminCollectionRoute } from '@/lib/admin/crud-route';
import { subscriptionPlanPriceInsertSchema } from '@/lib/admin/billing-schemas';

// Admin-only (enforced in src/middleware.ts + requireAdmin() inside the handlers).
export const { GET, POST } = createAdminCollectionRoute({
  table: subscriptionPlanPrices,
  insertSchema: subscriptionPlanPriceInsertSchema,
  orderBy: subscriptionPlanPrices.planId,
});
