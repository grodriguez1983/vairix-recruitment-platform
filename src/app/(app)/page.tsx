/**
 * Home / landing inside the authenticated shell.
 *
 * The shell (sidebar, header, sign-out, theme toggle) is provided by
 * `(app)/layout.tsx`, which also runs `requireAuth()`. This page only
 * renders the main-area content.
 */
import { requireAuth } from '@/lib/auth/require';

export default async function HomePage(): Promise<JSX.Element> {
  const auth = await requireAuth();

  return (
    <div className="mx-auto max-w-4xl">
      <header className="mb-8">
        <p className="font-mono text-xs uppercase tracking-widest text-text-muted">
          Recruitment Data Platform
        </p>
        <h1 className="font-display text-3xl font-semibold tracking-tighter text-text-primary">
          Talent intelligence over Teamtailor
        </h1>
      </header>

      <section className="rounded-lg border border-border bg-surface p-6">
        <h2 className="font-display text-lg font-medium text-text-primary">
          Welcome, {auth.email}
        </h2>
        <p className="mt-2 text-sm text-text-muted">
          Role: <span className="font-mono text-xs text-text-primary">{auth.role}</span>
        </p>
        <p className="mt-4 text-sm text-text-muted">
          Structured candidate search lands in F1-010. See{' '}
          <code className="font-mono text-xs">docs/roadmap.md</code>.
        </p>
      </section>
    </div>
  );
}
