'use client';

import { useFormState, useFormStatus } from 'react-dom';

import { sendMagicLink, type MagicLinkState } from './actions';

const initialState: MagicLinkState = { ok: false, message: '' };

function SubmitButton(): JSX.Element {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex h-10 w-full items-center justify-center rounded-md bg-accent px-4 text-sm font-medium text-[color:var(--color-bg)] transition-opacity hover:opacity-90 disabled:opacity-60"
    >
      {pending ? 'Sending…' : 'Send magic link'}
    </button>
  );
}

export function LoginForm(): JSX.Element {
  const [state, formAction] = useFormState(sendMagicLink, initialState);

  return (
    <form action={formAction} className="space-y-4">
      <div className="space-y-1.5">
        <label htmlFor="email" className="text-xs font-medium text-text-muted">
          Work email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          placeholder="you@vairix.com"
          className="h-10 w-full rounded-md border border-border bg-surface px-3 text-sm text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
        />
      </div>
      <SubmitButton />
      {state.message.length > 0 ? (
        <p role="status" className={state.ok ? 'text-xs text-accent' : 'text-xs text-danger'}>
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
