/**
 * Users syncer.
 *
 * Maps Teamtailor `users` resources (evaluators/recruiters, NOT
 * platform app users) to rows in the local `users` table.
 *
 * Tolerance: Teamtailor preserves "invisible" / deleted users with
 * `visible: false` and nullable `email`/`role`. We keep those rows so
 * historical evaluations still resolve their evaluator, but flag them
 * with `active = false`.
 */
import type { TTParsedResource } from '../teamtailor/types';
import type { EntitySyncer, SyncerDeps } from './run';
import { SyncError } from './errors';

export interface UserRow {
  teamtailor_id: string;
  email: string | null;
  full_name: string | null;
  role: string | null;
  active: boolean;
  raw_data: unknown;
}

function optionalString(attrs: Record<string, unknown>, key: string): string | null {
  const v = attrs[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

export const usersSyncer: EntitySyncer<UserRow> = {
  entity: 'users',

  buildInitialRequest(cursor: string | null) {
    const params: Record<string, string> = { 'page[size]': '30' };
    if (cursor) params['filter[updated-at][from]'] = cursor;
    return { path: '/users', params };
  },

  mapResource(resource: TTParsedResource): UserRow {
    const attrs = resource.attributes;
    // `visible` defaults to true when Teamtailor omits it; only an
    // explicit `false` flips the user to inactive.
    const visible = attrs['visible'];
    const active = visible === false ? false : true;
    return {
      teamtailor_id: resource.id,
      email: optionalString(attrs, 'email'),
      full_name: optionalString(attrs, 'name'),
      role: optionalString(attrs, 'role'),
      active,
      raw_data: resource,
    };
  },

  async upsert(rows: UserRow[], deps: SyncerDeps): Promise<number> {
    if (rows.length === 0) return 0;
    const { error } = await deps.db.from('users').upsert(rows, { onConflict: 'teamtailor_id' });
    if (error) {
      throw new SyncError('users upsert failed', {
        cause: error.message,
        count: rows.length,
      });
    }
    return rows.length;
  },
};
