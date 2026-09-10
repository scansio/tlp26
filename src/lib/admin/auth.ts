import { auth } from '@clerk/nextjs/server';

// ---------------------------------------------------------------------------
// Admin authorization
//
// Design decision: admin access is gated by a single Clerk
// `publicMetadata.admin === true` flag, checked server-side, all-or-nothing
// (no scoped/read-only-reviewer roles). Set via the Clerk Dashboard
// (Users > [user] > Metadata > Public) or the Backend API, e.g.:
//   clerkClient.users.updateUserMetadata(userId, { publicMetadata: { admin: true } })
//
// IMPORTANT: `sessionClaims.publicMetadata` is only populated if the Clerk
// Dashboard session token has been customized (Configure > Sessions >
// Customize session token) to add a claim `publicMetadata` ->
// `{{user.public_metadata}}`. This is a one-time dashboard config step, not
// something this codebase can set — see the PR description.
// ---------------------------------------------------------------------------

type SessionClaims = Awaited<ReturnType<typeof auth>>['sessionClaims'];

/** Pure helper — checks the admin flag on already-resolved session claims. */
export function isAdminClaims(sessionClaims: SessionClaims | null | undefined): boolean {
  if (!sessionClaims) return false;
  const claims = sessionClaims as {
    publicMetadata?: { admin?: boolean };
    metadata?: { admin?: boolean };
  };
  return claims.publicMetadata?.admin === true || claims.metadata?.admin === true;
}

/**
 * Server-side admin guard for API routes. Mirrors the `auth().userId` check
 * used elsewhere in `src/app/api/**`, plus the admin flag.
 * Returns `{ userId }` when the caller is a signed-in admin, otherwise `null`.
 */
export async function requireAdmin(): Promise<{ userId: string } | null> {
  const { userId, sessionClaims } = await auth();
  if (!userId || !isAdminClaims(sessionClaims)) {
    return null;
  }
  return { userId };
}
