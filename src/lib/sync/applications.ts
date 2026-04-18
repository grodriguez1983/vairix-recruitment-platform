/**
 * Applications syncer.
 *
 * Stub — implementación en [GREEN] siguiente.
 */
import type { EntitySyncer, SyncerDeps } from './run';
import type { TTParsedResource } from '../teamtailor/types';

export interface ApplicationStaging {
  teamtailor_id: string;
  candidate_tt_id: string | null;
  job_tt_id: string | null;
  stage_tt_id: string | null;
  status: string | null;
  source: string | null;
  cover_letter: string | null;
  rejected_at: string | null;
  hired_at: string | null;
  raw_data: unknown;
}

export const applicationsSyncer: EntitySyncer<ApplicationStaging> = {
  entity: 'applications',
  buildInitialRequest(_cursor: string | null) {
    throw new Error('applicationsSyncer.buildInitialRequest: not implemented');
  },
  mapResource(_resource: TTParsedResource): ApplicationStaging {
    throw new Error('applicationsSyncer.mapResource: not implemented');
  },
  async upsert(_rows: ApplicationStaging[], _deps: SyncerDeps): Promise<number> {
    throw new Error('applicationsSyncer.upsert: not implemented');
  },
};
