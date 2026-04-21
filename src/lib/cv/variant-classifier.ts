/**
 * CV variant classifier (ADR-012 §1).
 *
 * Función pura, sin I/O. Decide si un `parsed_text` proviene de un
 * LinkedIn PDF export (formato estructurado y predecible → parser
 * determinístico) o de un CV libre (`cv_primary` → extractor LLM).
 *
 * Diseño del score (heurísticas conservadoras, roadmap F4-003):
 *
 *   +3  secuencia ordenada "Contact" → "Experience" → "Education"
 *       (cada uno como header autónomo de línea, en ese orden)
 *   +2  header "Top Skills" (exclusivo de LinkedIn)
 *   +1  URL linkedin.com/in/<slug> en cualquier parte del texto
 *   +1  ≥ 2 patrones de fecha "<Month> <Year> - Present" o
 *       "MM/YYYY - Present"
 *
 * Threshold: score ≥ 3 → linkedin_export. En caso contrario,
 * cv_primary (default seguro, ADR-012 §7 — pasar un LinkedIn al LLM
 * es más barato que parsear mal un CV real con el parser
 * determinístico).
 *
 * Case-sensitivity: los headers reconocidos deben aparecer con
 * capitalización inicial ("Contact", no "contact"). LinkedIn
 * siempre exporta así; bajar la barra a case-insensitive produce
 * falsos positivos en prosa ("please contact me").
 */

export type CvVariant = 'linkedin_export' | 'cv_primary';

export type VariantClassification = {
  variant: CvVariant;
  confidence: number;
};

const CONFIDENCE_THRESHOLD = 3;

const LINKEDIN_URL_REGEX = /\blinkedin\.com\/in\/[a-z0-9-]+/i;

// Regex para un header autónomo: la palabra en una línea propia
// (precedida y seguida por \s o fin de texto), con capitalización
// inicial y sin más contenido en la misma línea. Esto es lo que
// LinkedIn exporta textualmente. `^` usa flag `m` = inicio de línea.
const CONTACT_HEADER = /^Contact\s*$/m;
const EXPERIENCE_HEADER = /^Experience\s*$/m;
const EDUCATION_HEADER = /^Education\s*$/m;
const TOP_SKILLS_HEADER = /^Top Skills\s*$/m;

// "Month Year - Present" (inglés completo) o "MM/YYYY - Present".
const MONTHS =
  'January|February|March|April|May|June|July|August|September|October|November|December';
const PRESENT_DATE_REGEX = new RegExp(
  `(?:(?:${MONTHS})\\s+\\d{4}|\\d{1,2}/\\d{4})\\s*[-–]\\s*Present`,
  'g',
);

/**
 * Devuelve la posición (índice en el texto) del primer match del
 * header, o -1. Sirve para verificar el orden Contact → Experience
 * → Education sin hacer tres matchAll.
 */
function firstMatchIndex(text: string, regex: RegExp): number {
  const m = text.match(regex);
  if (!m || m.index === undefined) return -1;
  return m.index;
}

export function classifyVariant(parsedText: string): VariantClassification {
  if (typeof parsedText !== 'string' || parsedText.trim().length === 0) {
    return { variant: 'cv_primary', confidence: 0 };
  }

  let score = 0;

  // +3 — secuencia ordenada Contact → Experience → Education
  const iContact = firstMatchIndex(parsedText, CONTACT_HEADER);
  const iExperience = firstMatchIndex(parsedText, EXPERIENCE_HEADER);
  const iEducation = firstMatchIndex(parsedText, EDUCATION_HEADER);
  if (iContact >= 0 && iExperience > iContact && iEducation > iExperience) {
    score += 3;
  }

  // +2 — Top Skills (exclusivo de LinkedIn)
  if (TOP_SKILLS_HEADER.test(parsedText)) {
    score += 2;
  }

  // +1 — URL linkedin.com/in/<slug>
  if (LINKEDIN_URL_REGEX.test(parsedText)) {
    score += 1;
  }

  // +1 — ≥ 2 patrones de fecha "... - Present"
  const presentMatches = parsedText.match(PRESENT_DATE_REGEX) ?? [];
  if (presentMatches.length >= 2) {
    score += 1;
  }

  const variant: CvVariant = score >= CONFIDENCE_THRESHOLD ? 'linkedin_export' : 'cv_primary';
  return { variant, confidence: score };
}
