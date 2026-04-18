/**
 * Notes syncer — [RED] stub.
 *
 * Full implementation lands in the paired [GREEN] commit. The stub
 * exists only so typecheck can pass while the test is failing.
 */
import type { TTParsedResource } from '../teamtailor/types';
import type { EntitySyncer, SyncerDeps } from './run';

export interface NoteStaging {
  teamtailor_id: string;
  candidate_tt_id: string;
  application_tt_id: string | null;
  user_tt_id: string | null;
  body: string;
  raw_data: unknown;
}

export const notesSyncer: EntitySyncer<NoteStaging> = {
  entity: 'notes',
  buildInitialRequest(_cursor: string | null) {
    return { path: '/notes' };
  },
  mapResource(_resource: TTParsedResource): NoteStaging {
    throw new Error('notesSyncer.mapResource not implemented');
  },
  async upsert(_rows: NoteStaging[], _deps: SyncerDeps): Promise<number> {
    throw new Error('notesSyncer.upsert not implemented');
  },
};
