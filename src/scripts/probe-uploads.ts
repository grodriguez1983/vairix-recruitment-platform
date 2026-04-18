/* eslint-disable no-console -- probe script: structured stdout is the feature */
/**
 * One-shot probe to resolve the F1-007 blocker: understand the
 * shape of Teamtailor `files` / `uploads` so we can design the
 * downloader + Storage wiring.
 *
 * Strategy: issue two small GETs (3 primary records each) against
 * the live tenant through the existing client (rate limit + retry
 * + JSON:API parse apply uniformly):
 *
 *   1. GET /candidates?include=uploads&page[size]=3
 *      → does `uploads` come sideloaded on candidates? what fields?
 *   2. GET /uploads?page[size]=3
 *      → is there a top-level endpoint? what fields?
 *
 * Output is **structural, not content**: we print relationship keys,
 * attribute names, resource types, and redacted URLs (first 80
 * chars). No candidate names/emails/pitch bodies leak to stdout.
 *
 * This script is read-only. Safe to run against prod data.
 */
import type { TTParsedResource } from '../lib/teamtailor/types';
import { TeamtailorClient } from '../lib/teamtailor/client';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) {
    console.error(`[probe] missing required env var: ${name}`);
    process.exit(2);
  }
  return v;
}

function redactUrl(value: unknown): string {
  if (typeof value !== 'string') return `<${typeof value}>`;
  if (value.length <= 80) return value;
  return `${value.slice(0, 80)}… (len=${value.length})`;
}

function summarizeAttributes(attrs: Record<string, unknown> | undefined): Record<string, string> {
  if (!attrs) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null) out[k] = 'null';
    else if (typeof v === 'string') {
      // Only echo URLs and enum-like short strings verbatim; truncate rest.
      if (/^https?:\/\//i.test(v)) out[k] = redactUrl(v);
      else if (v.length <= 40) out[k] = `"${v}"`;
      else out[k] = `<string len=${v.length}>`;
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      out[k] = String(v);
    } else if (Array.isArray(v)) {
      out[k] = `<array len=${v.length}>`;
    } else if (typeof v === 'object') {
      out[k] = `<object keys=${Object.keys(v as object).join(',')}>`;
    } else {
      out[k] = `<${typeof v}>`;
    }
  }
  return out;
}

function summarizeRelationships(
  rels: Record<string, { data?: unknown }> | undefined,
): Record<string, string> {
  if (!rels) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(rels)) {
    const data = (v as { data?: unknown }).data;
    if (data === null) out[k] = 'null';
    else if (Array.isArray(data)) out[k] = `to-many (${data.length})`;
    else if (typeof data === 'object' && data !== null) {
      const d = data as { type?: string; id?: string };
      out[k] = `to-one (${d.type}#${d.id})`;
    } else {
      out[k] = `<${typeof data}>`;
    }
  }
  return out;
}

function dumpResource(label: string, r: TTParsedResource): void {
  console.log(`\n── ${label}: ${r.type}#${r.id}`);
  console.log('   attributes:');
  for (const [k, v] of Object.entries(
    summarizeAttributes(r.attributes as Record<string, unknown>),
  )) {
    console.log(`     ${k}: ${v}`);
  }
  console.log('   relationships:');
  for (const [k, v] of Object.entries(summarizeRelationships(r.relationships))) {
    console.log(`     ${k}: ${v}`);
  }
}

async function probeCandidatesWithUploads(client: TeamtailorClient): Promise<void> {
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║ Probe 1: /candidates?include=uploads&page[size]=3 ║');
  console.log('╚══════════════════════════════════════════════════╝');
  try {
    const doc = await client.get('/candidates', {
      'page[size]': '3',
      include: 'uploads',
    });
    console.log(`\nprimary count: ${doc.data.length}`);
    console.log(`included count: ${doc.included?.length ?? 0}`);

    for (const r of doc.data) {
      console.log(
        `\n  candidate#${r.id} relationships: ${Object.keys(r.relationships ?? {}).join(', ')}`,
      );
      const rels = r.relationships ?? {};
      if ('uploads' in rels) {
        console.log(`    ✔ uploads is in relationships`);
        const u = (rels as { uploads?: { data?: unknown } }).uploads;
        console.log(`    uploads.data shape: ${JSON.stringify(u?.data ?? null).slice(0, 200)}`);
      } else {
        console.log(`    ✘ no "uploads" key in relationships`);
      }
    }

    const includedUploads = (doc.included ?? []).filter(
      (inc) => inc.type === 'uploads' || inc.type === 'files' || inc.type === 'upload',
    );
    console.log(`\nincluded uploads/files count: ${includedUploads.length}`);
    for (const r of includedUploads.slice(0, 3)) {
      dumpResource('included', r);
    }

    // Also show non-upload included types so we know what else leaks in.
    const otherTypes = new Set(
      (doc.included ?? [])
        .filter((r) => !['uploads', 'files', 'upload'].includes(r.type))
        .map((r) => r.type),
    );
    if (otherTypes.size > 0) {
      console.log(
        `\nother included types (not uploads/files): ${Array.from(otherTypes).join(', ')}`,
      );
    }
  } catch (e) {
    console.error('[probe 1] error:', e instanceof Error ? e.message : String(e));
    if (e instanceof Error && e.message.includes('HTTP')) {
      console.error(
        '[probe 1] hint: TT might reject `include=uploads` if the relationship name is different (e.g. `files`, `cv`, `documents`).',
      );
    }
  }
}

async function probeUploadsEndpoint(client: TeamtailorClient): Promise<void> {
  console.log('\n╔═════════════════════════════════════╗');
  console.log('║ Probe 2: /uploads?page[size]=3      ║');
  console.log('╚═════════════════════════════════════╝');
  try {
    const doc = await client.get('/uploads', { 'page[size]': '3' });
    console.log(`\nprimary count: ${doc.data.length}`);
    for (const r of doc.data) {
      dumpResource('primary', r);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`/uploads response: ${msg}`);
    if (msg.includes('HTTP 404')) {
      console.log('→ /uploads is NOT a top-level endpoint on this tenant.');
    } else if (msg.includes('HTTP 403') || msg.includes('HTTP 401')) {
      console.log('→ Top-level endpoint exists but token lacks scope or endpoint is gated.');
    }
  }
}

async function probeUploadsWithCandidate(client: TeamtailorClient): Promise<void> {
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║ Probe 3: /uploads?include=candidate&page[size]=3     ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  try {
    const doc = await client.get('/uploads', {
      'page[size]': '3',
      include: 'candidate',
    });
    console.log(`\nprimary count: ${doc.data.length}`);
    for (const r of doc.data) {
      // Full raw relationships (object keys + data shape).
      const raw = (r as unknown as { relationships?: Record<string, unknown> }).relationships ?? {};
      console.log(
        `\n  upload#${r.id} raw relationships JSON: ${JSON.stringify(raw).slice(0, 400)}`,
      );
    }
    const includedCandidates = (doc.included ?? []).filter((r) => r.type === 'candidates');
    console.log(`\nincluded candidates count: ${includedCandidates.length}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`/uploads?include=candidate response: ${msg}`);
  }
}

async function main(): Promise<void> {
  const apiKey = requireEnv('TEAMTAILOR_API_TOKEN');
  const apiVersion = requireEnv('TEAMTAILOR_API_VERSION');
  const baseUrl = process.env.TEAMTAILOR_BASE_URL ?? 'https://api.teamtailor.com/v1';

  console.log(`[probe] baseUrl=${baseUrl}`);
  console.log(`[probe] apiVersion=${apiVersion}`);
  console.log(`[probe] tokenLen=${apiKey.length} (redacted)`);

  const client = new TeamtailorClient({
    apiKey,
    apiVersion,
    baseUrl,
    rateLimit: { tokensPerSecond: 2, burst: 3 },
  });

  await probeCandidatesWithUploads(client);
  await probeUploadsEndpoint(client);
  await probeUploadsWithCandidate(client);

  console.log('\n[probe] done.');
}

void main().catch((e: unknown) => {
  console.error('[probe] fatal:', e instanceof Error ? e.stack : String(e));
  process.exit(1);
});
