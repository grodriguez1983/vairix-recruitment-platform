/**
 * Server-side auth helpers used by Server Components, Server
 * Actions, and Route Handlers.
 *
 * Source of truth for the app role is `public.current_app_role()`
 * (see 20260417205153_rls_app_users.sql). We call it via RPC
 * because `app_users` is admin-only under RLS: a recruiter cannot
 * select their own row. The SECURITY DEFINER function bypasses RLS
 * and returns the role (or null when no active row exists).
 *
 * `requireAuth` and `requireRole` throw a Next.js redirect on
 * failure. Those throws unwind the RSC/action tree — callers don't
 * need to handle them, they just won't proceed past the call.
 */
import { redirect } from 'next/navigation';

import { createClient } from '../supabase/server';

import { ForbiddenError, UnauthenticatedError } from './errors';
import type { AppRole, AuthContext } from './types';

function isAppRole(v: unknown): v is AppRole {
  return v === 'recruiter' || v === 'admin';
}

/**
 * Returns the current auth context, or null if the visitor is not
 * authenticated OR their app_users row is missing/deactivated. Use
 * this when the caller wants to branch on auth state rather than
 * redirect (e.g., landing pages that show different content).
 */
export async function getAuthUser(): Promise<AuthContext | null> {
  const supabase = createClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError || !user || !user.email) return null;

  const { data: role, error: roleError } = await supabase.rpc('current_app_role');
  if (roleError || !isAppRole(role)) return null;

  return { userId: user.id, email: user.email, role };
}

/**
 * Redirects to /login if the user is not authenticated or has no
 * active app_users row. Returns the auth context otherwise.
 */
export async function requireAuth(): Promise<AuthContext> {
  const ctx = await getAuthUser();
  if (!ctx) {
    redirect('/login');
  }
  return ctx;
}

/**
 * Same as requireAuth plus a role gate. Unauthenticated → /login.
 * Authenticated but wrong role → /403.
 */
export async function requireRole(role: AppRole): Promise<AuthContext> {
  const ctx = await requireAuth();
  if (ctx.role !== role) {
    redirect('/403');
  }
  return ctx;
}

export { ForbiddenError, UnauthenticatedError };
