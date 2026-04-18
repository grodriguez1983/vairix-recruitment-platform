/**
 * Jobs syncer.
 *
 * Stub — implementación en [GREEN] siguiente.
 */
import type { EntitySyncer, SyncerDeps } from './run';
import type { TTParsedResource } from '../teamtailor/types';

export interface JobRow {
  teamtailor_id: string;
  title: string;
  status: string | null;
  pitch: string | null;
  body: string | null;
  department: string | null;
  location: string | null;
  raw_data: unknown;
}

export const jobsSyncer: EntitySyncer<JobRow> = {
  entity: 'jobs',
  buildInitialRequest(_cursor: string | null) {
    throw new Error('jobsSyncer.buildInitialRequest: not implemented');
  },
  mapResource(_resource: TTParsedResource): JobRow {
    throw new Error('jobsSyncer.mapResource: not implemented');
  },
  async upsert(_rows: JobRow[], _deps: SyncerDeps): Promise<number> {
    throw new Error('jobsSyncer.upsert: not implemented');
  },
};
