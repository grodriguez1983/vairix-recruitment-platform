/**
 * Unit tests for Teamtailor error hierarchy.
 */
import { describe, expect, it } from 'vitest';
import { HttpError, ParseError, RateLimitError, TeamtailorError } from './errors';

describe('TeamtailorError hierarchy', () => {
  it('TeamtailorError extends Error with name and context', () => {
    const err = new TeamtailorError('boom', { operation: 'sync' });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('TeamtailorError');
    expect(err.message).toBe('boom');
    expect(err.context).toEqual({ operation: 'sync' });
  });

  it('HttpError carries status and is a TeamtailorError', () => {
    const err = new HttpError(500, 'server down');
    expect(err).toBeInstanceOf(TeamtailorError);
    expect(err.status).toBe(500);
    expect(err.name).toBe('HttpError');
  });

  it('RateLimitError carries retryAfterMs and is a TeamtailorError', () => {
    const err = new RateLimitError(5000);
    expect(err).toBeInstanceOf(TeamtailorError);
    expect(err.retryAfterMs).toBe(5000);
    expect(err.name).toBe('RateLimitError');
    expect(err.message).toMatch(/5000/);
  });

  it('ParseError is a TeamtailorError', () => {
    const err = new ParseError('bad doc', { field: 'data' });
    expect(err).toBeInstanceOf(TeamtailorError);
    expect(err.name).toBe('ParseError');
    expect(err.context).toEqual({ field: 'data' });
  });
});
