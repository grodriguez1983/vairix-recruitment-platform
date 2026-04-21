/**
 * `/matching/new` — UC-11 entry point (F4-009).
 *
 * Server component wrapping the interactive form. Auth is guaranteed
 * by the `(app)` layout's `requireAuth()`.
 */
import { NewMatchForm } from './new-match-form';

export const metadata = {
  title: 'New match — Recruitment Data Platform',
};

export const dynamic = 'force-dynamic';

export default function NewMatchPage(): JSX.Element {
  return (
    <div className="mx-auto max-w-4xl">
      <header className="mb-6">
        <h1 className="font-display text-2xl font-semibold tracking-tighter text-text-primary">
          New match
        </h1>
        <p className="mt-1 text-sm text-text-muted">
          Paste a job description. The decomposer extracts must-haves, years, seniority and
          languages; the deterministic ranker scores every candidate under RLS.
        </p>
      </header>
      <NewMatchForm />
    </div>
  );
}
