import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';

const isPublicRoute = createRouteMatcher([
  '/',
  '/sign-in(.*)',
  '/sign-up(.*)',
  '/copy/leaderboard',
  '/api/copy/leaderboard',
  '/api/webhooks/tradingview',
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
});

export const config = {
  matcher: [
    // Skip Next.js internals and all static files, unless found in search params
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    // Always run for API routes
    '/(api|trpc)(.*)',
  ],
};
