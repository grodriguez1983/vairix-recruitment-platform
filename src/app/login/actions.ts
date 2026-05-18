'use server';

/**
 * Server action for the login flow.
 *
 * `signIn` authenticates with email + password against Supabase. On
 * success the Supabase server client writes the session cookies and
 * we redirect to the app shell. Wrong credentials return a generic
 * message (we intentionally do not disclose whether the email exists
 * — internal tool, but minimal-surface stance per ADR-003).
 *
 * User provisioning happens out-of-band: admins create users (and set
 * the initial password) from the Supabase dashboard, then communicate
 * the password to the user via a side channel.
 */
import { redirect } from 'next/navigation';
import { z } from 'zod';

import { createClient } from '@/lib/supabase/server';

export interface SignInState {
  ok: boolean;
  message: string;
}

const CredentialsSchema = z.object({
  email: z.string().trim().email('Enter a valid email address.'),
  password: z.string().min(1, 'Password is required.'),
});

export async function signIn(
  _prev: SignInState | undefined,
  formData: FormData,
): Promise<SignInState> {
  const parsed = CredentialsSchema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
  });
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? 'Invalid credentials.' };
  }

  const supabase = createClient();
  const { error } = await supabase.auth.signInWithPassword({
    email: parsed.data.email,
    password: parsed.data.password,
  });

  if (error) {
    return { ok: false, message: 'Invalid email or password.' };
  }

  redirect('/');
}
