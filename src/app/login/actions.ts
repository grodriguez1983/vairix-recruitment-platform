'use server';

/**
 * Server actions for the login flow.
 *
 * `sendMagicLink` triggers `signInWithOtp` against Supabase. The
 * user receives an email; clicking it hits `/auth/callback` which
 * exchanges the code for a session and redirects home.
 */
import { z } from 'zod';

import { createClient } from '@/lib/supabase/server';
import { originFromHeaders } from '@/lib/shared/origin';

export interface MagicLinkState {
  ok: boolean;
  message: string;
}

const EmailSchema = z.string().trim().email('Enter a valid email address.');

export async function sendMagicLink(
  _prev: MagicLinkState | undefined,
  formData: FormData,
): Promise<MagicLinkState> {
  const raw = formData.get('email');
  const parsed = EmailSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? 'Invalid email.' };
  }

  const supabase = createClient();
  const redirectTo = `${originFromHeaders()}/auth/callback`;
  const { error } = await supabase.auth.signInWithOtp({
    email: parsed.data,
    options: { emailRedirectTo: redirectTo, shouldCreateUser: false },
  });

  if (error) {
    // Intentionally generic: avoid leaking whether the email is
    // registered. This is an internal tool, but the surface is still
    // minimal.
    return { ok: false, message: 'Could not send the link. Try again in a moment.' };
  }
  return {
    ok: true,
    message: 'Check your inbox. The link expires in a few minutes.',
  };
}
