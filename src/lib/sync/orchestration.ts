/**
 * Stub — implemented in GREEN commit (ADR-028).
 */
export const CANONICAL_ENTITY_ORDER: readonly string[] = [];

export function parseBackfillArgs(_argv: readonly string[]): { entity: string } {
  throw new Error('STUB');
}

export interface OrchestrationOutcome {
  results: Array<{ entity: string; recordsSynced: number }>;
}

export async function runOrchestration(_input: {
  entities: readonly string[];
  runOne: (entity: string) => Promise<{ entity: string; recordsSynced: number }>;
}): Promise<OrchestrationOutcome> {
  return { results: [] };
}
