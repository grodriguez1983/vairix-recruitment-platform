/**
 * `/admin/skills/:id` — single-skill editor (ADR-013 §6).
 *
 * Server-rendered scaffold + a client editor. Slug is immutable
 * (used across `experience_skills.skill_id`); to rename a skill
 * deprecate this one and create a new one at the slug you want.
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { requireRole } from '@/lib/auth/require';
import { getSkill } from '@/lib/skills/admin-service';
import { createClient } from '@/lib/supabase/server';

import { SkillEditor } from './skill-editor';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

interface PageProps {
  params: { id: string };
}

export async function generateMetadata({ params }: PageProps): Promise<{ title: string }> {
  return { title: `Skill ${params.id.slice(0, 8)} — Admin` };
}

export default async function SkillDetailPage({ params }: PageProps): Promise<JSX.Element> {
  await requireRole('admin');
  if (!UUID_RE.test(params.id)) notFound();
  const db = createClient();

  const skill = await getSkill(db, params.id);
  if (!skill) notFound();

  return (
    <div className="mx-auto max-w-3xl">
      <header className="mb-6">
        <Link
          href="/admin/skills"
          className="font-mono text-xs text-text-muted hover:text-text-primary"
        >
          ← Skills catalog
        </Link>
        <h1 className="mt-2 font-mono text-2xl font-semibold text-text-primary">{skill.slug}</h1>
        <p className="mt-1 text-sm text-text-muted">
          {skill.canonical_name}
          {skill.category && (
            <span className="ml-2 rounded bg-bg px-1.5 py-0.5 font-mono text-[10px] text-text-muted">
              {skill.category}
            </span>
          )}
          {skill.deprecated_at && (
            <span className="ml-2 rounded bg-danger/10 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-danger">
              deprecated {new Date(skill.deprecated_at).toISOString().slice(0, 10)}
            </span>
          )}
        </p>
        <p className="mt-1 font-mono text-[11px] text-text-muted">
          {skill.usage_count} experience_skills row{skill.usage_count === 1 ? '' : 's'} linked
        </p>
      </header>

      <SkillEditor skill={skill} />
    </div>
  );
}
