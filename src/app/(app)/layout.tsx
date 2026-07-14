import { auth } from '@clerk/nextjs/server';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import { AppSidebar } from '@/components/app-sidebar';
import { Separator } from '@/components/ui/separator';
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
      <SidebarInset>
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-2 h-4" />
        </header>
        <main className="flex-1 overflow-auto">
          {children}
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
