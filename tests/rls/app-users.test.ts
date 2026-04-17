/**
 * RLS tests for `app_users`.
 *
 * Access matrix (docs/data-model.md §16):
 *   - anonymous:  denied all
 *   - recruiter:  denied all
 *   - admin:      full R/W
 *
 * `app_users` is the app's user-management table; it must never be
 * readable by recruiters because it contains role assignments and
 * could leak org structure.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { anonClient, makeRoleClient, resetRlsState, serviceClient } from './helpers';

describe('rls: app_users', () => {
  const svc = serviceClient();

  beforeAll(async () => {
    await resetRlsState(svc);
  });

  afterEach(async () => {
    await resetRlsState(svc);
  });

  it('denies anonymous select', async () => {
    const anon = anonClient();
    const { data, error } = await anon.from('app_users').select('id').limit(1);
    // RLS returns empty result (not an error) for anon. Either zero rows
    // or a 401-ish error is acceptable — both mean "no visibility".
    expect(error?.code ?? data?.length ?? 0).toEqual(error ? error.code : 0);
    expect(data?.length ?? 0).toBe(0);
  });

  it('denies recruiter select', async () => {
    const { client } = await makeRoleClient('recruiter');
    const { data, error } = await client.from('app_users').select('id, role');
    // Recruiter sees zero rows (their own row included — by policy, not
    // just by RLS). Empty result or error = pass.
    expect(data?.length ?? 0).toBe(0);
    // No server error, just filtered out
    expect(error).toBeNull();
  });

  it('denies recruiter insert', async () => {
    const { client } = await makeRoleClient('recruiter');
    const { error } = await client.from('app_users').insert({
      auth_user_id: '00000000-0000-0000-0000-000000000001',
      email: 'hacker@rls.test',
      role: 'admin',
    });
    expect(error).not.toBeNull();
  });

  it('denies recruiter update of own row', async () => {
    const { client, appUserId } = await makeRoleClient('recruiter');
    const { error } = await client.from('app_users').update({ role: 'admin' }).eq('id', appUserId);
    // Either a policy error or a row-count of 0. Check that role was
    // NOT escalated by re-reading with service role.
    void error;
    const { data: verify } = await svc
      .from('app_users')
      .select('role')
      .eq('id', appUserId)
      .single();
    expect(verify?.role).toBe('recruiter');
  });

  it('allows admin select', async () => {
    const { client } = await makeRoleClient('admin');
    const { data, error } = await client.from('app_users').select('id, role');
    expect(error).toBeNull();
    // Admin sees at least their own row
    expect((data ?? []).length).toBeGreaterThanOrEqual(1);
  });

  it('allows admin insert', async () => {
    const { client } = await makeRoleClient('admin');
    // Seed an auth.users first — admin cannot create auth users via the
    // public API, so we use the service client for that step.
    const { data: authUser, error: authErr } = await svc.auth.admin.createUser({
      email: `extra-${Date.now()}@rls.test`,
      password: 'test-password-ignored',
      email_confirm: true,
    });
    expect(authErr).toBeNull();

    const { error } = await client.from('app_users').insert({
      auth_user_id: authUser!.user!.id,
      email: authUser!.user!.email!,
      role: 'recruiter',
    });
    expect(error).toBeNull();
  });

  it('allows admin update of any row', async () => {
    const { client: adminClient } = await makeRoleClient('admin');
    const { appUserId: recruiterId } = await makeRoleClient('recruiter');

    const { error } = await adminClient
      .from('app_users')
      .update({ full_name: 'Updated by admin' })
      .eq('id', recruiterId);
    expect(error).toBeNull();

    const { data: verify } = await svc
      .from('app_users')
      .select('full_name')
      .eq('id', recruiterId)
      .single();
    expect(verify?.full_name).toBe('Updated by admin');
  });
});
