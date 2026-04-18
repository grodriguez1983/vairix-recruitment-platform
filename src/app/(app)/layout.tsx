/**
 * Authenticated shell layout.
 *
 * Everything under the `(app)` route group shares this layout.
 * `requireAuth()` runs once here; pages inside the group can assume
 * a valid session. Role gating (admin-only) still happens per-page
 * via `requireRole('admin')`.
 */
import type { ReactNode } from 'react';

import { requireAuth } from '@/lib/auth/require';

import { Header } from './header';
import { Sidebar } from './sidebar';

export default async function AppLayout({
  children,
}: {
  children: ReactNode;
}): Promise<JSX.Element> {
  const auth = await requireAuth();

  return (
    <div className="flex min-h-screen">
      <Sidebar role={auth.role} />
      <div className="flex min-h-screen flex-1 flex-col">
        <Header email={auth.email} role={auth.role} />
        <main className="flex-1 px-8 py-8">{children}</main>
      </div>
    </div>
  );
}
