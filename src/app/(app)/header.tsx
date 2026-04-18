/**
 * Top header for the authenticated shell. Shows the current user's
 * email and role, plus theme toggle and sign-out. Server component —
 * no hooks. The theme toggle is a client leaf.
 */
import { ThemeToggle } from '../theme-toggle';

import type { AppRole } from '@/lib/auth/types';

export function Header({ email, role }: { email: string; role: AppRole }): JSX.Element {
  return (
    <header className="flex h-14 items-center justify-between border-b border-border bg-surface px-8">
      <div className="flex items-baseline gap-3">
        <span className="text-sm text-text-primary">{email}</span>
        <span className="font-mono text-[10px] uppercase tracking-widest text-text-muted">
          {role}
        </span>
      </div>
      <div className="flex items-center gap-3">
        <ThemeToggle />
        <form action="/logout" method="post">
          <button
            type="submit"
            className="inline-flex h-8 items-center justify-center rounded-md border border-border px-3 text-xs font-medium text-text-muted transition-colors hover:text-text-primary"
          >
            Sign out
          </button>
        </form>
      </div>
    </header>
  );
}
