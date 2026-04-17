/**
 * Stages syncer.
 *
 * Stub — implementación en [GREEN] siguiente.
 */
import type { EntitySyncer, SyncerDeps } from './run';
import type { TTParsedResource } from '../teamtailor/types';

export interface StageRow {
  teamtailor_id: string;
  job_id: string | null;
  name: string;
  slug: string | null;
  position: number | null;
  category: string | null;
  raw_data: unknown;
}

export const stagesSyncer: EntitySyncer<StageRow> = {
  entity: 'stages',
  buildInitialRequest(_cursor: string | null) {
    throw new Error('stagesSyncer.buildInitialRequest: not implemented');
  },
  mapResource(_resource: TTParsedResource): StageRow {
    throw new Error('stagesSyncer.mapResource: not implemented');
  },
  async upsert(_rows: StageRow[], _deps: SyncerDeps): Promise<number> {
    throw new Error('stagesSyncer.upsert: not implemented');
  },
};
