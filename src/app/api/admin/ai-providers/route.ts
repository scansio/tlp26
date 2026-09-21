import { aiProviders } from '@/db/schema';
import { createAdminCollectionRoute } from '@/lib/admin/crud-route';
import { aiProviderInsertSchema } from '@/lib/admin/ai-catalog-schemas';

// Admin-only (enforced in src/middleware.ts + requireAdmin() inside the handlers).
export const { GET, POST } = createAdminCollectionRoute({
  table: aiProviders,
  insertSchema: aiProviderInsertSchema,
  orderBy: aiProviders.name,
});
