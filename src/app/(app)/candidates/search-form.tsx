/**
 * Search bar for `/candidates`. Client component: on submit,
 * navigates to `/candidates?q=<value>&page=1` via `router.push`.
 * The `/candidates` page is a server component that re-renders on
 * the new searchParams. Drawers for structured filters land in
 * F1-010c — we keep this intentionally minimal.
 */
'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useState, useTransition, type FormEvent } from 'react';

import { cn } from '@/lib/shared/cn';

export function SearchForm({ initialQuery }: { initialQuery: string }): JSX.Element {
  const router = useRouter();
  const params = useSearchParams();
  const [value, setValue] = useState(initialQuery);
  const [pending, startTransition] = useTransition();

  function onSubmit(e: FormEvent<HTMLFormElement>): void {
    e.preventDefault();
    const trimmed = value.trim();
    const next = new URLSearchParams(params.toString());
    next.delete('page');
    if (trimmed.length === 0) {
      next.delete('q');
    } else {
      next.set('q', trimmed);
    }
    const query = next.toString();
    startTransition(() => {
      router.push(query ? `/candidates?${query}` : '/candidates');
    });
  }

  return (
    <form onSubmit={onSubmit} className="flex items-center gap-2" role="search">
      <label htmlFor="search-q" className="sr-only">
        Search candidates
      </label>
      <input
        id="search-q"
        name="q"
        type="search"
        autoComplete="off"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Search by name, email, or pitch…"
        className={cn(
          'h-10 w-full rounded-sm border border-border bg-surface px-3 text-sm text-text-primary',
          'placeholder:text-text-muted focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent',
        )}
      />
      <button
        type="submit"
        disabled={pending}
        className={cn(
          'inline-flex h-10 items-center justify-center rounded-md bg-accent px-5 text-sm font-medium text-bg',
          'transition-opacity hover:opacity-90 disabled:opacity-60',
        )}
      >
        {pending ? 'Searching…' : 'Search'}
      </button>
    </form>
  );
}
