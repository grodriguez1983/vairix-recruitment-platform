/**
 * Candidates syncer.
 *
 * Stub — implementación en [GREEN] siguiente.
 */
import type { EntitySyncer, SyncerDeps } from './run';
import type { TTParsedResource } from '../teamtailor/types';

export interface CandidateRow {
  teamtailor_id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  linkedin_url: string | null;
  pitch: string | null;
  sourced: boolean;
  raw_data: unknown;
}

export const candidatesSyncer: EntitySyncer<CandidateRow> = {
  entity: 'candidates',
  buildInitialRequest(_cursor: string | null) {
    throw new Error('candidatesSyncer.buildInitialRequest: not implemented');
  },
  mapResource(_resource: TTParsedResource): CandidateRow {
    throw new Error('candidatesSyncer.mapResource: not implemented');
  },
  async upsert(_rows: CandidateRow[], _deps: SyncerDeps): Promise<number> {
    throw new Error('candidatesSyncer.upsert: not implemented');
  },
};
