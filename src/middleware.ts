import { NextResponse } from 'next/server';
import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';
import { isAdminClaims } from '@/lib/admin/auth';

const isAdminRoute = createRouteMatcher(['/admin(.*)', '/api/admin(.*)']);

const isPublicRoute = createRouteMatcher([
  '/',
  '/docs(.*)',
  '/sign-in(.*)',
  '/sign-up(.*)',
  '/copy/leaderboard',
  '/api/copy/leaderboard',
  '/api/webhooks/tradingview',
  '/api/webhooks/telegram',
  '/api/webhooks/oxapay',
  '/api/webhooks/stripe',
  '/api/webhooks/paystack',
  '/api/auth/webhook',
  // Public API for publisher profiles (no auth needed for read)
  '/api/copy/publishers/(.*)',
  // Cron routes are authenticated via CRON_SECRET header, not Clerk session
  '/api/cron/(.*)',
]);

export default clerkMiddleware(async (auth, request) => {
  const { pathname } = request.nextUrl;

  // /copy/publisher is a protected Clerk-auth page.
  // /copy/<any-other-path> is the public publisher profile — allow without auth.
  const isPublicCopyProfile =
    pathname.startsWith('/copy/') && pathname !== '/copy/publisher';

  if (!isPublicRoute(request) && !isPublicCopyProfile) {
    await auth.protect();
  }

  // /admin/* and /api/admin/* — require the Clerk publicMetadata.admin flag,
  // server-side. Non-admins are redirected (pages) or 403'd (API routes)
  // here in middleware, not just hidden in the UI.
  if (isAdminRoute(request)) {
    const { sessionClaims } = await auth();
    if (!isAdminClaims(sessionClaims)) {
      if (pathname.startsWith('/api/')) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
      return NextResponse.redirect(new URL('/dashboard', request.url));
    }
  }
});

export const config = {
  matcher: [
    // Skip Next.js internals and all static files, unless found in search params
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    // Always run for API routes
    '/(api|trpc)(.*)',
    '/__clerk/:path*',
  ],
};
