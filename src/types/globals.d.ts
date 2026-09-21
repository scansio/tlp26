export {};

// ---------------------------------------------------------------------------
// Clerk custom session token claims.
//
// NOTE: Clerk does NOT include `publicMetadata` in the session JWT by default.
// For `sessionClaims.publicMetadata` to be populated at runtime, the Clerk
// Dashboard session token must be customized (Configure > Sessions >
// Customize session token) to add a claim named `publicMetadata` with value
// `{{user.public_metadata}}`. See src/lib/admin/auth.ts for the runtime check
// and the PR description for this as a manual/ops blocker.
// ---------------------------------------------------------------------------
declare global {
  interface CustomJwtSessionClaims {
    publicMetadata?: {
      admin?: boolean;
      [key: string]: unknown;
    };
    // Some Clerk setups name the custom claim "metadata" instead of
    // "publicMetadata" (Clerk's own RBAC guide uses this name) — checked as
    // a fallback so this works either way once the dashboard claim exists.
    metadata?: {
      admin?: boolean;
      [key: string]: unknown;
    };
  }
}
