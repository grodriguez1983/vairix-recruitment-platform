/**
 * `/candidates/[id]` — consolidated candidate profile (UC-04).
 *
 * This page is the orchestration layer only: it validates the UUID
 * param, fetches the candidate row under RLS, and delegates every
 * content block to a sibling section component (one file per concern,
 * each colocated in this route directory).
 *
 * RLS does the heavy lifting: recruiters never reach rows with
 * `deleted_at IS NOT NULL`, so a 404 here can mean the candidate
 * never existed OR was soft-deleted — both are "not visible" from
 * the recruiter's perspective.
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { requireAuth } from '@/lib/auth/require';
import { listActiveShortlists } from '@/lib/shortlists/service';
import { createClient } from '@/lib/supabase/server';
import { listTagsForCandidate, listAllTagNames } from '@/lib/tags/service';

import { AddToShortlist } from './add-to-shortlist';
import { ApplicationsSection, fetchApplications } from './applications-section';
import { CandidateTags } from './candidate-tags';
import { CvsSection, fetchCvFiles } from './cvs-section';
import { EvaluationsSection, fetchEvaluations } from './evaluations-section';
import { MetadataVairixSection, fetchCustomFieldValues } from './metadata-vairix-section';
import { NotesSection, fetchNotes } from './notes-section';
import { ProfileHeader, type CandidateHeaderData } from './profile-header';
import { VairixSheetSection, fetchVairixSheet } from './vairix-sheet-section';

export const dynamic = 'force-dynamic';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface PageProps {
  params: { id: string };
}

interface CandidateRow extends CandidateHeaderData {
  id: string;
  created_at: string;
}

export async function generateMetadata({ params }: PageProps): Promise<{ title: string }> {
  return { title: `Candidate ${params.id.slice(0, 8)} — Recruitment Data Platform` };
}

export default async function CandidateProfilePage({ params }: PageProps): Promise<JSX.Element> {
  const auth = await requireAuth();

  if (!UUID_REGEX.test(params.id)) {
    notFound();
  }

  const supabase = createClient();
  const { data: candidate } = await supabase
    .from('candidates')
    .select('id, first_name, last_name, email, phone, linkedin_url, pitch, created_at, updated_at')
    .eq('id', params.id)
    .maybeSingle();

  if (!candidate) {
    notFound();
  }

  const c = candidate as CandidateRow;

  const [
    applications,
    customFieldValues,
    tags,
    allTagNames,
    activeShortlists,
    vairixSheet,
    cvFiles,
    evaluations,
    notes,
  ] = await Promise.all([
    fetchApplications(supabase, c.id).catch(() => []),
    fetchCustomFieldValues(supabase, c.id).catch(() => []),
    listTagsForCandidate(supabase, c.id).catch(() => []),
    listAllTagNames(supabase).catch(() => [] as string[]),
    listActiveShortlists(supabase).catch(() => []),
    fetchVairixSheet(supabase, c.id).catch(() => ({
      url: null,
      uploadedFileId: null,
      uploadedFileName: null,
    })),
    fetchCvFiles(supabase, c.id).catch(() => []),
    fetchEvaluations(supabase, c.id).catch(() => []),
    fetchNotes(supabase, c.id).catch(() => []),
  ]);

  const shortlistOptions = activeShortlists.map((sl) => ({ id: sl.id, name: sl.name }));

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-4">
        <Link
          href="/candidates"
          className="text-xs font-medium text-text-muted hover:text-text-primary"
        >
          ← Back to candidates
        </Link>
      </div>

      <ProfileHeader c={c} />

      <MetadataVairixSection values={customFieldValues} />

      <ApplicationsSection applications={applications} />

      <VairixSheetSection
        sheet={vairixSheet}
        candidateId={c.id}
        canUpload={auth.role === 'admin'}
      />

      <CvsSection files={cvFiles} />

      <EvaluationsSection evaluations={evaluations} />

      <NotesSection notes={notes} />

      <CandidateTags candidateId={c.id} initialTags={tags} allTagNames={allTagNames} />

      <AddToShortlist candidateId={c.id} shortlists={shortlistOptions} />
    </div>
  );
}
