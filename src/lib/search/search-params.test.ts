/**
 * Unit tests for the search-params parsers.
 *
 * These helpers are the validation boundary between the URL (user-
 * controlled, possibly stale) and the services (assume clean types).
 * Adversarial naming: we test what the parsers REJECT, not what they
 * accept — accepting valid input is trivial.
 */
import { describe, expect, it } from 'vitest';

import {
  firstOf,
  MAX_QUERY_LENGTH,
  parseDateInputToIso,
  parseQuery,
  parseStatus,
  parseUuid,
} from './search-params';

describe('firstOf', () => {
  it('returns string inputs unchanged', () => {
    expect(firstOf('foo')).toBe('foo');
  });
  it('returns the first element of an array input', () => {
    expect(firstOf(['a', 'b'])).toBe('a');
  });
  it('passes undefined through', () => {
    expect(firstOf(undefined)).toBeUndefined();
  });
  it('returns undefined for an empty array (Next does not emit these, but defend)', () => {
    expect(firstOf([])).toBeUndefined();
  });
});

describe('parseQuery', () => {
  it('returns "" for undefined / empty', () => {
    expect(parseQuery(undefined)).toBe('');
    expect(parseQuery('')).toBe('');
  });
  it('trims surrounding whitespace', () => {
    expect(parseQuery('  backend   ')).toBe('backend');
  });
  it(`clamps to MAX_QUERY_LENGTH (${MAX_QUERY_LENGTH} chars)`, () => {
    const long = 'x'.repeat(MAX_QUERY_LENGTH + 50);
    expect(parseQuery(long)).toHaveLength(MAX_QUERY_LENGTH);
  });
  it('picks the first when given an array', () => {
    expect(parseQuery(['foo', 'bar'])).toBe('foo');
  });
  it('returns "" for a whitespace-only string (trim first)', () => {
    expect(parseQuery('   ')).toBe('');
  });
});

describe('parseStatus', () => {
  it.each(['active', 'rejected', 'hired', 'withdrawn'])('accepts %s', (s) => {
    expect(parseStatus(s)).toBe(s);
  });
  it('rejects_unknown_status_values', () => {
    expect(parseStatus('foo')).toBeNull();
    expect(parseStatus('ACTIVE')).toBeNull(); // case-sensitive on purpose
    expect(parseStatus('')).toBeNull();
    expect(parseStatus(undefined)).toBeNull();
  });
  it('rejects_sql_injection_attempts_as_unknown_value', () => {
    expect(parseStatus("active'; DROP TABLE candidates;--")).toBeNull();
  });
});

describe('parseUuid', () => {
  it('accepts a canonical v4 UUID', () => {
    expect(parseUuid('550e8400-e29b-41d4-a716-446655440000')).toBe(
      '550e8400-e29b-41d4-a716-446655440000',
    );
  });
  it('accepts uppercase hex (case-insensitive)', () => {
    expect(parseUuid('AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE')).toBe(
      'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE',
    );
  });
  it('rejects_short_or_missing_hyphens', () => {
    expect(parseUuid('550e8400e29b41d4a716446655440000')).toBeNull();
    expect(parseUuid('550e8400-e29b-41d4-a716-44665544000')).toBeNull();
  });
  it('rejects_non_hex_chars', () => {
    expect(parseUuid('550e8400-e29b-41d4-a716-44665544000z')).toBeNull();
  });
  it('rejects_sql_injection_in_uuid_slot', () => {
    expect(parseUuid("' OR 1=1--")).toBeNull();
  });
  it('returns null for undefined', () => {
    expect(parseUuid(undefined)).toBeNull();
  });
});

describe('parseDateInputToIso', () => {
  it('lifts YYYY-MM-DD to UTC midnight ISO', () => {
    expect(parseDateInputToIso('2025-06-15')).toBe('2025-06-15T00:00:00Z');
  });
  it('rejects_iso_timestamp_input_needs_plain_date', () => {
    // HTML date inputs never emit this; reject to keep the contract tight.
    expect(parseDateInputToIso('2025-06-15T12:00:00Z')).toBeNull();
  });
  it('rejects_slashed_or_dotted_formats', () => {
    expect(parseDateInputToIso('2025/06/15')).toBeNull();
    expect(parseDateInputToIso('15-06-2025')).toBeNull();
  });
  it('rejects_partial_dates', () => {
    expect(parseDateInputToIso('2025-06')).toBeNull();
    expect(parseDateInputToIso('')).toBeNull();
  });
  it('does NOT validate calendar correctness (2025-02-30 passes shape)', () => {
    // Deliberate: the regex is shape-only. Postgres will reject a real
    // bad date at query time. We document this so the behavior is
    // intentional, not an oversight.
    expect(parseDateInputToIso('2025-02-30')).toBe('2025-02-30T00:00:00Z');
  });
  it('returns null for undefined', () => {
    expect(parseDateInputToIso(undefined)).toBeNull();
  });
});
