import { auth } from '@clerk/nextjs/server';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import { AppSidebar } from '@/components/app-sidebar';
import { Separator } from '@/components/ui/separator';
import { SpotlightTour } from '@/components/tour/spotlight-tour';
import { ThemeToggle } from '@/components/theme-toggle';
import { db } from '@/db';
import { userRiskProfiles } from '@/db/schema';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { userId } = await auth();

  if (userId) {
    const cookieStore = await cookies();
    const skipped = cookieStore.get('onboarding_skipped')?.value === '1';

    if (!skipped) {
      const [profile] = await db
        .select({ isActive: userRiskProfiles.isActive })
        .from(userRiskProfiles)
        .where(eq(userRiskProfiles.userId, userId))
        .limit(1);

      if (!profile || !profile.isActive) {
        redirect('/onboarding');
      }
    }
  }

  return (
    <SidebarProvider>
      <AppSidebar />
      <SpotlightTour />
      <SidebarInset className="min-w-0">
        <header className="flex min-h-14 md:min-h-0 md:h-12 shrink-0 items-center gap-2 border-b px-3 pt-[env(safe-area-inset-top)] md:px-4 md:pt-0">
          <SidebarTrigger className="-ml-1 size-11 md:size-8" />
          <Separator orientation="vertical" className="mr-1 h-4 md:mr-2" />
          <div className="ml-auto">
            <ThemeToggle />
          </div>
        </header>
        <main className="flex-1 min-w-0 overflow-auto pb-[env(safe-area-inset-bottom)]">
          {children}
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
