/**
 * Teamtailor API wire types (JSON:API) + parsed helpers.
 *
 * Only the shapes the ETL actually reads are modeled. Unknown/extra
 * fields from the API live in `attributes`/`raw_data` as `unknown`
 * and are surfaced to consumers verbatim.
 */

export interface TTJsonApiRelationshipData {
  id: string;
  type: string;
}

export interface TTJsonApiRelationship {
  data: TTJsonApiRelationshipData | TTJsonApiRelationshipData[] | null;
}

export interface TTJsonApiResource<A = Record<string, unknown>> {
  id: string;
  type: string;
  attributes: A;
  relationships?: Record<string, TTJsonApiRelationship>;
}

export interface TTJsonApiLinks {
  first?: string;
  prev?: string;
  next?: string;
  last?: string;
  self?: string;
}

export interface TTJsonApiDocument<A = Record<string, unknown>> {
  data: TTJsonApiResource<A> | TTJsonApiResource<A>[];
  included?: TTJsonApiResource[];
  links?: TTJsonApiLinks;
  meta?: Record<string, unknown>;
}

/**
 * A resource after kebab→camel normalization of its attributes.
 * Relationships are preserved verbatim (not recursively normalized).
 */
export interface TTParsedResource<A = Record<string, unknown>> {
  id: string;
  type: string;
  attributes: A;
  relationships?: Record<string, TTJsonApiRelationship>;
}

export interface TTParsedDocument<A = Record<string, unknown>> {
  data: TTParsedResource<A>[];
  included?: TTParsedResource[];
  nextUrl: string | null;
  meta?: Record<string, unknown>;
}
