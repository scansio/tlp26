import { auth } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  RISK_PROFILE_EXPORT_SCHEMA_VERSION,
  riskProfileSchema,
  toResponse,
  upsertFullRiskProfile,
} from '../shared';

// ---------------------------------------------------------------------------
// Validation for the outer export-document envelope. The `profile` payload
// itself is validated against the existing `riskProfileSchema`.
// ---------------------------------------------------------------------------
const importDocumentSchema = z.object({
  schemaVersion: z.number(),
  exportedAt: z.string().optional(),
  profile: z.unknown(),
});

// ---------------------------------------------------------------------------
// POST /api/risk-profile/import
// Accepts a document previously produced by GET /api/risk-profile/export
// and upserts it as the authenticated user's risk profile. Every field in
// an import document is a caller-provided full profile, so this always
// overwrites all fields (unlike POST /api/risk-profile's settings-page
// partial-upsert semantics).
// ---------------------------------------------------------------------------
export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsedDocument = importDocumentSchema.safeParse(body);
  if (!parsedDocument.success) {
    return NextResponse.json(
      {
        error:
          'Invalid import document. Expected { schemaVersion, profile } produced by the export endpoint.',
        details: parsedDocument.error.flatten(),
      },
      { status: 400 },
    );
  }

  const { schemaVersion, profile } = parsedDocument.data;

  if (schemaVersion !== RISK_PROFILE_EXPORT_SCHEMA_VERSION) {
    return NextResponse.json(
      {
        error: `Unsupported schemaVersion "${schemaVersion}". This server can only import version ${RISK_PROFILE_EXPORT_SCHEMA_VERSION}.`,
      },
      { status: 400 },
    );
  }

  const parsedProfile = riskProfileSchema.safeParse(profile);
  if (!parsedProfile.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: parsedProfile.error.flatten() },
      { status: 422 },
    );
  }

  const upserted = await upsertFullRiskProfile(userId, parsedProfile.data);

  return NextResponse.json(
    {
      message: 'Risk profile imported successfully.',
      profile: toResponse(upserted),
    },
    { status: 200 },
  );
}
