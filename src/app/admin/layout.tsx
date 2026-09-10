import { auth } from '@clerk/nextjs/server';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { isAdminClaims } from '@/lib/admin/auth';

// Defense-in-depth: src/middleware.ts already 403/redirects non-admins away
// from /admin/*, but re-check here too in case the matcher config ever
// changes shape.
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const { sessionClaims } = await auth();
  if (!isAdminClaims(sessionClaims)) {
    redirect('/dashboard');
  }

  return (
    <div className="max-w-4xl mx-auto py-10 px-4 space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Admin</h1>
        <p className="text-muted-foreground mt-1">
          Platform configuration. Visible only to admins.
        </p>
      </div>

      <nav className="flex gap-2 border-b pb-2 flex-wrap">
        <Link
          href="/admin/ai-providers"
          className="rounded-md px-3 py-1.5 text-sm font-medium hover:bg-accent"
        >
          AI Providers
        </Link>
        <Link
          href="/admin/ai-models"
          className="rounded-md px-3 py-1.5 text-sm font-medium hover:bg-accent"
        >
          AI Models
        </Link>
      </nav>

      {children}
    </div>
  );
}
