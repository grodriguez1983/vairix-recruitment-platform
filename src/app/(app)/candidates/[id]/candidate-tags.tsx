/**
 * Client component for the candidate tags section.
 *
 * Renders existing tags as chips with a remove button, plus an
 * inline form to add a new tag. Autocomplete is browser-native
 * via `<datalist>` so we don't pay for a combobox dependency.
 *
 * Auth + authorization logic lives in the server actions. This
 * component just reflects the result and surfaces errors inline.
 */
'use client';

import { useState, useTransition } from 'react';

import { addTagAction, removeTagAction } from './tags-actions';

export interface TagChip {
  id: string;
  name: string;
  category: string | null;
  created_by: string | null;
}

export interface CandidateTagsProps {
  candidateId: string;
  initialTags: TagChip[];
  allTagNames: string[];
  /** Used for the autocomplete list ID — avoids collisions. */
  datalistId?: string;
}

export function CandidateTags({
  candidateId,
  initialTags,
  allTagNames,
  datalistId = 'tag-suggestions',
}: CandidateTagsProps): JSX.Element {
  const [tags, setTags] = useState<TagChip[]>(initialTags);
  const [input, setInput] = useState('');
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const existingNames = new Set(tags.map((t) => t.name.toLowerCase()));

  function handleAdd(e: React.FormEvent<HTMLFormElement>): void {
    e.preventDefault();
    const name = input.trim();
    if (!name) return;
    if (existingNames.has(name.toLowerCase())) {
      setError(`Already tagged: ${name}`);
      setInput('');
      return;
    }
    setError(null);
    startTransition(async () => {
      const res = await addTagAction(candidateId, name);
      if (!res.ok) {
        setError(res.error?.message ?? 'Failed to add tag');
        return;
      }
      // Optimistic add. Server revalidates the page so the refresh
      // will have the canonical list next time; in the meantime our
      // local list stays consistent.
      setTags((prev) => [
        ...prev,
        {
          id: `optimistic-${name}`,
          name: name.toLowerCase(),
          category: null,
          created_by: null,
        },
      ]);
      setInput('');
    });
  }

  function handleRemove(tagId: string): void {
    setError(null);
    startTransition(async () => {
      const res = await removeTagAction(candidateId, tagId);
      if (!res.ok) {
        setError(res.error?.message ?? 'Failed to remove tag');
        return;
      }
      setTags((prev) => prev.filter((t) => t.id !== tagId));
    });
  }

  const suggestions = allTagNames.filter((n) => !existingNames.has(n));

  return (
    <section className="mb-6">
      <h2 className="mb-3 font-display text-base font-semibold text-text-primary">
        Tags <span className="font-mono text-xs font-normal text-text-muted">({tags.length})</span>
      </h2>
      <div className="rounded-lg border border-border bg-surface p-5">
        <ul className="flex flex-wrap gap-2" aria-label="Candidate tags">
          {tags.length === 0 && <li className="text-sm italic text-text-muted">No tags yet.</li>}
          {tags.map((t) => (
            <li
              key={t.id}
              className="inline-flex items-center gap-1.5 rounded-full border border-border bg-bg px-3 py-1 font-mono text-xs text-text-primary"
            >
              <span>{t.name}</span>
              <button
                type="button"
                aria-label={`Remove tag ${t.name}`}
                disabled={isPending || t.id.startsWith('optimistic-')}
                onClick={() => handleRemove(t.id)}
                className="ml-1 text-text-muted hover:text-danger disabled:opacity-40"
              >
                ×
              </button>
            </li>
          ))}
        </ul>

        <form onSubmit={handleAdd} className="mt-4 flex gap-2">
          <label htmlFor="new-tag" className="sr-only">
            Add tag
          </label>
          <input
            id="new-tag"
            type="text"
            list={datalistId}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Add a tag..."
            disabled={isPending}
            className="min-w-0 flex-1 rounded-md border border-border bg-bg px-3 py-1.5 font-mono text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent"
          />
          <datalist id={datalistId}>
            {suggestions.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
          <button
            type="submit"
            disabled={isPending || input.trim().length === 0}
            className="rounded-md border border-border bg-bg px-3 py-1.5 text-xs font-medium text-text-primary hover:bg-surface disabled:opacity-40"
          >
            {isPending ? 'Adding…' : 'Add'}
          </button>
        </form>
        {error && (
          <p role="alert" className="mt-2 text-xs text-danger">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}
