/**
 * Unit tests for JSON:API → flat-object deserialization.
 */
import { describe, expect, it } from 'vitest';
import { ParseError } from './errors';
import { normalizeAttributes, parseDocument, parseResource } from './parse';
import type { TTJsonApiDocument, TTJsonApiResource } from './types';

describe('normalizeAttributes', () => {
  it('converts kebab-case keys to camelCase', () => {
    const input = { 'first-name': 'Ada', 'last-name': 'Lovelace', email: 'a@b.c' };
    expect(normalizeAttributes(input)).toEqual({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'a@b.c',
    });
  });

  it('leaves already-camelCase keys untouched', () => {
    expect(normalizeAttributes({ foo: 1, barBaz: 2 })).toEqual({ foo: 1, barBaz: 2 });
  });

  it('handles nested hyphenated segments', () => {
    expect(normalizeAttributes({ 'created-at': '2026-01-01' })).toEqual({
      createdAt: '2026-01-01',
    });
  });

  it('does not recurse into nested objects (shallow)', () => {
    const out = normalizeAttributes({ 'nested-thing': { 'inner-key': 1 } });
    expect(out).toEqual({ nestedThing: { 'inner-key': 1 } });
  });
});

describe('parseResource', () => {
  it('returns id, type, and camelCased attributes', () => {
    const res: TTJsonApiResource = {
      id: '42',
      type: 'candidates',
      attributes: { 'first-name': 'Grace', 'last-name': 'Hopper' },
    };
    const parsed = parseResource(res);
    expect(parsed.id).toBe('42');
    expect(parsed.type).toBe('candidates');
    expect(parsed.attributes).toEqual({ firstName: 'Grace', lastName: 'Hopper' });
  });

  it('preserves relationships verbatim (no deep normalization)', () => {
    const res: TTJsonApiResource = {
      id: '1',
      type: 'job-applications',
      attributes: {},
      relationships: {
        candidate: { data: { id: '99', type: 'candidates' } },
        job: { data: { id: '7', type: 'jobs' } },
      },
    };
    const parsed = parseResource(res);
    expect(parsed.relationships?.candidate?.data).toEqual({ id: '99', type: 'candidates' });
  });

  it('throws ParseError when resource lacks required shape', () => {
    // missing attributes
    expect(() => parseResource({ id: '1', type: 'x' } as unknown as TTJsonApiResource)).toThrow(
      ParseError,
    );
    // missing id
    expect(() =>
      parseResource({ type: 'x', attributes: {} } as unknown as TTJsonApiResource),
    ).toThrow(ParseError);
  });
});

describe('parseDocument', () => {
  it('parses a collection document', () => {
    const doc: TTJsonApiDocument = {
      data: [
        { id: '1', type: 'candidates', attributes: { 'first-name': 'A' } },
        { id: '2', type: 'candidates', attributes: { 'first-name': 'B' } },
      ],
      links: { next: 'https://api.teamtailor.com/v1/candidates?page[number]=2' },
    };
    const parsed = parseDocument(doc);
    expect(parsed.data).toHaveLength(2);
    expect(parsed.data[0]?.attributes).toEqual({ firstName: 'A' });
    expect(parsed.nextUrl).toBe('https://api.teamtailor.com/v1/candidates?page[number]=2');
  });

  it('parses a single-resource document', () => {
    const doc: TTJsonApiDocument = {
      data: { id: '1', type: 'jobs', attributes: { title: 'Engineer' } },
    };
    const parsed = parseDocument(doc);
    expect(parsed.data).toHaveLength(1);
    expect(parsed.data[0]?.type).toBe('jobs');
  });

  it('returns nextUrl=null when links.next missing', () => {
    const doc: TTJsonApiDocument = {
      data: [{ id: '1', type: 'candidates', attributes: {} }],
    };
    expect(parseDocument(doc).nextUrl).toBeNull();
  });

  it('throws ParseError when "data" is missing', () => {
    expect(() => parseDocument({} as unknown as TTJsonApiDocument)).toThrow(ParseError);
  });

  it('exposes included resources when present', () => {
    const doc: TTJsonApiDocument = {
      data: [{ id: '1', type: 'job-applications', attributes: {} }],
      included: [{ id: '7', type: 'jobs', attributes: { title: 'Dev' } }],
    };
    const parsed = parseDocument(doc);
    expect(parsed.included).toHaveLength(1);
    expect(parsed.included?.[0]?.type).toBe('jobs');
  });
});
