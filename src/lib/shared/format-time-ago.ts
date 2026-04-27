/**
 * UI helper — format an ISO date as a human-readable "time ago" label
 * for the matching results breakdown's `last_used` column
 * (ADR-026 follow-up).
 *
 * Pure function: `now` is injected so callers (and tests) control the
 * anchor. The matching domain is deterministic via `catalogSnapshotAt`,
 * but this helper is a UI presenter — passing `new Date()` from the
 * client is fine here.
 *
 * Granularity (calendar-aware so "exactly 1 year ago" reads as "1y",
 * not "11mo" due to leap-year rounding):
 *   - same day or future (future is clamped) → `now`
 *   - 0 calendar months but past → `<1mo ago`
 *   - < 12 calendar months → `Nmo ago`
 *   - >= 12 calendar months → `Ny ago`  (floor — full years)
 *
 * `null`, empty, or unparseable inputs render as `—`.
 */
export function formatTimeAgo(iso: string | null, now: Date): string {
  if (iso === null || iso === '') return '—';
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return '—';

  if (ts >= now.getTime()) return 'now';

  const then = new Date(ts);
  const calendarMonths = diffCalendarMonths(then, now);

  if (calendarMonths === 0) return '<1mo ago';
  if (calendarMonths < 12) return `${calendarMonths}mo ago`;
  return `${Math.floor(calendarMonths / 12)}y ago`;
}

/**
 * Calendar-month difference (now - then) using UTC components.
 * Subtracts one when `now`'s day-of-month hasn't yet reached `then`'s,
 * so "Mar 15 → Apr 14" yields 0 months, while "Mar 15 → Apr 15" yields 1.
 */
function diffCalendarMonths(then: Date, now: Date): number {
  const yearDiff = now.getUTCFullYear() - then.getUTCFullYear();
  const monthDiff = now.getUTCMonth() - then.getUTCMonth();
  let months = yearDiff * 12 + monthDiff;
  if (now.getUTCDate() < then.getUTCDate()) months -= 1;
  return Math.max(0, months);
}
