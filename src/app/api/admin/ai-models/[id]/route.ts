import { aiModels } from '@/db/schema';
import { createAdminItemRoute } from '@/lib/admin/crud-route';
import { aiModelUpdateSchema } from '@/lib/admin/ai-catalog-schemas';

// Admin-only (enforced in src/middleware.ts + requireAdmin() inside the handlers).
export const { PATCH, DELETE } = createAdminItemRoute({
  table: aiModels,
  idColumn: aiModels.id,
  updateSchema: aiModelUpdateSchema,
});
