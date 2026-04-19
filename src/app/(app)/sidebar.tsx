/**
 * Left sidebar with primary navigation.
 *
 * Client component: uses `usePathname` to highlight the active link.
 * Admin link is rendered only when the caller (the layout) has
 * determined the current role is admin.
 */
'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { cn } from '@/lib/shared/cn';
import type { AppRole } from '@/lib/auth/types';

interface NavItem {
  href: string;
  label: string;
  adminOnly?: boolean;
}

const NAV_ITEMS: readonly NavItem[] = [
  { href: '/', label: 'Home' },
  { href: '/candidates', label: 'Candidates' },
  { href: '/search/hybrid', label: 'Search' },
  { href: '/shortlists', label: 'Shortlists' },
  { href: '/admin', label: 'Admin', adminOnly: true },
];

export function Sidebar({ role }: { role: AppRole }): JSX.Element {
  const pathname = usePathname();

  return (
    <aside className="flex w-56 flex-col border-r border-border bg-surface px-4 py-6">
      <div className="mb-8 px-2">
        <p className="font-mono text-[10px] uppercase tracking-widest text-text-muted">VAIRIX</p>
        <p className="font-display text-sm font-semibold tracking-tight text-text-primary">
          Recruitment
        </p>
      </div>
      <nav className="flex flex-col gap-1">
        {NAV_ITEMS.filter((item) => !item.adminOnly || role === 'admin').map((item) => {
          const active = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'rounded-md px-3 py-2 text-sm font-medium transition-colors',
                active
                  ? 'bg-bg text-text-primary'
                  : 'text-text-muted hover:bg-bg hover:text-text-primary',
              )}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
