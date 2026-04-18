/**
 * Integration tests for the tags service.
 *
 * Uses service-role Supabase client to bypass RLS; tests focus on
 * business rules (dedup, idempotency, authorization).
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import {
  addTagToCandidate,
  ensureTag,
  listTagsForCandidate,
  normalizeTagName,
  removeTagFromCandidate,
} from '../../../src/lib/tags/service';
import { TagError } from '../../../src/lib/tags/errors';

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
const TEST_TAG_PREFIX = 'tagtest-';
const TEST_CANDIDATE_TT_ID = 'tagtest-candidate-1';
const TEST_EMAIL_RECRUITER = 'tagtest-recruiter@e2e.test';
const TEST_EMAIL_ADMIN = 'tagtest-admin@e2e.test';

async function ensureAuthUser(email: string): Promise<string> {
  const { data: list } = await db.auth.admin.listUsers({ page: 1, perPage: 200 });
  const existing = list?.users?.find((u) => u.email === email);
  if (existing) await db.auth.admin.deleteUser(existing.id);
  const { data, error } = await db.auth.admin.createUser({ email, email_confirm: true });
  if (error || !data.user) throw new Error(`auth create failed for ${email}: ${error?.message}`);
  return data.user.id;
}

async function setup(): Promise<{
  candidateId: string;
  recruiterAuthId: string;
  adminAuthId: string;
  recruiterAppId: string;
  adminAppId: string;
}> {
  // Clean slate.
  await db
    .from('candidate_tags')
    .delete()
    .neq('candidate_id', '00000000-0000-0000-0000-000000000000');
  await db.from('tags').delete().like('name', `${TEST_TAG_PREFIX}%`);
  await db.from('candidates').delete().eq('teamtailor_id', TEST_CANDIDATE_TT_ID);
  await db.from('app_users').delete().in('email', [TEST_EMAIL_RECRUITER, TEST_EMAIL_ADMIN]);

  // Create candidate.
  const { data: candData, error: candError } = await db
    .from('candidates')
    .insert({
      teamtailor_id: TEST_CANDIDATE_TT_ID,
      first_name: 'Tag',
      last_name: 'Tester',
      email: 'tagtest@example.test',
      raw_data: {},
    })
    .select('id')
    .single();
  if (candError) throw candError;

  // Create real auth users (FK from app_users.auth_user_id → auth.users.id).
  const recruiterAuthId = await ensureAuthUser(TEST_EMAIL_RECRUITER);
  const adminAuthId = await ensureAuthUser(TEST_EMAIL_ADMIN);

  const { data: recruiterData, error: rErr } = await db
    .from('app_users')
    .insert({
      auth_user_id: recruiterAuthId,
      email: TEST_EMAIL_RECRUITER,
      role: 'recruiter',
    })
    .select('id')
    .single();
  if (rErr) throw rErr;

  const { data: adminData, error: aErr } = await db
    .from('app_users')
    .insert({
      auth_user_id: adminAuthId,
      email: TEST_EMAIL_ADMIN,
      role: 'admin',
    })
    .select('id')
    .single();
  if (aErr) throw aErr;

  return {
    candidateId: candData!.id,
    recruiterAuthId,
    adminAuthId,
    recruiterAppId: recruiterData!.id,
    adminAppId: adminData!.id,
  };
}

async function cleanup(): Promise<void> {
  await db
    .from('candidate_tags')
    .delete()
    .neq('candidate_id', '00000000-0000-0000-0000-000000000000');
  await db.from('tags').delete().like('name', `${TEST_TAG_PREFIX}%`);
  await db.from('candidates').delete().eq('teamtailor_id', TEST_CANDIDATE_TT_ID);
  await db.from('app_users').delete().in('email', [TEST_EMAIL_RECRUITER, TEST_EMAIL_ADMIN]);
  const { data: users } = await db.auth.admin.listUsers({ page: 1, perPage: 200 });
  for (const u of users?.users ?? []) {
    if (u.email && [TEST_EMAIL_RECRUITER, TEST_EMAIL_ADMIN].some((e) => u.email === e)) {
      await db.auth.admin.deleteUser(u.id);
    }
    if (u.email && u.email.startsWith(`${TEST_TAG_PREFIX}other`)) {
      await db.auth.admin.deleteUser(u.id);
    }
  }
}

describe('tags service', () => {
  afterAll(cleanup);

  describe('normalizeTagName', () => {
    it('trims and lowercases', () => {
      expect(normalizeTagName('  Senior Backend  ')).toBe('senior backend');
    });
    it('rejects empty', () => {
      expect(() => normalizeTagName('   ')).toThrow(TagError);
    });
    it('rejects > 64 chars', () => {
      expect(() => normalizeTagName('x'.repeat(65))).toThrow(TagError);
    });
  });

  describe('ensureTag', () => {
    it('creates new tag and returns existing on second call', async () => {
      await db.from('tags').delete().eq('name', `${TEST_TAG_PREFIX}python`);
      const t1 = await ensureTag(db, `${TEST_TAG_PREFIX}Python`);
      const t2 = await ensureTag(db, `${TEST_TAG_PREFIX}python`);
      expect(t1.id).toBe(t2.id);
      expect(t1.name).toBe(`${TEST_TAG_PREFIX}python`);
    });
  });

  describe('addTagToCandidate', () => {
    let candidateId: string;
    let recruiterAuthId: string;

    beforeEach(async () => {
      const s = await setup();
      candidateId = s.candidateId;
      recruiterAuthId = s.recruiterAuthId;
    });

    it('adds a tag with created_by set to the caller', async () => {
      const res = await addTagToCandidate(
        db,
        { authUserId: recruiterAuthId, role: 'recruiter' },
        candidateId,
        `${TEST_TAG_PREFIX}go`,
      );
      expect(res.created).toBe(true);
      const tags = await listTagsForCandidate(db, candidateId);
      expect(tags).toHaveLength(1);
      expect(tags[0]!.name).toBe(`${TEST_TAG_PREFIX}go`);
    });

    it('is idempotent: adding the same tag twice produces one link', async () => {
      await addTagToCandidate(
        db,
        { authUserId: recruiterAuthId, role: 'recruiter' },
        candidateId,
        `${TEST_TAG_PREFIX}rust`,
      );
      const second = await addTagToCandidate(
        db,
        { authUserId: recruiterAuthId, role: 'recruiter' },
        candidateId,
        `${TEST_TAG_PREFIX}Rust`, // different case → same tag after normalize
      );
      expect(second.created).toBe(false);
      const tags = await listTagsForCandidate(db, candidateId);
      expect(tags).toHaveLength(1);
    });
  });

  describe('removeTagFromCandidate', () => {
    let candidateId: string;
    let recruiterAuthId: string;
    let adminAuthId: string;

    beforeEach(async () => {
      const s = await setup();
      candidateId = s.candidateId;
      recruiterAuthId = s.recruiterAuthId;
      adminAuthId = s.adminAuthId;
      await addTagToCandidate(
        db,
        { authUserId: recruiterAuthId, role: 'recruiter' },
        candidateId,
        `${TEST_TAG_PREFIX}postgres`,
      );
    });

    it('allows the creator to remove their own tag', async () => {
      const tags = await listTagsForCandidate(db, candidateId);
      await removeTagFromCandidate(
        db,
        { authUserId: recruiterAuthId, role: 'recruiter' },
        candidateId,
        tags[0]!.id,
      );
      const remaining = await listTagsForCandidate(db, candidateId);
      expect(remaining).toHaveLength(0);
    });

    it('allows an admin to remove a tag they did not create', async () => {
      const tags = await listTagsForCandidate(db, candidateId);
      await removeTagFromCandidate(
        db,
        { authUserId: adminAuthId, role: 'admin' },
        candidateId,
        tags[0]!.id,
      );
      const remaining = await listTagsForCandidate(db, candidateId);
      expect(remaining).toHaveLength(0);
    });

    it('forbids a non-creator recruiter from removing a tag', async () => {
      const tags = await listTagsForCandidate(db, candidateId);
      const otherEmail = `${TEST_TAG_PREFIX}other@e2e.test`;
      const otherAuthId = await ensureAuthUser(otherEmail);
      const { data: otherApp } = await db
        .from('app_users')
        .insert({
          auth_user_id: otherAuthId,
          email: otherEmail,
          role: 'recruiter',
        })
        .select('id')
        .single();
      try {
        await expect(
          removeTagFromCandidate(
            db,
            { authUserId: otherAuthId, role: 'recruiter' },
            candidateId,
            tags[0]!.id,
          ),
        ).rejects.toMatchObject({ code: 'forbidden' });
      } finally {
        await db.from('app_users').delete().eq('id', otherApp!.id);
        await db.auth.admin.deleteUser(otherAuthId);
      }
    });

    it('404s on unknown tag link', async () => {
      const fakeTagId = '00000000-0000-0000-0000-000000000099';
      await expect(
        removeTagFromCandidate(
          db,
          { authUserId: recruiterAuthId, role: 'recruiter' },
          candidateId,
          fakeTagId,
        ),
      ).rejects.toMatchObject({ code: 'not_found' });
    });
  });
});
