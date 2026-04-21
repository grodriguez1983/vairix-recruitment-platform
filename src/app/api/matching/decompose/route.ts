/**
 * POST /api/matching/decompose — UC-11 entry point (ADR-014 §3/§6).
 *
 * RED stub: schema exists so imports typecheck, but its validation is
 * deliberately incomplete. The GREEN pass tightens it (length bounds,
 * whitespace rejection) and wires the route handler.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

export const decomposeRequestSchema = z.object({
  rawText: z.string(),
});

export type DecomposeRequest = z.infer<typeof decomposeRequestSchema>;

export async function POST(_request: NextRequest): Promise<NextResponse> {
  return NextResponse.json({ error: 'not_implemented' }, { status: 501 });
}
