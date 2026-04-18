export const metadata = {
  title: 'Access denied — Recruitment Data Platform',
};

export default function ForbiddenPage(): JSX.Element {
  return (
    <main className="grid min-h-screen place-items-center px-6 py-12">
      <div className="max-w-sm space-y-3 text-center">
        <p className="font-mono text-xs uppercase tracking-widest text-text-muted">403</p>
        <h1 className="font-display text-2xl font-semibold tracking-tighter text-text-primary">
          Access denied
        </h1>
        <p className="text-sm text-text-muted">
          Your account doesn&apos;t have permission for this section. Ask an admin to grant access
          if you believe this is an error.
        </p>
        <form action="/logout" method="post" className="pt-4">
          <button
            type="submit"
            className="text-xs font-medium text-accent hover:underline underline-offset-4"
          >
            Sign out
          </button>
        </form>
      </div>
    </main>
  );
}
