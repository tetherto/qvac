import test from 'brittle'
import fs from 'bare-fs'
import { addCodes, type ErrorCodesMap } from '@qvac/error'

import { ERR_CODES, QvacErrorRAG } from '../../src/errors.js'

// Unit tests run with the package root as the working directory.
test('error metadata version matches package.json', (t) => {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8')) as { version: string }
  const source = fs.readFileSync('src/errors.ts', 'utf8')

  const match = source.match(/version:\s*'([^']+)'/)
  t.ok(match, 'errors.ts should declare a version literal')
  t.is(match?.[1], pkg.version, 'errors.ts version must match package.json version')
})

// The names 0.9.0 registered under @qvac/rag; an app can load both versions.
const V09_NAMES: Record<number, string> = {
  14001: 'ABSTRACT_CLASS',
  14002: 'DB_ADAPTER_NOT_INITIALIZED',
  14003: 'DB_ADAPTER_REQUIRED',
  14004: 'CENTROIDS_INITIALIZATION_FAILURE',
  14005: 'LLM_REQUIRED',
  14006: 'EMBEDDING_FUNCTION_REQUIRED',
  14007: 'NOT_IMPLEMENTED',
  14008: 'INVALID_INPUT',
  14009: 'INVALID_PARAMS',
  14010: 'DUPLICATE_DOCUMENT_ID',
  14011: 'GENERATION_FAILED',
  14012: 'CHUNKING_FAILED',
  14013: 'INVALID_CHUNKER',
  14014: 'DB_OPERATION_FAILED',
  14015: 'DEPENDENCY_REQUIRED',
  14016: 'OPERATION_CANCELLED',
  14017: 'EMBEDDING_MODEL_MISMATCH',
  14018: 'EMBEDDING_DIMENSION_MISMATCH'
}

function nameOf(code: number): string {
  return new QvacErrorRAG({ code }).name
}

test('0.9 error codes still resolve once 0.10 is registered', (t) => {
  for (const [code, name] of Object.entries(V09_NAMES)) {
    t.is(nameOf(Number(code)), name, `${code} keeps its 0.9 name`)
  }
  t.is(nameOf(ERR_CODES.INVALID_SCOPE), 'INVALID_SCOPE', 'a 0.10 code resolves too')
})

test('registering 0.9 after 0.10 changes nothing', (t) => {
  const legacy: ErrorCodesMap = {}
  for (const [code, name] of Object.entries(V09_NAMES)) {
    legacy[Number(code)] = { name, message: name }
  }
  addCodes(legacy, { name: '@qvac/rag', version: '0.9.0' })

  t.is(nameOf(14017), 'EMBEDDING_MODEL_MISMATCH', 'a retired code still resolves')
  t.is(nameOf(ERR_CODES.INVALID_SCOPE), 'INVALID_SCOPE', 'the 0.10 codes are kept')
  t.is(new QvacErrorRAG({ code: ERR_CODES.INVALID_INPUT, adds: 'x' }).message, 'Invalid input: x')
})
