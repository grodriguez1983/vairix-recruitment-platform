/**
 * Users syncer.
 *
 * Stub — implementación en [GREEN] siguiente.
 */
import type { EntitySyncer, SyncerDeps } from './run';
import type { TTParsedResource } from '../teamtailor/types';

export interface UserRow {
  teamtailor_id: string;
  email: string | null;
  full_name: string | null;
  role: string | null;
  active: boolean;
  raw_data: unknown;
}

export const usersSyncer: EntitySyncer<UserRow> = {
  entity: 'users',
  buildInitialRequest(_cursor: string | null) {
    throw new Error('usersSyncer.buildInitialRequest: not implemented');
  },
  mapResource(_resource: TTParsedResource): UserRow {
    throw new Error('usersSyncer.mapResource: not implemented');
  },
  async upsert(_rows: UserRow[], _deps: SyncerDeps): Promise<number> {
    throw new Error('usersSyncer.upsert: not implemented');
  },
};
