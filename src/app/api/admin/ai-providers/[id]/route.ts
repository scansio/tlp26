import { aiProviders } from '@/db/schema';
import { createAdminItemRoute } from '@/lib/admin/crud-route';
import { aiProviderUpdateSchema } from '@/lib/admin/ai-catalog-schemas';

// Admin-only (enforced in src/middleware.ts + requireAdmin() inside the handlers).
export const { PATCH, DELETE } = createAdminItemRoute({
  table: aiProviders,
  idColumn: aiProviders.id,
  updateSchema: aiProviderUpdateSchema,
});
