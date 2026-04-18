/**
 * Integration tests for the shortlist service.
 *
 * Covers business rules: normalization, idempotent add, archive
 * lifecycle, CSV formatting.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import {
  addCandidateToShortlist,
  archiveShortlist,
  candidatesToCsv,
  createShortlist,
  listActiveShortlists,
  listShortlistCandidates,
  normalizeShortlistName,
  removeCandidateFromShortlist,
} from '../../../src/lib/shortlists/service';
import { ShortlistError } from '../../../src/lib/shortlists/errors';

const SUPABASE_URL = process.env.SUPABASE_TEST_URL ?? 'http://127.0.0.1:54321';
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_TEST_SERVICE_ROLE_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

function svc(): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

const db = svc();
const PREFIX = 'sltest-';
const EMAIL = `${PREFIX}owner@e2e.test`;
const CANDIDATE_IDS = [`${PREFIX}cand1`, `${PREFIX}cand2`];

async function ensureAuthUser(email: string): Promise<string> {
  const { data: list } = await db.auth.admin.listUsers({ page: 1, perPage: 200 });
  const existing = list?.users?.find((u) => u.email === email);
  if (existing) await db.auth.admin.deleteUser(existing.id);
  const { data, error } = await db.auth.admin.createUser({ email, email_confirm: true });
  if (error || !data.user) throw new Error(`auth create failed for ${email}: ${error?.message}`);
  return data.user.id;
}

interface Fixture {
  authUserId: string;
  appUserId: string;
  candidateIds: string[];
}

async function setup(): Promise<Fixture> {
  // Wipe prior test artifacts.
  await db
    .from('shortlist_candidates')
    .delete()
    .neq('shortlist_id', '00000000-0000-0000-0000-000000000000');
  await db.from('shortlists').delete().like('name', `${PREFIX}%`);
  await db.from('candidates').delete().in('teamtailor_id', CANDIDATE_IDS);
  await db.from('app_users').delete().eq('email', EMAIL);

  const authUserId = await ensureAuthUser(EMAIL);
  const { data: appUser, error } = await db
    .from('app_users')
    .insert({ auth_user_id: authUserId, email: EMAIL, role: 'recruiter' })
    .select('id')
    .single();
  if (error) throw error;

  const { data: cands, error: cerr } = await db
    .from('candidates')
    .insert(
      CANDIDATE_IDS.map((tt, i) => ({
        teamtailor_id: tt,
        first_name: `Cand${i + 1}`,
        last_name: 'Test',
        email: `${tt}@example.test`,
        raw_data: {},
      })),
    )
    .select('id, teamtailor_id');
  if (cerr) throw cerr;

  // Sort by our deterministic tt_id so the mapping stays predictable.
  const ordered = (cands ?? [])
    .slice()
    .sort((a, b) => (a.teamtailor_id as string).localeCompare(b.teamtailor_id as string));

  return {
    authUserId,
    appUserId: appUser!.id,
    candidateIds: ordered.map((c) => c.id as string),
  };
}

async function cleanup(): Promise<void> {
  await db
    .from('shortlist_candidates')
    .delete()
    .neq('shortlist_id', '00000000-0000-0000-0000-000000000000');
  await db.from('shortlists').delete().like('name', `${PREFIX}%`);
  await db.from('candidates').delete().in('teamtailor_id', CANDIDATE_IDS);
  await db.from('app_users').delete().eq('email', EMAIL);
  const { data: users } = await db.auth.admin.listUsers({ page: 1, perPage: 200 });
  for (const u of users?.users ?? []) {
    if (u.email === EMAIL) await db.auth.admin.deleteUser(u.id);
  }
}

describe('shortlist service', () => {
  afterAll(cleanup);

  describe('normalizeShortlistName', () => {
    it('trims', () => {
      expect(normalizeShortlistName('  my list  ')).toBe('my list');
    });
    it('rejects empty', () => {
      expect(() => normalizeShortlistName('   ')).toThrow(ShortlistError);
    });
    it('rejects > 120 chars', () => {
      expect(() => normalizeShortlistName('x'.repeat(121))).toThrow(ShortlistError);
    });
  });

  describe('create + list + add + remove + archive', () => {
    let authUserId: string;
    let candidateIds: string[];

    beforeEach(async () => {
      const s = await setup();
      authUserId = s.authUserId;
      candidateIds = s.candidateIds;
    });

    it('creates a shortlist and lists it as active', async () => {
      const sl = await createShortlist(
        db,
        { authUserId, role: 'recruiter' },
        { name: `${PREFIX}Hot backend candidates` },
      );
      expect(sl.id).toBeTruthy();
      const active = await listActiveShortlists(db);
      expect(active.find((s) => s.id === sl.id)).toBeDefined();
    });

    it('adds a candidate idempotently', async () => {
      const sl = await createShortlist(
        db,
        { authUserId, role: 'recruiter' },
        { name: `${PREFIX}shortlist-idem` },
      );
      const first = await addCandidateToShortlist(
        db,
        { authUserId, role: 'recruiter' },
        sl.id,
        candidateIds[0]!,
      );
      expect(first.created).toBe(true);
      const second = await addCandidateToShortlist(
        db,
        { authUserId, role: 'recruiter' },
        sl.id,
        candidateIds[0]!,
      );
      expect(second.created).toBe(false);
      const cands = await listShortlistCandidates(db, sl.id);
      expect(cands).toHaveLength(1);
    });

    it('removes a candidate; removing twice throws not_in_shortlist', async () => {
      const sl = await createShortlist(
        db,
        { authUserId, role: 'recruiter' },
        { name: `${PREFIX}rm` },
      );
      await addCandidateToShortlist(db, { authUserId, role: 'recruiter' }, sl.id, candidateIds[0]!);
      await removeCandidateFromShortlist(db, sl.id, candidateIds[0]!);
      await expect(removeCandidateFromShortlist(db, sl.id, candidateIds[0]!)).rejects.toMatchObject(
        { code: 'not_in_shortlist' },
      );
    });

    it('archive prevents further adds; archiving twice throws', async () => {
      const sl = await createShortlist(
        db,
        { authUserId, role: 'recruiter' },
        { name: `${PREFIX}arch` },
      );
      await archiveShortlist(db, sl.id);
      await expect(
        addCandidateToShortlist(db, { authUserId, role: 'recruiter' }, sl.id, candidateIds[0]!),
      ).rejects.toMatchObject({ code: 'already_archived' });
      await expect(archiveShortlist(db, sl.id)).rejects.toMatchObject({
        code: 'already_archived',
      });
    });

    it('listActiveShortlists excludes archived shortlists', async () => {
      const slA = await createShortlist(
        db,
        { authUserId, role: 'recruiter' },
        { name: `${PREFIX}visible` },
      );
      const slB = await createShortlist(
        db,
        { authUserId, role: 'recruiter' },
        { name: `${PREFIX}hidden` },
      );
      await archiveShortlist(db, slB.id);
      const active = await listActiveShortlists(db);
      const ids = active.map((s) => s.id);
      expect(ids).toContain(slA.id);
      expect(ids).not.toContain(slB.id);
    });
  });

  describe('candidatesToCsv', () => {
    it('emits RFC 4180 rows', () => {
      const csv = candidatesToCsv([
        {
          candidate_id: 'abc-123',
          note: 'Strong, Postgres',
          added_at: '2026-04-10T10:00:00.000Z',
          first_name: 'Ada',
          last_name: 'Lovelace',
          email: 'ada@example.test',
        },
        {
          candidate_id: 'def-456',
          note: 'Has "Rust" experience',
          added_at: '2026-04-11T10:00:00.000Z',
          first_name: null,
          last_name: null,
          email: null,
        },
      ]);
      const lines = csv.trim().split('\n');
      expect(lines[0]).toBe('candidate_id,first_name,last_name,email,note,added_at');
      // Note with comma wrapped in quotes.
      expect(lines[1]).toContain('"Strong, Postgres"');
      // Note with embedded quote doubled.
      expect(lines[2]).toContain('"Has ""Rust"" experience"');
    });
  });
});
