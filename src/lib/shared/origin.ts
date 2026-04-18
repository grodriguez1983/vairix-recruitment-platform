/**
 * Resolves the absolute origin of the current request (protocol +
 * host). Used to build callback URLs (e.g., magic link redirect)
 * from inside server actions and route handlers, where there's no
 * `window.location.origin` available.
 */
import { headers } from 'next/headers';

export function originFromHeaders(): string {
  const h = headers();
  const host = h.get('host') ?? 'localhost:3000';
  const proto = h.get('x-forwarded-proto') ?? (host.includes('localhost') ? 'http' : 'https');
  return `${proto}://${host}`;
}
