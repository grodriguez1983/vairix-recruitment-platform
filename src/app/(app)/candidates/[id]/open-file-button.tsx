/**
 * Opens a file stored in the private `candidate-cvs` bucket by
 * requesting a short-lived signed URL from the API, then
 * `window.open`-ing it in a new tab.
 *
 * Why client-side: the signed URL expires in 1 h, so we mint it on
 * click instead of embedding it at render time (which would leak
 * through view-source and grow stale on back/forward navigation).
 */
'use client';

import { useState, useTransition } from 'react';

export interface OpenFileButtonProps {
  fileId: string;
  label: string;
  /** Optional extra classes — defaults to a subtle border button. */
  className?: string;
}

export function OpenFileButton({ fileId, label, className }: OpenFileButtonProps): JSX.Element {
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleClick(): void {
    setError(null);
    startTransition(async () => {
      const res = await fetch(`/api/files/${fileId}/signed-url`, { cache: 'no-store' });
      const body = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!res.ok || !body.url) {
        setError(body.error ?? `HTTP ${res.status}`);
        return;
      }
      // `noopener,noreferrer` so the signed URL is not exposed to the
      // opened context via window.opener.
      window.open(body.url, '_blank', 'noopener,noreferrer');
    });
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        onClick={handleClick}
        disabled={isPending}
        className={
          className ??
          'rounded-md border border-border bg-bg px-3 py-1 text-xs font-medium text-text-primary hover:bg-surface disabled:opacity-40'
        }
      >
        {isPending ? 'Opening…' : label}
      </button>
      {error && (
        <span role="alert" className="font-mono text-xs text-danger">
          {error}
        </span>
      )}
    </span>
  );
}
