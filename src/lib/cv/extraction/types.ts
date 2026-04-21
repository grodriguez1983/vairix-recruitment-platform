/**
 * Stub — will be replaced by Zod schema in GREEN commit.
 *
 * For RED: we just need the names to exist so typecheck passes and
 * tests fail by assertion (not by "undefined is not a function").
 */
import { z } from 'zod';

export const ExtractionResultSchema = z.never();

export type ExtractionResult = {
  source_variant: 'linkedin_export' | 'cv_primary';
  experiences: Array<{
    kind: 'work' | 'side_project' | 'education';
    company: string | null;
    title: string | null;
    start_date: string | null;
    end_date: string | null;
    description: string | null;
    skills: string[];
  }>;
  languages: Array<{ name: string; level: string | null }>;
};
