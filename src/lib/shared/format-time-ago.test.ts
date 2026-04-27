/**
 * Adversarial tests for `formatTimeAgo` — UI helper used to render
 * "last used" staleness in the matching results breakdown
 * (ADR-026 follow-up).
 *
 * Determinism: all tests inject `now` explicitly so the helper is
 * pure and the suite never depends on wallclock.
 */
import { describe, expect, it } from 'vitest';

import { formatTimeAgo } from './format-time-ago';

describe('formatTimeAgo', () => {
  const now = new Date('2026-04-27T00:00:00Z');

  it('test_returns_dash_when_iso_is_null', () => {
    expect(formatTimeAgo(null, now)).toBe('—');
  });

  it('test_returns_dash_when_iso_is_empty_string', () => {
    expect(formatTimeAgo('', now)).toBe('—');
  });

  it('test_returns_dash_when_iso_is_unparseable', () => {
    expect(formatTimeAgo('not-a-date', now)).toBe('—');
  });

  it('test_renders_now_when_same_day', () => {
    expect(formatTimeAgo('2026-04-27', now)).toBe('now');
  });

  it('test_renders_now_when_future_date_clamped', () => {
    // last_used > now should never happen, but if it does we don't
    // want a "-2y ago" rendering. Clamp to "now".
    expect(formatTimeAgo('2027-04-27', now)).toBe('now');
  });

  it('test_renders_months_when_less_than_one_year', () => {
    // 2025-10-27 → 6 months ago
    expect(formatTimeAgo('2025-10-27', now)).toBe('6mo ago');
  });

  it('test_renders_one_month_floor', () => {
    // 2026-03-15 → ~1.4mo ago → floor to 1mo
    expect(formatTimeAgo('2026-03-15', now)).toBe('1mo ago');
  });

  it('test_renders_less_than_one_month_for_recent_dates', () => {
    // 2026-04-20 → 7 days ago → <1mo
    expect(formatTimeAgo('2026-04-20', now)).toBe('<1mo ago');
  });

  it('test_renders_years_when_at_least_one_year', () => {
    // 2025-04-27 → exactly 1 year ago
    expect(formatTimeAgo('2025-04-27', now)).toBe('1y ago');
  });

  it('test_renders_canonical_owner_case', () => {
    // ADR-026 canonical: 5y of Java 2005-2010, asOf 2026 → 15y ago.
    expect(formatTimeAgo('2010-12-31', now)).toBe('15y ago');
  });

  it('test_floors_partial_years_not_rounds', () => {
    // 2024-10-27 → 1.5y → must show "1y" (floor), not "2y" (round).
    // Floor matches "how many full years ago" mental model.
    expect(formatTimeAgo('2024-10-27', now)).toBe('1y ago');
  });
});
