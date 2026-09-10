import { subscriptionPlans } from '@/db/schema';
import { createAdminItemRoute } from '@/lib/admin/crud-route';
import { subscriptionPlanUpdateSchema } from '@/lib/admin/billing-schemas';

// Admin-only (enforced in src/middleware.ts + requireAdmin() inside the handlers).
export const { PATCH, DELETE } = createAdminItemRoute({
  table: subscriptionPlans,
  idColumn: subscriptionPlans.id,
  updateSchema: subscriptionPlanUpdateSchema,
});
