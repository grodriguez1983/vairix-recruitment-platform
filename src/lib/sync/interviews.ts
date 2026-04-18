/**
 * Interviews syncer — stub for RED test commit (see tests/integration/sync/interviews.test.ts).
 * GREEN impl lands in the next commit.
 */
import type { EntitySyncer } from './run';

export const interviewsSyncer: EntitySyncer<unknown> = {
  entity: 'evaluations',
  buildInitialRequest() {
    throw new Error('interviewsSyncer not implemented');
  },
  mapResource() {
    throw new Error('interviewsSyncer not implemented');
  },
  async upsert() {
    throw new Error('interviewsSyncer not implemented');
  },
};
