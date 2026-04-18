/**
 * Auth types shared across the auth helpers and UI components.
 */

export type AppRole = 'recruiter' | 'admin';

export interface AuthContext {
  /** Supabase auth.users.id (uuid). Stable across logins. */
  userId: string;
  /** Primary email from auth.users. */
  email: string;
  /** App-level role from app_users, resolved via current_app_role(). */
  role: AppRole;
}
