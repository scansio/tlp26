'use client';

import Link from 'next/link';
import Image from 'next/image';
import { usePathname } from 'next/navigation';
import { UserButton } from '@clerk/nextjs';
import {
  LayoutDashboard,
  Zap,
  Clock,
  History,
  MessageSquare,
  BarChart2,
  Calculator,
  Users,
  Star,
  Shield,
  Link2,
  ChevronRight,
  Activity,
  TrendingUp,
} from 'lucide-react';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from '@/components/ui/sidebar';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';

const navMain = [
  {
    title: 'Dashboard',
    href: '/dashboard',
    icon: LayoutDashboard,
  },
  {
    title: 'Signals',
    href: '/signals',
    icon: Zap,
    tourId: 'nav-signals',
  },
  {
    title: 'Trade',
    icon: Activity,
    children: [
      { title: 'Open Positions', href: '/trade/positions', icon: TrendingUp },
      { title: 'Signal Queue', href: '/trade/signals', icon: Clock },
      { title: 'History', href: '/trade/history', icon: History },
    ],
  },
  {
    title: 'AI Chat',
    href: '/chat',
    icon: MessageSquare,
    tourId: 'nav-chat',
  },
  {
    title: 'Backtest',
    href: '/backtest',
    icon: BarChart2,
  },
  {
    title: 'Risk Calculator',
    href: '/risk-calculator',
    icon: Calculator,
  },
];

const navCopy = [
  { title: 'Browse Publishers', href: '/copy', icon: Users },
  { title: 'My Subscriptions', href: '/copy/subscriptions', icon: Star },
  { title: 'Publisher Dashboard', href: '/copy/publisher', icon: TrendingUp },
];

const navProfile = [
  { title: 'Risk Profile', href: '/profile/risk', icon: Shield },
  { title: 'Exchanges', href: '/profile/exchanges', icon: Link2 },
];

function NavItem({
  item,
  pathname,
}: {
  item: (typeof navMain)[number];
  pathname: string;
}) {
  if ('children' in item && item.children) {
    const isOpen = item.children.some((c) => pathname === c.href || pathname.startsWith(c.href + '/'));
    return (
      <Collapsible defaultOpen={isOpen} className="group/collapsible">
        <SidebarMenuItem data-tour={'tourId' in item ? item.tourId : undefined}>
          <CollapsibleTrigger asChild>
            <SidebarMenuButton tooltip={item.title}>
              <item.icon className="size-4" />
              <span>{item.title}</span>
              <ChevronRight className="ml-auto size-3.5 transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90" />
            </SidebarMenuButton>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <SidebarMenuSub>
              {item.children.map((child) => {
                const active = pathname === child.href || pathname.startsWith(child.href + '/');
                return (
                  <SidebarMenuSubItem key={child.href}>
                    <SidebarMenuSubButton asChild isActive={active}>
                      <Link href={child.href}>
                        <child.icon className="size-3.5" />
                        <span>{child.title}</span>
                      </Link>
                    </SidebarMenuSubButton>
                  </SidebarMenuSubItem>
                );
              })}
            </SidebarMenuSub>
          </CollapsibleContent>
        </SidebarMenuItem>
      </Collapsible>
    );
  }

  const active = pathname === item.href || (item.href !== '/dashboard' && pathname.startsWith(item.href + '/'));
  return (
    <SidebarMenuItem data-tour={'tourId' in item ? item.tourId : undefined}>
      <SidebarMenuButton asChild isActive={active} tooltip={item.title}>
        <Link href={item.href!}>
          <item.icon className="size-4" />
          <span>{item.title}</span>
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

export function AppSidebar() {
  const pathname = usePathname();

  return (
    <Sidebar collapsible="icon">
      {/* Brand */}
      <SidebarHeader data-tour="sidebar-brand">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <Link href="/dashboard">
                <Image
                  src="/icon.svg"
                  width={28}
                  height={28}
                  alt="TLP26"
                  className="shrink-0 rounded-md"
                  priority
                />
                <span className="font-bold text-sm tracking-tight group-data-[collapsible=icon]:hidden">
                  TLP26
                </span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        {/* Main nav */}
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {navMain.map((item) => (
                <NavItem key={item.title} item={item} pathname={pathname} />
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {/* Copy Trading */}
        <SidebarGroup>
          <SidebarGroupLabel>Copy Trading</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {navCopy.map((item) => {
                const active = pathname === item.href || pathname.startsWith(item.href + '/');
                return (
                  <SidebarMenuItem key={item.href}>
                    <SidebarMenuButton asChild isActive={active} tooltip={item.title}>
                      <Link href={item.href}>
                        <item.icon className="size-4" />
                        <span>{item.title}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {/* Profile */}
        <SidebarGroup>
          <SidebarGroupLabel>Settings</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {navProfile.map((item) => {
                const active = pathname === item.href || pathname.startsWith(item.href + '/');
                return (
                  <SidebarMenuItem key={item.href}>
                    <SidebarMenuButton asChild isActive={active} tooltip={item.title}>
                      <Link href={item.href}>
                        <item.icon className="size-4" />
                        <span>{item.title}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      {/* User */}
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <div className={cn('flex items-center gap-2 px-2 py-1.5')}>
              <UserButton
                appearance={{
                  elements: {
                    avatarBox: 'size-8',
                  },
                }}
              />
              <span className="text-sm font-medium group-data-[collapsible=icon]:hidden">
                Account
              </span>
            </div>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
