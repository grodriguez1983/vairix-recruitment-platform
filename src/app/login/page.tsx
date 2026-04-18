import { redirect } from 'next/navigation';

import { createClient } from '@/lib/supabase/server';

import { LoginForm } from './login-form';

export const metadata = {
  title: 'Sign in — Recruitment Data Platform',
};

export default async function LoginPage(): Promise<JSX.Element> {
  // If the user is already signed in, bounce them to the app shell.
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user) redirect('/');

  return (
    <main className="grid min-h-screen place-items-center px-6 py-12">
      <div className="w-full max-w-sm space-y-8">
        <div className="space-y-1.5 text-center">
          <p className="font-mono text-xs uppercase tracking-widest text-text-muted">VAIRIX</p>
          <h1 className="font-display text-2xl font-semibold tracking-tighter text-text-primary">
            Recruitment Data Platform
          </h1>
          <p className="text-sm text-text-muted">Sign in with your work email.</p>
        </div>
        <LoginForm />
      </div>
    </main>
  );
}
