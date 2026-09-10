import { aiModels } from '@/db/schema';
import { createAdminCollectionRoute } from '@/lib/admin/crud-route';
import { aiModelInsertSchema } from '@/lib/admin/ai-catalog-schemas';

// Admin-only (enforced in src/middleware.ts + requireAdmin() inside the handlers).
export const { GET, POST } = createAdminCollectionRoute({
  table: aiModels,
  insertSchema: aiModelInsertSchema,
  orderBy: aiModels.modelId,
});
