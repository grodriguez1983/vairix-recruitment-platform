/**
 * Admin-only client form for manually uploading a VAIRIX CV sheet.
 *
 * Posts multipart/form-data to /api/candidates/[id]/vairix-sheet.
 * Surfaces validation + server errors inline. On success, reloads the
 * page so the server-rendered "Archivo subido" row reflects the new
 * file.
 *
 * Recruiters never see this component — the parent page only renders
 * it when the current user's role === 'admin'.
 */
'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState, useTransition } from 'react';

import { VAIRIX_SHEET_EXTS, VAIRIX_SHEET_MAX_BYTES } from '@/lib/cv/vairix-sheet';

const ACCEPT_ATTR = VAIRIX_SHEET_EXTS.map((e) => `.${e}`).join(',');

export interface VairixSheetUploadProps {
  candidateId: string;
}

export function VairixSheetUpload({ candidateId }: VairixSheetUploadProps): JSX.Element {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleSubmit(e: React.FormEvent<HTMLFormElement>): void {
    e.preventDefault();
    if (!file) return;
    setMessage(null);

    startTransition(async () => {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch(`/api/candidates/${candidateId}/vairix-sheet`, {
        method: 'POST',
        body: fd,
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        fileName?: string;
      };
      if (!res.ok || !body.ok) {
        setMessage({ kind: 'err', text: body.error ?? `Upload failed (HTTP ${res.status})` });
        return;
      }
      setMessage({ kind: 'ok', text: `Uploaded: ${body.fileName ?? file.name}` });
      setFile(null);
      if (inputRef.current) inputRef.current.value = '';
      router.refresh();
    });
  }

  return (
    <form onSubmit={handleSubmit} className="mt-4 flex flex-col gap-2 border-t border-border pt-3">
      <label htmlFor="vairix-file" className="text-xs font-medium text-text-muted">
        Subir planilla (admin)
      </label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          ref={inputRef}
          id="vairix-file"
          name="file"
          type="file"
          accept={ACCEPT_ATTR}
          disabled={isPending}
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="min-w-0 flex-1 rounded-md border border-border bg-bg px-2 py-1.5 text-xs text-text-primary file:mr-2 file:rounded file:border-0 file:bg-surface file:px-2 file:py-1 file:text-xs file:text-text-primary"
        />
        <button
          type="submit"
          disabled={isPending || !file}
          className="rounded-md border border-border bg-bg px-3 py-1.5 text-xs font-medium text-text-primary hover:bg-surface disabled:opacity-40"
        >
          {isPending ? 'Subiendo…' : 'Subir'}
        </button>
      </div>
      <p className="text-xs text-text-muted">
        Formatos: {VAIRIX_SHEET_EXTS.join(', ')}. Máx {VAIRIX_SHEET_MAX_BYTES / (1024 * 1024)} MB.
      </p>
      {message && (
        <p
          role={message.kind === 'err' ? 'alert' : 'status'}
          className={`text-xs ${message.kind === 'err' ? 'text-danger' : 'text-accent'}`}
        >
          {message.text}
        </p>
      )}
    </form>
  );
}
