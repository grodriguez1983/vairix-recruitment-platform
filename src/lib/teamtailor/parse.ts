// Stub — implementación en [GREEN].
import type {
  TTJsonApiDocument,
  TTJsonApiResource,
  TTParsedDocument,
  TTParsedResource,
} from './types';

export function normalizeAttributes(_attrs: Record<string, unknown>): Record<string, unknown> {
  throw new Error('not implemented');
}

export function parseResource(_resource: TTJsonApiResource): TTParsedResource {
  throw new Error('not implemented');
}

export function parseDocument(_doc: TTJsonApiDocument): TTParsedDocument {
  throw new Error('not implemented');
}
