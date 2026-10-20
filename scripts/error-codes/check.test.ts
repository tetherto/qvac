import assert from 'node:assert/strict'
import test from 'node:test'
import { checkCodeSources } from './check.js'
import type { CodeRangeRegistry } from '../../packages/error/src/code-ranges.js'

const registry: CodeRangeRegistry = {
  version: 1,
  allocations: [{ owner: 'sdk', sharedWith: ['engine'], ranges: [[1001, 2000]], status: 'active' }]
}
const sources = [
  { owner: 'sdk', file: 'packages/sdk/src/errors.ts', symbols: ['CODES'] },
  { owner: 'engine', file: 'packages/engine/src/errors.ts', symbols: ['CODES'] }
]

test('checks real source tables, accepts shared codes and ignores compiled copies', () => {
  const files = new Map([
    [sources[0]!.file, 'const CODES = { FIRST: 1001 }'],
    [sources[1]!.file, 'const CODES = { FIRST: 1001, SECOND: 1002 }'],
    ['packages/engine/errors.js', "const { addCodes } = require('@qvac/error')"]
  ])
  assert.doesNotThrow(() => checkCodeSources(registry, sources, files))
  files.set(sources[1]!.file, 'const CODES = { WRONG: 1001 }')
  assert.throws(() => checkCodeSources(registry, sources, files), /conflicting names/)
  files.set(sources[1]!.file, 'const CODES = { FIRST: 1002 }')
  assert.throws(() => checkCodeSources(registry, sources, files), /conflicting numbers/)
  files.set(sources[1]!.file, 'const CODES = { FIRST: 3000 }')
  assert.throws(() => checkCodeSources(registry, sources, files), /outside/)
})

test('new registration modules and missing registered sources fail', () => {
  const files = new Map([
    [sources[0]!.file, 'const CODES = { FIRST: 1001 }'],
    [sources[1]!.file, 'const CODES = { FIRST: 1001 }'],
    ['packages/new/errors.js', "const { addCodes } = require('@qvac/error')"]
  ])
  assert.throws(() => checkCodeSources(registry, sources, files), /Unlisted/)
  files.delete(sources[1]!.file)
  assert.throws(() => checkCodeSources(registry, sources, files), /Missing/)
})

test('a historical name alias permits only its explicitly listed names and code', () => {
  const data: CodeRangeRegistry = {
    version: 1,
    allocations: [{ ...registry.allocations[0]!, aliases: { '1001': ['FIRST', 'OLD_FIRST'] } }]
  }
  const files = new Map([
    [sources[0]!.file, 'const CODES = { FIRST: 1001 }'],
    [sources[1]!.file, 'const CODES = { OLD_FIRST: 1001 }']
  ])
  assert.doesNotThrow(() => checkCodeSources(data, sources, files))
  files.set(sources[1]!.file, 'const CODES = { OLD_FIRST: 1002 }')
  assert.throws(() => checkCodeSources(data, sources, files), /alias/)
  files.set(sources[1]!.file, 'const CODES = { OTHER: 1001 }')
  assert.throws(() => checkCodeSources(data, sources, files), /conflicting names/)
})

test('an already listed module cannot hide a second code table or inline numeric registration', () => {
  const files = new Map([
    [sources[0]!.file, 'const CODES = { FIRST: 1001 }'],
    [
      sources[1]!.file,
      `const CODES = { FIRST: 1001 }
      const EXTRA_ERROR_CODES = { BAD: 999999 }
      addCodes({ [EXTRA_ERROR_CODES.BAD]: { name: 'BAD', message: 'bad' } })`
    ]
  ])
  assert.throws(() => checkCodeSources(registry, sources, files), /Unlisted code table/)
  files.set(
    sources[1]!.file,
    `const CODES = { FIRST: 1001 }
    addCodes({ 999999: { name: 'BAD', message: 'bad' } })`
  )
  assert.throws(() => checkCodeSources(registry, sources, files), /Inline numeric/)
})

test('unrelated status maps and metadata do not become error registrations', () => {
  const source = `
    const CODES = { FIRST: 1001 }
    const HTTP_STATUS_CODES = { BAD_REQUEST: 400 }
    const HTTP_MESSAGES = { 400: 'Bad request' }
    const metadata = { [Symbol.toStringTag]: 'Errors' }
    addCodes({ [CODES.FIRST]: { name: 'FIRST', message: 'first' } })
  `
  const files = new Map(sources.map(({ file }) => [file, source]))
  assert.doesNotThrow(() => checkCodeSources(registry, sources, files))
})

test('function-local definitions cannot hide an unlisted error map', () => {
  const source = `
    const CODES = { FIRST: 1001 }
    function registerExtra() {
      const EXTRA_ERROR_CODES = { BAD: 999999 }
      const definitions = { [EXTRA_ERROR_CODES.BAD]: { name: 'BAD', message: 'bad' } }
      addCodes(definitions)
    }
    registerExtra()
  `
  const files = new Map(sources.map(({ file }) => [file, source]))
  assert.throws(() => checkCodeSources(registry, sources, files), /Unlisted code table/)
})

test('rejects mutations to definitions before filtered registration', () => {
  const source = `
    const CODES = { FIRST: 1001 }
    const definitions = { [CODES.FIRST]: { name: 'FIRST', message: 'first' } }
    definitions[999999] = { name: 'BAD', message: 'bad' }
    const filtered = Object.fromEntries(Object.entries(definitions).filter(() => true))
    addCodes(filtered)
  `
  const files = new Map(sources.map(({ file }) => [file, source]))
  assert.throws(() => checkCodeSources(registry, sources, files), /Mutated error/)
})

test('rejects a function-local code map shadowing a listed module map', () => {
  const source = `
    const CODES = { FIRST: 1001 }
    function registerExtra() {
      const CODES = { BAD: 999999 }
      addCodes({ [CODES.BAD]: { name: 'BAD', message: 'bad' } })
    }
    registerExtra()
  `
  const files = new Map(sources.map(({ file }) => [file, source]))
  assert.throws(() => checkCodeSources(registry, sources, files), /module.scope/)
})

test('shared names retain their numbers across every subrange of an allocation', () => {
  const data: CodeRangeRegistry = {
    version: 1,
    allocations: [{ ...registry.allocations[0]!, ranges: [[1001, 1500], [1501, 2000]] }]
  }
  const files = new Map([
    [sources[0]!.file, 'const CODES = { FIRST: 1001 }'],
    [sources[1]!.file, 'const CODES = { FIRST: 1999 }']
  ])
  assert.throws(() => checkCodeSources(data, sources, files), /conflicting numbers/)
})

test('shared names may mirror either existing number when the owner reuses a name', () => {
  const server = { owner: 'sdk', file: 'packages/sdk/src/server-errors.ts', symbols: ['CODES'] }
  const data: CodeRangeRegistry = {
    version: 1,
    allocations: [{ ...registry.allocations[0]!, ranges: [[1001, 1500], [1501, 2000]] }]
  }
  const files = new Map([
    [sources[0]!.file, 'const CODES = { AUDIO: 1001 }'],
    [server.file, 'const CODES = { AUDIO: 1999 }'],
    [sources[1]!.file, 'const CODES = { AUDIO: 1999 }']
  ])
  assert.doesNotThrow(() => checkCodeSources(data, [...sources, server], files))
  files.set(sources[1]!.file, 'const CODES = { AUDIO: 1800 }')
  assert.throws(() => checkCodeSources(data, [...sources, server], files), /conflicting numbers/)
})
