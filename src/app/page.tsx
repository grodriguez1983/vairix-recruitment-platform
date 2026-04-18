import { ThemeToggle } from './theme-toggle';

export default function HomePage(): JSX.Element {
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
        <ThemeToggle />
      </header>

      <section className="rounded-lg border border-border bg-surface p-6">
        <h2 className="font-display text-lg font-medium text-text-primary">Fase 1 — Fundación</h2>
        <p className="mt-2 text-sm text-text-muted">
          Sincronización incremental de Teamtailor, auth base y layout. Ver{' '}
          <code className="font-mono text-xs">docs/roadmap.md</code>.
        </p>

        <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="rounded-md border border-border bg-bg p-4">
            <p className="text-xs text-text-muted">Accent</p>
            <div className="mt-2 h-6 rounded-sm bg-accent" />
          </div>
          <div className="rounded-md border border-border bg-bg p-4">
            <p className="text-xs text-text-muted">Danger</p>
            <div className="mt-2 h-6 rounded-sm bg-danger" />
          </div>
          <div className="rounded-md border border-border bg-bg p-4">
            <p className="text-xs text-text-muted">Info</p>
            <div className="mt-2 h-6 rounded-sm bg-info" />
          </div>
        </div>
      </section>
    </main>
  );
}
