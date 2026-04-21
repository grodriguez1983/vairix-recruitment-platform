/**
 * CV variant classifier (ADR-012 §1).
 *
 * STUB: GREEN implementation lands in the next commit. Exists so the
 * test file typechecks during the RED phase.
 */

export type CvVariant = 'linkedin_export' | 'cv_primary';

export type VariantClassification = {
  variant: CvVariant;
  confidence: number;
};

export function classifyVariant(_parsedText: string): VariantClassification {
  return { variant: 'cv_primary', confidence: 0 };
}
