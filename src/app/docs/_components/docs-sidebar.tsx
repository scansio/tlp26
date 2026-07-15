'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import {
  BookOpen,
  Layers,
  Bot,
  TrendingUp,
  Webhook,
} from 'lucide-react';

const NAV_ITEMS = [
  { href: '/docs/getting-started', label: 'Getting Started', icon: BookOpen },
  { href: '/docs/features', label: 'Features', icon: Layers },
  { href: '/docs/ai-agent', label: 'AI Agent', icon: Bot },
  { href: '/docs/strategy', label: 'Strategy', icon: TrendingUp },
  { href: '/docs/webhooks', label: 'TradingView', icon: Webhook },
];

export function DocsSidebar() {
  const pathname = usePathname();

  return (
    <>
      {/* Desktop sidebar */}
      <aside className="hidden lg:flex flex-col fixed top-0 left-0 h-screen w-56 border-r border-zinc-800 bg-zinc-950 z-40">
        <div className="flex items-center gap-2 px-5 py-5 border-b border-zinc-800">
          <Link href="/" className="text-sm font-semibold tracking-tight text-white hover:text-emerald-400 transition-colors">
            Trading Hub
          </Link>
          <span className="text-xs text-zinc-500 font-medium">/ Docs</span>
        </div>

        <nav className="flex-1 py-4 px-3 space-y-0.5">
          {NAV_ITEMS.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              className={cn(
                'flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition-colors',
                pathname === href || pathname.startsWith(href + '/')
                  ? 'bg-emerald-500/10 text-emerald-400 font-medium'
                  : 'text-zinc-400 hover:text-white hover:bg-zinc-800'
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {label}
            </Link>
          ))}
        </nav>

        <div className="p-4 border-t border-zinc-800">
          <Link
            href="/sign-up"
            className="block w-full rounded-full bg-emerald-500 hover:bg-emerald-400 text-black font-semibold text-sm px-4 py-2 text-center transition-colors"
          >
            Start for free →
          </Link>
        </div>
      </aside>

      {/* Mobile top nav */}
      <nav className="lg:hidden sticky top-0 z-40 bg-zinc-950 border-b border-zinc-800 px-4 py-3 flex items-center gap-1 overflow-x-auto scrollbar-none">
        <Link href="/" className="shrink-0 text-xs font-semibold text-zinc-500 mr-3 hover:text-white transition-colors">
          ← Home
        </Link>
        {NAV_ITEMS.map(({ href, label, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            className={cn(
              'shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-colors',
              pathname === href || pathname.startsWith(href + '/')
                ? 'bg-emerald-500/15 text-emerald-400'
                : 'text-zinc-400 hover:text-white hover:bg-zinc-800'
            )}
          >
            <Icon className="h-3 w-3" />
            {label}
          </Link>
        ))}
      </nav>
    </>
  );
}
