import { QvacErrorBase, addCodes, type ErrorCodesMap } from '@qvac/error'

export class QvacErrorRAG extends QvacErrorBase {}

// Codes retired in 1.0 are not reused.
export const ERR_CODES = Object.freeze({
  INVALID_INPUT: 14008,
  DUPLICATE_DOCUMENT_ID: 14010,
  DB_OPERATION_FAILED: 14014,
  DEPENDENCY_REQUIRED: 14015,
  EMBEDDING_DIMENSION_MISMATCH: 14018,
  NOT_READY: 14019,
  NAMESPACE_NOT_FOUND: 14020,
  NAMESPACE_EXISTS: 14021,
  INVALID_SCOPE: 14022,
  DOCUMENT_OUT_OF_SCOPE: 14023,
  EMBEDDING_SPACE_MISMATCH: 14024,
  NATIVE_ID_EXHAUSTED: 14025
} as const)

const definitions: ErrorCodesMap = {
  [ERR_CODES.INVALID_INPUT]: {
    name: 'INVALID_INPUT',
    message: (message) => `Invalid input: ${message}`
  },
  [ERR_CODES.DUPLICATE_DOCUMENT_ID]: {
    name: 'DUPLICATE_DOCUMENT_ID',
    message: (id) => `Duplicate document id detected: ${id}`
  },
  [ERR_CODES.DB_OPERATION_FAILED]: {
    name: 'DB_OPERATION_FAILED',
    message: (message) => `Database operation failed: ${message}`
  },
  [ERR_CODES.DEPENDENCY_REQUIRED]: {
    name: 'DEPENDENCY_REQUIRED',
    message: (message) => `Required dependency missing: ${message}`
  },
  [ERR_CODES.EMBEDDING_DIMENSION_MISMATCH]: {
    name: 'EMBEDDING_DIMENSION_MISMATCH',
    message: (message) => `Embedding dimension mismatch: ${message}`
  },
  [ERR_CODES.NOT_READY]: {
    name: 'NOT_READY',
    message: (message) => `RAG is not open: ${message}`
  },
  [ERR_CODES.NAMESPACE_NOT_FOUND]: {
    name: 'NAMESPACE_NOT_FOUND',
    message: (name) => `Namespace not found: ${name}`
  },
  [ERR_CODES.NAMESPACE_EXISTS]: {
    name: 'NAMESPACE_EXISTS',
    message: (message) => `Namespace already exists: ${message}`
  },
  [ERR_CODES.INVALID_SCOPE]: {
    name: 'INVALID_SCOPE',
    message: (message) => `Invalid search scope: ${message}`
  },
  [ERR_CODES.DOCUMENT_OUT_OF_SCOPE]: {
    name: 'DOCUMENT_OUT_OF_SCOPE',
    message: (message) => `Document is not in the namespace: ${message}`
  },
  [ERR_CODES.EMBEDDING_SPACE_MISMATCH]: {
    name: 'EMBEDDING_SPACE_MISMATCH',
    message: (message) => `Embedding space mismatch: ${message}`
  },
  [ERR_CODES.NATIVE_ID_EXHAUSTED]: {
    name: 'NATIVE_ID_EXHAUSTED',
    message: (name) => `Native ID range exhausted for namespace: ${name}`
  }
}

addCodes(definitions, { name: '@qvac/rag', version: '1.0.0' })
