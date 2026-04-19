/**
 * Unit tests for the evaluation source builder.
 *
 * Covers:
 *   - Returns null when the candidate has no usable evaluations.
 *   - Sorts evaluations chronologically and answers by question id —
 *     critical for hash-based cache invalidation.
 *   - Skips evaluations with no header / notes / answer values.
 *   - Surfaces typed-column values when free-text is empty.
 *   - Doesn't leak `null`/`undefined` literals into the embedding
 *     input.
 *   - Collapses internal whitespace inside notes and answer text.
 */
import { describe, expect, it } from 'vitest';

import { buildEvaluationContent } from './evaluation';

const EMPTY_ANSWER = {
  questionTtId: '',
  questionTitle: null,
  valueText: null,
  valueNumber: null,
  valueBoolean: null,
  valueDate: null,
  valueRange: null,
} as const;

describe('buildEvaluationContent', () => {
  it('returns null when there are no evaluations at all', () => {
    expect(buildEvaluationContent({ candidateId: 'c1', evaluations: [] })).toBeNull();
  });

  it('returns null when every evaluation is empty (no notes, no answers, no header)', () => {
    const out = buildEvaluationContent({
      candidateId: 'c1',
      evaluations: [
        {
          evaluationId: 'e1',
          decision: null,
          score: null,
          evaluatorName: null,
          notes: null,
          createdAt: '2024-01-01T00:00:00Z',
          answers: [],
        },
        {
          evaluationId: 'e2',
          decision: null,
          score: null,
          evaluatorName: null,
          notes: '   ',
          createdAt: '2024-01-02T00:00:00Z',
          answers: [{ ...EMPTY_ANSWER, questionTtId: '999', valueText: '   ' }],
        },
      ],
    });
    expect(out).toBeNull();
  });

  it('sorts evaluations chronologically (oldest first)', () => {
    const out = buildEvaluationContent({
      candidateId: 'c1',
      evaluations: [
        {
          evaluationId: 'e2',
          decision: 'pending',
          score: null,
          evaluatorName: null,
          notes: 'second',
          createdAt: '2024-02-01T00:00:00Z',
          answers: [],
        },
        {
          evaluationId: 'e1',
          decision: 'pending',
          score: null,
          evaluatorName: null,
          notes: 'first',
          createdAt: '2024-01-01T00:00:00Z',
          answers: [],
        },
      ],
    });
    expect(out).not.toBeNull();
    expect(out!.indexOf('first')).toBeLessThan(out!.indexOf('second'));
  });

  it('is deterministic: reshuffled evaluations and answers ⇒ same output', () => {
    const a = buildEvaluationContent({
      candidateId: 'c1',
      evaluations: [
        {
          evaluationId: 'e1',
          decision: 'accept',
          score: 4,
          evaluatorName: 'Ana',
          notes: 'good fit',
          createdAt: '2024-01-01T00:00:00Z',
          answers: [
            { ...EMPTY_ANSWER, questionTtId: '24016', valueText: 'https://docs/x' },
            { ...EMPTY_ANSWER, questionTtId: '10000', valueRange: 5 },
          ],
        },
      ],
    });
    const b = buildEvaluationContent({
      candidateId: 'c1',
      evaluations: [
        {
          evaluationId: 'e1',
          decision: 'accept',
          score: 4,
          evaluatorName: 'Ana',
          notes: 'good fit',
          createdAt: '2024-01-01T00:00:00Z',
          answers: [
            { ...EMPTY_ANSWER, questionTtId: '10000', valueRange: 5 },
            { ...EMPTY_ANSWER, questionTtId: '24016', valueText: 'https://docs/x' },
          ],
        },
      ],
    });
    expect(a).toBe(b);
  });

  it('uses typed-column value when valueText is empty', () => {
    const out = buildEvaluationContent({
      candidateId: 'c1',
      evaluations: [
        {
          evaluationId: 'e1',
          decision: null,
          score: null,
          evaluatorName: null,
          notes: null,
          createdAt: '2024-01-01T00:00:00Z',
          answers: [
            {
              ...EMPTY_ANSWER,
              questionTtId: 'Q-num',
              questionTitle: 'Years experience',
              valueNumber: 7,
            },
            {
              ...EMPTY_ANSWER,
              questionTtId: 'Q-bool',
              questionTitle: 'Remote',
              valueBoolean: true,
            },
            {
              ...EMPTY_ANSWER,
              questionTtId: 'Q-date',
              questionTitle: 'Available from',
              valueDate: '2026-05-01',
            },
          ],
        },
      ],
    });
    expect(out).toContain('Years experience');
    expect(out).toContain('7');
    expect(out).toContain('Remote');
    expect(out).toContain('Yes');
    expect(out).toContain('2026-05-01');
  });

  it('falls back to questionTtId when questionTitle is empty', () => {
    const out = buildEvaluationContent({
      candidateId: 'c1',
      evaluations: [
        {
          evaluationId: 'e1',
          decision: null,
          score: null,
          evaluatorName: null,
          notes: null,
          createdAt: '2024-01-01T00:00:00Z',
          answers: [
            {
              ...EMPTY_ANSWER,
              questionTtId: '24016',
              questionTitle: null,
              valueText: 'https://sheet/x',
            },
          ],
        },
      ],
    });
    expect(out).toContain('24016');
    expect(out).toContain('https://sheet/x');
  });

  it('renders the decision/score header line when present', () => {
    const out = buildEvaluationContent({
      candidateId: 'c1',
      evaluations: [
        {
          evaluationId: 'e1',
          decision: 'reject',
          score: 2,
          evaluatorName: 'Bob',
          notes: 'rationale',
          createdAt: '2024-01-01T00:00:00Z',
          answers: [],
        },
      ],
    });
    expect(out).toContain('decision: reject');
    expect(out).toContain('score: 2');
    expect(out).toContain('Bob');
    expect(out).toContain('rationale');
  });

  it('never leaks "null" / "undefined" literals', () => {
    const out = buildEvaluationContent({
      candidateId: 'c1',
      evaluations: [
        {
          evaluationId: 'e1',
          decision: null,
          score: null,
          evaluatorName: null,
          notes: 'real text',
          createdAt: '2024-01-01T00:00:00Z',
          answers: [{ ...EMPTY_ANSWER, questionTtId: 'Q', valueText: null, valueNumber: null }],
        },
      ],
    });
    expect(out).not.toMatch(/\b(null|undefined)\b/i);
  });

  it('collapses internal whitespace in notes and answer text', () => {
    const out = buildEvaluationContent({
      candidateId: 'c1',
      evaluations: [
        {
          evaluationId: 'e1',
          decision: null,
          score: null,
          evaluatorName: null,
          notes: '  multi\n\nline   notes  ',
          createdAt: '2024-01-01T00:00:00Z',
          answers: [
            {
              ...EMPTY_ANSWER,
              questionTtId: 'Q',
              questionTitle: '  spaced  title  ',
              valueText: '  spaced\tvalue  ',
            },
          ],
        },
      ],
    });
    expect(out).toContain('multi line notes');
    expect(out).toContain('spaced title');
    expect(out).toContain('spaced value');
  });
});
