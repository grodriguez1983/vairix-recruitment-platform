import { requireAuth } from '@/lib/auth/require';

import { ThemeToggle } from './theme-toggle';

export default async function HomePage(): Promise<JSX.Element> {
  const auth = await requireAuth();

  return (
    <main className="mx-auto max-w-4xl px-6 py-12">
      <header className="mb-10 flex items-center justify-between">
        <div>
          <p className="font-mono text-xs uppercase tracking-widest text-text-muted">
            Recruitment Data Platform
          </p>
          <h1 className="font-display text-4xl font-semibold tracking-tighter text-text-primary">
            Talent intelligence over Teamtailor
          </h1>
        </div>
        <div className="flex items-center gap-3">
          <ThemeToggle />
          <form action="/logout" method="post">
            <button
              type="submit"
              className="inline-flex h-9 items-center justify-center rounded-md border border-border px-3 text-xs font-medium text-text-muted hover:text-text-primary transition-colors"
            >
              Sign out
            </button>
          </form>
        </div>
      </header>

      <section className="rounded-lg border border-border bg-surface p-6">
        <h2 className="font-display text-lg font-medium text-text-primary">
          Welcome, {auth.email}
        </h2>
        <p className="mt-2 text-sm text-text-muted">
          Role: <span className="font-mono text-xs text-text-primary">{auth.role}</span>
        </p>
        <p className="mt-4 text-sm text-text-muted">
          The app shell (sidebar, navigation, candidate list) lands in F1-009d. See{' '}
          <code className="font-mono text-xs">docs/roadmap.md</code>.
        </p>
      </section>
    </main>
  );
}
