/**
 * "Notes" section of the candidate profile.
 *
 * Shows every non-soft-deleted Teamtailor note for the candidate,
 * most-recent first. Free-text `body` with an author + date byline.
 * Read-only — note creation still happens in Teamtailor.
 */
import type { createClient } from '@/lib/supabase/server';

export interface NoteRow {
  id: string;
  author_name: string | null;
  body: string;
  created_at: string;
}

export async function fetchNotes(
  supabase: ReturnType<typeof createClient>,
  candidateId: string,
): Promise<NoteRow[]> {
  const { data } = await supabase
    .from('notes')
    .select('id, author_name, body, created_at')
    .eq('candidate_id', candidateId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false });
  return (data ?? []) as unknown as NoteRow[];
}

function formatDate(iso: string): string | null {
  try {
    return new Date(iso).toISOString().slice(0, 10);
  } catch {
    return null;
  }
}

export function NotesSection({ notes }: { notes: NoteRow[] }): JSX.Element {
  return (
    <section className="mb-6">
      <h2 className="mb-3 font-display text-base font-semibold text-text-primary">
        Notes{' '}
        <span className="font-mono text-xs font-normal text-text-muted">({notes.length})</span>
      </h2>
      {notes.length === 0 ? (
        <div className="rounded-lg border border-border border-dashed bg-surface p-6 text-center">
          <p className="text-sm text-text-muted">Sin notas.</p>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {notes.map((n) => (
            <li key={n.id} className="rounded-md border border-border bg-surface p-4">
              <p className="mb-1 text-xs text-text-muted">
                {n.author_name ?? 'Unknown'} · {formatDate(n.created_at)}
              </p>
              <p className="whitespace-pre-wrap text-sm text-text-primary">{n.body}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
