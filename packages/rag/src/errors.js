'use strict'

const { QvacErrorBase, addCodes } = require('@qvac/error')
const { name, version } = require('../package.json')

class QvacErrorRAG extends QvacErrorBase { }

const ERR_CODES = Object.freeze({
  ABSTRACT_CLASS: 14001,
  DB_ADAPTER_NOT_INITIALIZED: 14002,
  DB_ADAPTER_REQUIRED: 14003,
  CENTROIDS_INITIALIZATION_FAILURE: 14004,
  LLM_REQUIRED: 14005,
  EMBEDDING_FUNCTION_REQUIRED: 14006,
  NOT_IMPLEMENTED: 14007,
  INVALID_INPUT: 14008,
  INVALID_PARAMS: 14009,
  DUPLICATE_DOCUMENT_ID: 14010,
  GENERATION_FAILED: 14011,
  CHUNKING_FAILED: 14012,
  INVALID_CHUNKER: 14013,
  DB_OPERATION_FAILED: 14014,
  DEPENDENCY_REQUIRED: 14015,
  OPERATION_CANCELLED: 14016,
  EMBEDDING_MODEL_MISMATCH: 14017,
  EMBEDDING_DIMENSION_MISMATCH: 14018
})

addCodes({
  [ERR_CODES.ABSTRACT_CLASS]: {
    name: 'ABSTRACT_CLASS',
    message: 'Abstract class cannot be instantiated directly'
  },
  [ERR_CODES.DB_ADAPTER_NOT_INITIALIZED]: {
    name: 'DB_ADAPTER_NOT_INITIALIZED',
    message: 'Adapter not initialized'
  },
  [ERR_CODES.DB_ADAPTER_REQUIRED]: {
    name: 'DB_ADAPTER_REQUIRED',
    message: 'Database adapter required'
  },
  [ERR_CODES.CENTROIDS_INITIALIZATION_FAILURE]: {
    name: 'CENTROIDS_INITIALIZATION_FAILURE',
    message: 'Centroids initialization failure'
  },
  [ERR_CODES.LLM_REQUIRED]: {
    name: 'LLM_REQUIRED',
    message: 'LLM required'
  },
  [ERR_CODES.EMBEDDING_FUNCTION_REQUIRED]: {
    name: 'EMBEDDING_FUNCTION_REQUIRED',
    message: 'Embedding function required'
  },
  [ERR_CODES.NOT_IMPLEMENTED]: {
    name: 'NOT_IMPLEMENTED',
    message: 'Not implemented'
  },
  [ERR_CODES.INVALID_INPUT]: {
    name: 'INVALID_INPUT',
    message: 'Invalid input'
  },
  [ERR_CODES.INVALID_PARAMS]: {
    name: 'INVALID_PARAMS',
    message: 'Invalid params'
  },
  [ERR_CODES.DUPLICATE_DOCUMENT_ID]: {
    name: 'DUPLICATE_DOCUMENT_ID',
    message: (id) => `Duplicate document id detected: ${id}`
  },
  [ERR_CODES.GENERATION_FAILED]: {
    name: 'GENERATION_FAILED',
    message: (message) => `Failed to generate, error: ${message}`
  },
  [ERR_CODES.CHUNKING_FAILED]: {
    name: 'CHUNKING_FAILED',
    message: (message) => `Failed to chunk document: ${message}`
  },
  [ERR_CODES.INVALID_CHUNKER]: {
    name: 'INVALID_CHUNKER',
    message: 'Invalid chunker instance provided'
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
  [ERR_CODES.EMBEDDING_MODEL_MISMATCH]: {
    name: 'EMBEDDING_MODEL_MISMATCH',
    message: (message) => `Embedding model mismatch: ${message}`
  },
  [ERR_CODES.EMBEDDING_DIMENSION_MISMATCH]: {
    name: 'EMBEDDING_DIMENSION_MISMATCH',
    message: (message) => `Embedding dimension mismatch: ${message}`
  }
}, { name, version })

module.exports = {
  ERR_CODES,
  QvacErrorRAG
}
