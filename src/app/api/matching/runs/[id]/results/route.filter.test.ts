/**
 * ADR-025 regression: GET /api/matching/runs/:id/results always
 * filters `must_have_gate = 'passed'` before returning rows.
 *
 * The route runs under RLS with the real Supabase client in prod;
 * here we mock the client and assert the `.eq('must_have_gate',
 * 'passed')` link in the chain is present. A future edit that drops
 * the filter (whether intentional or a rebase accident) will turn
 * this test red and force a conscious decision.
 */
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth/require', () => ({
  getAuthUser: vi.fn(async () => ({ id: '00000000-0000-0000-0000-000000000001' })),
}));

const eqCalls: Array<[string, unknown]> = [];

vi.mock('@/lib/supabase/server', () => {
  function chain(): unknown {
    const c: Record<string, unknown> = {};
    c.select = vi.fn(() => c);
    c.eq = vi.fn((col: string, val: unknown) => {
      eqCalls.push([col, val]);
      return c;
    });
    c.maybeSingle = vi.fn(async () => ({ data: { id: 'run-1' }, error: null }));
    c.order = vi.fn(() => c);
    c.range = vi.fn(async () => ({ data: [], error: null, count: 0 }));
    return c;
  }
  return {
    createClient: vi.fn(() => ({
      from: vi.fn(() => chain()),
    })),
  };
});

// Import after mocks are installed.
const { GET } = await import('./route');

function buildRequest(): NextRequest {
  return new NextRequest(
    'http://localhost/api/matching/runs/3b5a3b5a-3b5a-3b5a-3b5a-3b5a3b5a3b5a/results',
  );
}

describe('GET /api/matching/runs/:id/results — ADR-025 filter', () => {
  beforeEach(() => {
    eqCalls.length = 0;
  });

  it("applies .eq('must_have_gate', 'passed') on match_results", async () => {
    const res = await GET(buildRequest(), {
      params: { id: '3b5a3b5a-3b5a-3b5a-3b5a-3b5a3b5a3b5a' },
    });
    expect(res.status).toBe(200);

    const filters = eqCalls.filter(([col]) => col === 'must_have_gate');
    expect(filters, 'route must pin gate to passed by default (ADR-025)').toHaveLength(1);
    expect(filters[0]![1]).toBe('passed');
  });
});
