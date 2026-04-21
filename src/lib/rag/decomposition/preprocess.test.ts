/**
 * Unit tests for `preprocess` (ADR-014 §1).
 *
 * The preprocess step normalizes raw_text before hashing and before
 * handing it to the LLM. It defines what "same input" means for
 * cache-hit purposes — two user submissions that differ only in
 * whitespace or HTML noise must produce the same `content_hash`.
 *
 * Rules (ADR-014 §1):
 *   - trim leading/trailing whitespace
 *   - collapse runs of whitespace (including newlines and tabs) to
 *     a single space
 *   - strip HTML tags if any are present (paste from a doc editor
 *     sometimes includes <span>, <p>, etc.)
 *   - preserve internal punctuation, casing, accents (they're
 *     semantically relevant and the LLM will handle them)
 */
import { describe, expect, it } from 'vitest';

import { preprocess } from './preprocess';

describe('preprocess — ADR-014 §1', () => {
  it('trims leading and trailing whitespace', () => {
    expect(preprocess('   hello world   ')).toBe('hello world');
  });

  it('collapses runs of whitespace to a single space', () => {
    expect(preprocess('hello    world\t\tfoo')).toBe('hello world foo');
  });

  it('collapses newlines and CR into a single space', () => {
    expect(preprocess('hello\n\nworld\r\nfoo')).toBe('hello world foo');
  });

  it('preserves casing and accents', () => {
    expect(preprocess('Buscamos BACKEND con experiencia sólida')).toBe(
      'Buscamos BACKEND con experiencia sólida',
    );
  });

  it('preserves internal punctuation relevant to skill names', () => {
    expect(preprocess('Node.js, C++, CI/CD')).toBe('Node.js, C++, CI/CD');
  });

  it('strips HTML tags', () => {
    expect(preprocess('<p>Buscamos <b>backend</b> sr</p>')).toBe('Buscamos backend sr');
  });

  it('strips self-closing tags', () => {
    expect(preprocess('Node.js<br/>React')).toBe('Node.js React');
  });

  it('strips tags with attributes', () => {
    expect(preprocess('<span class="a">hola</span> mundo')).toBe('hola mundo');
  });

  it('returns empty string when input is only whitespace', () => {
    expect(preprocess('   \n\t  ')).toBe('');
  });

  it('returns empty string when input is only HTML', () => {
    expect(preprocess('<br/><p></p>')).toBe('');
  });

  it('is deterministic for the same input', () => {
    const s = '  <p>3+ años de Node.js</p>  ';
    expect(preprocess(s)).toBe(preprocess(s));
  });

  it('produces identical output for equivalent inputs (cache-hit invariant)', () => {
    const a = '  Buscamos backend sr\n\n  con 3+ años  de Node.js ';
    const b = 'Buscamos backend sr con 3+ años de Node.js';
    expect(preprocess(a)).toBe(preprocess(b));
  });
});
