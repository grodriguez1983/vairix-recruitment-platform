/**
 * Candidates list — stub. The real structured search UI lands in
 * F1-010 (see docs/roadmap.md). For now this is a placeholder so the
 * shell navigation has a destination and e2e tests can assert the
 * route is reachable.
 */
import { requireAuth } from '@/lib/auth/require';

export const metadata = {
  title: 'Candidates — Recruitment Data Platform',
};

export default async function CandidatesPage(): Promise<JSX.Element> {
  await requireAuth();

  return (
    <div className="mx-auto max-w-4xl">
      <header className="mb-8">
        <h1 className="font-display text-2xl font-semibold tracking-tighter text-text-primary">
          Candidates
        </h1>
        <p className="mt-1 text-sm text-text-muted">
          Structured search, tags and shortlists land in F1-010+.
        </p>
      </header>
      <section className="rounded-lg border border-border border-dashed bg-surface p-6">
        <p className="text-sm text-text-muted">No data surface yet. Check back after F1-010.</p>
      </section>
    </div>
  );
}
