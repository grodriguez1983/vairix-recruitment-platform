/**
 * Centralized access to Supabase environment variables for the UI.
 *
 * Only the *publishable* key (safe for the browser) is exposed here.
 * RLS is the line of defense. The secret key is not read by this
 * module — it's reserved for the ETL worker and scripts that
 * intentionally bypass RLS.
 */

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

export function supabaseUrl(): string {
  return required('NEXT_PUBLIC_SUPABASE_URL');
}

export function supabasePublishableKey(): string {
  return required('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY');
}
