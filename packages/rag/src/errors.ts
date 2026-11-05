import { QvacErrorBase, addCodes, type ErrorCodesMap } from '@qvac/error'

export class QvacErrorRAG extends QvacErrorBase {}

// Codes retired in 0.10 are not reused; see RETIRED_DEFINITIONS.
export const ERR_CODES = Object.freeze({
  INVALID_INPUT: 14008,
  DUPLICATE_DOCUMENT_ID: 14010,
  DB_OPERATION_FAILED: 14014,
  DEPENDENCY_REQUIRED: 14015,
  OPERATION_CANCELLED: 14016,
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
  [ERR_CODES.OPERATION_CANCELLED]: {
    name: 'OPERATION_CANCELLED',
    message: 'Operation was cancelled'
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

// Errors from Corestore and HyperDB surface as DB_OPERATION_FAILED, with the
// original kept as `cause`.
export function toRagError(error: unknown): QvacErrorRAG {
  if (error instanceof QvacErrorRAG) return error
  return new QvacErrorRAG({
    code: ERR_CODES.DB_OPERATION_FAILED,
    adds: error instanceof Error ? error.message : String(error),
    cause: error instanceof Error ? error : undefined
  })
}

// Codes 0.9 registered and 0.10 no longer raises. @qvac/error keeps only the
// newest version's registration, so dropping them would turn a 0.9 error in
// the same app into UNKNOWN_ERROR_CODE once 0.10 loads.
const RETIRED_DEFINITIONS: ErrorCodesMap = {
  14001: { name: 'ABSTRACT_CLASS', message: 'Abstract class cannot be instantiated directly' },
  14002: { name: 'DB_ADAPTER_NOT_INITIALIZED', message: 'Adapter not initialized' },
  14003: { name: 'DB_ADAPTER_REQUIRED', message: 'Database adapter required' },
  14004: { name: 'CENTROIDS_INITIALIZATION_FAILURE', message: 'Centroids initialization failure' },
  14005: { name: 'LLM_REQUIRED', message: 'LLM required' },
  14006: { name: 'EMBEDDING_FUNCTION_REQUIRED', message: 'Embedding function required' },
  14007: { name: 'NOT_IMPLEMENTED', message: 'Not implemented' },
  14009: { name: 'INVALID_PARAMS', message: 'Invalid params' },
  14011: {
    name: 'GENERATION_FAILED',
    message: (message) => `Failed to generate, error: ${message}`
  },
  14012: { name: 'CHUNKING_FAILED', message: (message) => `Failed to chunk document: ${message}` },
  14013: { name: 'INVALID_CHUNKER', message: 'Invalid chunker instance provided' },
  14017: {
    name: 'EMBEDDING_MODEL_MISMATCH',
    message: (message) => `Embedding model mismatch: ${message}`
  }
}

addCodes({ ...RETIRED_DEFINITIONS, ...definitions }, { name: '@qvac/rag', version: '0.10.0' })
