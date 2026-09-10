import { subscriptionPlans } from '@/db/schema';
import { createAdminCollectionRoute } from '@/lib/admin/crud-route';
import { subscriptionPlanInsertSchema } from '@/lib/admin/billing-schemas';

// Admin-only (enforced in src/middleware.ts + requireAdmin() inside the handlers).
export const { GET, POST } = createAdminCollectionRoute({
  table: subscriptionPlans,
  insertSchema: subscriptionPlanInsertSchema,
  orderBy: subscriptionPlans.name,
});
