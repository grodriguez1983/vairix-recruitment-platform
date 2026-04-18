/**
 * Admin landing — stub. Role-gated via `requireRole('admin')`; a
 * recruiter hitting this URL is redirected to /403 by the helper.
 * User management, sync controls, and audit views land in F2+.
 */
import { requireRole } from '@/lib/auth/require';

export const metadata = {
  title: 'Admin — Recruitment Data Platform',
};

export default async function AdminPage(): Promise<JSX.Element> {
  await requireRole('admin');

  return (
    <div className="mx-auto max-w-4xl">
      <header className="mb-8">
        <h1 className="font-display text-2xl font-semibold tracking-tighter text-text-primary">
          Admin
        </h1>
        <p className="mt-1 text-sm text-text-muted">
          User management, sync controls and audit views land in F2+.
        </p>
      </header>
      <section className="rounded-lg border border-border border-dashed bg-surface p-6">
        <p className="text-sm text-text-muted">Nothing wired up yet.</p>
      </section>
    </div>
  );
}
