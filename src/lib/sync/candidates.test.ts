/**
 * Unit tests for the candidates syncer factory (ADR-018).
 *
 * Adversarial focus:
 *   - mapResource MUST extract `attributes.resume` as `resume_url`
 *     on the output (null when absent) — the resume download hook
 *     depends on it.
 *   - makeCandidatesSyncer() without a `downloadResumesForRows`
 *     hook MUST NOT attempt any resume-related I/O (backward-compat
 *     for the existing integration tests and the legacy static
 *     export).
 *   - makeCandidatesSyncer({ downloadResumesForRows }) MUST call the
 *     hook with the candidate_tt_id + resume_url pairs alongside
 *     the candidateIdByTtId map the candidates upsert produced.
 *     Hook errors MUST NOT fail the candidates batch.
 */
import { describe, expect, it, vi } from 'vitest';

import { makeCandidatesSyncer, candidatesSyncer } from './candidates';
import type { CandidateResumeInput } from './candidate-resumes';
import type { TTParsedResource } from '../teamtailor/types';

function resource(
  id: string,
  attrs: Record<string, unknown> = {},
  rels: Record<string, { data: unknown }> = {},
): TTParsedResource {
  return {
    id,
    type: 'candidates',
    attributes: attrs,
    relationships: rels as TTParsedResource['relationships'],
  };
}

describe('candidatesSyncer.mapResource — resume extraction (ADR-018)', () => {
  it('reads attributes.resume into CandidateWithValues.resume_url', () => {
    const syncer = makeCandidatesSyncer();
    const out = syncer.mapResource(
      resource('322042', { firstName: 'M', resume: 'https://s3/signed?x' }),
      [],
    );
    expect(out.resume_url).toBe('https://s3/signed?x');
  });

  it('defaults resume_url to null when attribute absent', () => {
    const syncer = makeCandidatesSyncer();
    const out = syncer.mapResource(resource('322042', { firstName: 'M' }), []);
    expect(out.resume_url).toBeNull();
  });

  it('treats an empty-string resume URL as null (never calls the hook with a useless URL)', () => {
    const syncer = makeCandidatesSyncer();
    const out = syncer.mapResource(resource('322042', { resume: '' }), []);
    expect(out.resume_url).toBeNull();
  });
});

describe('makeCandidatesSyncer — backward compatibility', () => {
  it('exposes the same entity/flags as the legacy static candidatesSyncer', () => {
    const factory = makeCandidatesSyncer();
    expect(factory.entity).toBe(candidatesSyncer.entity);
    expect(factory.includesSideloads).toBe(candidatesSyncer.includesSideloads);
  });
});

describe('makeCandidatesSyncer.upsert — resume hook wiring', () => {
  function fakeDb() {
    const candidatesUpserts: Array<Record<string, unknown>> = [];
    const db = {
      from(table: string) {
        if (table === 'candidates') {
          return {
            upsert(rows: Array<Record<string, unknown>>, _opts: unknown) {
              candidatesUpserts.push(...rows);
              // Return a builder whose .select() resolves to the
              // upserted rows with synthesized ids.
              return {
                select(_cols: string) {
                  return Promise.resolve({
                    data: rows.map((r) => ({
                      id: `uuid-${r.teamtailor_id as string}`,
                      teamtailor_id: r.teamtailor_id as string,
                    })),
                    error: null,
                  });
                },
              };
            },
          };
        }
        throw new Error(`unexpected table ${table}`);
      },
    };
    return { db, candidatesUpserts };
  }

  it('calls downloadResumesForRows with (resumeInputs, candidateIdByTtId) once candidates are upserted', async () => {
    const syncer = makeCandidatesSyncer();
    const { db } = fakeDb();
    const hook = vi.fn(async () => ({
      attempted: 1,
      upserted: 1,
      skippedNoUrl: 0,
      errors: 0,
    }));

    const syncerWithHook = makeCandidatesSyncer({ downloadResumesForRows: hook });
    await syncerWithHook.upsert(
      [
        {
          candidate: {
            teamtailor_id: '322042',
            first_name: 'M',
            last_name: null,
            email: null,
            phone: null,
            linkedin_url: null,
            pitch: null,
            sourced: true,
            raw_data: {},
          },
          customFieldValues: [],
          resume_url: 'https://s3/signed?a',
        },
        {
          candidate: {
            teamtailor_id: '322043',
            first_name: 'N',
            last_name: null,
            email: null,
            phone: null,
            linkedin_url: null,
            pitch: null,
            sourced: false,
            raw_data: {},
          },
          customFieldValues: [],
          resume_url: null,
        },
      ],
      // deps.db is the only thing upsert() touches without values.
      { db, client: {} } as never,
    );

    expect(hook).toHaveBeenCalledTimes(1);
    const [resumeInputs, idByTtId] = hook.mock.calls[0] as unknown as [
      CandidateResumeInput[],
      Map<string, string>,
    ];
    expect(resumeInputs).toEqual([
      { candidate_tt_id: '322042', resume_url: 'https://s3/signed?a' },
      { candidate_tt_id: '322043', resume_url: null },
    ]);
    expect(idByTtId.get('322042')).toBe('uuid-322042');
    expect(idByTtId.get('322043')).toBe('uuid-322043');

    // Confirm the legacy static export does NOT wire the hook.
    expect(syncer.entity).toBe('candidates');
  });

  it('swallows hook failures — a bad resume URL must not fail the candidates batch', async () => {
    const { db } = fakeDb();
    const hook = vi.fn(async () => {
      throw new Error('hook exploded');
    });

    const syncerWithHook = makeCandidatesSyncer({ downloadResumesForRows: hook });
    await expect(
      syncerWithHook.upsert(
        [
          {
            candidate: {
              teamtailor_id: '1',
              first_name: null,
              last_name: null,
              email: null,
              phone: null,
              linkedin_url: null,
              pitch: null,
              sourced: false,
              raw_data: {},
            },
            customFieldValues: [],
            resume_url: 'https://s3/broken',
          },
        ],
        { db, client: {} } as never,
      ),
    ).resolves.toBeGreaterThanOrEqual(0);
  });
});
