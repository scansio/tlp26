import { z } from 'zod';

// ---------------------------------------------------------------------------
// Validation schemas for the ai_providers / ai_models admin CRUD routes.
// ---------------------------------------------------------------------------

export const aiProviderInsertSchema = z.object({
  name: z.string().min(1).max(100),
  byokEligible: z.boolean().optional(),
  platformPooledKeyAvailable: z.boolean().optional(),
});

export const aiProviderUpdateSchema = aiProviderInsertSchema.partial();

export const aiModelCapabilitiesSchema = z.object({
  toolCalling: z.boolean(),
  structuredOutput: z.boolean(),
  streaming: z.boolean(),
});

export const aiModelInsertSchema = z.object({
  providerId: z.uuid(),
  modelId: z.string().min(1),
  status: z.enum(['active', 'beta', 'deprecated']).optional(),
  gateway: z.string().min(1),
  contextMax: z.number().int().positive().optional().nullable(),
  capabilities: aiModelCapabilitiesSchema.optional(),
  // Stored as a Postgres `numeric`, which drizzle-orm reads/writes as a string.
  evalScore: z
    .number()
    .min(0)
    .max(9999.99)
    .nullable()
    .optional()
    .transform((v) => (v == null ? v : v.toFixed(2))),
  evalRunId: z.string().optional().nullable(),
  byokEligible: z.boolean().optional(),
});

export const aiModelUpdateSchema = aiModelInsertSchema.partial();
