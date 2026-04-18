/**
 * Supabase client for React client components (browser). Uses the
 * publishable key; RLS enforces access. Sessions are stored in
 * cookies managed by `@supabase/ssr`, so this client reads the same
 * session as the server client.
 */
import { createBrowserClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';

import { supabasePublishableKey, supabaseUrl } from './env';

export function createClient(): SupabaseClient {
  return createBrowserClient(supabaseUrl(), supabasePublishableKey());
}
