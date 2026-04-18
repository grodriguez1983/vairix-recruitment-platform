/**
 * Rendered when `notFound()` is called inside `/candidates/[id]`.
 * A recruiter lands here for either of:
 *   - a candidate id that doesn't exist, or
 *   - a candidate that was soft-deleted (RLS hides it from them).
 * Both collapse to the same user-facing outcome by design.
 */
import Link from 'next/link';

export default function CandidateNotFound(): JSX.Element {
  return (
    <div className="mx-auto max-w-xl py-16 text-center">
      <p className="font-mono text-xs uppercase tracking-widest text-text-muted">404</p>
      <h1 className="mt-2 font-display text-2xl font-semibold tracking-tighter text-text-primary">
        Candidate not found
      </h1>
      <p className="mt-2 text-sm text-text-muted">
        This candidate doesn&apos;t exist or is no longer visible to your account.
      </p>
      <Link
        href="/candidates"
        className="mt-6 inline-flex h-9 items-center rounded-md border border-border px-4 text-xs font-medium text-text-primary hover:border-accent"
      >
        ← Back to candidates
      </Link>
    </div>
  );
}
