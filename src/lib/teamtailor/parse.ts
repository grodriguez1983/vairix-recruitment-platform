/**
 * JSON:API → flat-object deserializer.
 *
 * Teamtailor responses follow JSON:API: payload lives under
 * `attributes`, relationships are structured, keys come in
 * kebab-case. This module normalizes attribute keys to camelCase
 * (shallow — nested objects are preserved as-is so domain parsers
 * can treat them as opaque) and returns a narrow shape convenient
 * for downstream syncers.
 *
 * Concrete entity mappers (`parseCandidate`, `parseJob`, ...) live
 * with the syncers in F1-005/006 and import from here.
 */
import { ParseError } from './errors';
import type {
  TTJsonApiDocument,
  TTJsonApiResource,
  TTParsedDocument,
  TTParsedResource,
} from './types';

function kebabToCamel(key: string): string {
  return key.replace(/-([a-z0-9])/gi, (_, c: string) => c.toUpperCase());
}

/**
 * Shallow kebab→camel conversion of top-level keys. Values are
 * preserved verbatim (no recursion). This is intentional: nested
 * structures like `custom-fields` may have dynamic shapes per
 * tenant, and normalizing them here would be lossy.
 */
export function normalizeAttributes(attrs: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(attrs)) {
    out[kebabToCamel(k)] = v;
  }
  return out;
}

/**
 * Parses a single JSON:API resource into a `TTParsedResource`.
 * Throws `ParseError` if the shape is invalid (missing id, type, or
 * attributes).
 */
export function parseResource(resource: TTJsonApiResource): TTParsedResource {
  if (!resource || typeof resource !== 'object') {
    throw new ParseError('resource must be an object', { resource });
  }
  if (typeof resource.id !== 'string' || resource.id === '') {
    throw new ParseError('resource.id missing or not a string', { resource });
  }
  if (typeof resource.type !== 'string' || resource.type === '') {
    throw new ParseError('resource.type missing or not a string', { resource });
  }
  if (!resource.attributes || typeof resource.attributes !== 'object') {
    throw new ParseError('resource.attributes missing or not an object', {
      id: resource.id,
      type: resource.type,
    });
  }
  const parsed: TTParsedResource = {
    id: resource.id,
    type: resource.type,
    attributes: normalizeAttributes(resource.attributes),
  };
  if (resource.relationships !== undefined) {
    parsed.relationships = resource.relationships;
  }
  return parsed;
}

/**
 * Parses a top-level JSON:API document, coercing single-resource
 * responses into a one-element collection so downstream code has a
 * uniform shape to iterate.
 *
 * `nextUrl` is extracted from `links.next` and returned as `null`
 * when absent — the iterator in `paginate.ts` uses this to terminate.
 */
export function parseDocument(doc: TTJsonApiDocument): TTParsedDocument {
  if (!doc || typeof doc !== 'object' || doc.data === undefined) {
    throw new ParseError('document missing "data" field', {});
  }
  const rawData = Array.isArray(doc.data) ? doc.data : [doc.data];
  const data = rawData.map(parseResource);
  const included = doc.included ? doc.included.map(parseResource) : undefined;
  const nextUrl = doc.links?.next ?? null;
  return {
    data,
    ...(included ? { included } : {}),
    nextUrl,
    ...(doc.meta ? { meta: doc.meta } : {}),
  };
}
