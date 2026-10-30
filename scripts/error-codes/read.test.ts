import assert from 'node:assert/strict'
import test from 'node:test'
import { readCodeMap, referencedCodeMaps } from './read.js'

test('reads numeric maps without importing or executing the module', () => {
  const source = `
    require('native-addon-that-is-not-installed')
    throw new Error('must never run')
    const RANGE = Object.freeze({ start: 1001, end: 2000 })
    export const CODES = Object.freeze({ FIRST: RANGE.start, LAST: 2000 } as const)
  `
  assert.deepEqual(readCodeMap(source, 'CODES'), { FIRST: 1001, LAST: 2000 })
})

test('follows registration definitions through filters and local wrappers', () => {
  const source = `
    const ERR_CODES = { FIRST: 1001 }
    const definitions = { [ERR_CODES.FIRST]: { name: 'FIRST', message: 'first' } }
    const filtered = Object.fromEntries(Object.entries(definitions).filter(() => true))
    addCodes(filtered)
    function register(codes) { addCodes(codes) }
    register({ [EXTRA.BAD]: { name: 'BAD', message: 'bad' } })
  `
  assert.deepEqual(referencedCodeMaps(source).sort(), ['ERR_CODES', 'EXTRA'])
  assert.throws(
    () => referencedCodeMaps('const definitions = { 999999: {} }; addCodes(definitions)'),
    /Inline numeric/
  )
  assert.throws(() => referencedCodeMaps('addCodes(importedDefinitions)'), /Unresolved/)
})

test('does not silently omit missing, dynamic or malformed definitions', () => {
  assert.throws(() => readCodeMap('const OTHER = {}', 'CODES'), /CODES/)
  assert.throws(() => readCodeMap('const CODES = { A: getCode() }', 'CODES'), /Unsupported/)
  assert.throws(() => readCodeMap('const CODES = { ...OTHER }', 'CODES'), /Unsupported/)
  assert.throws(() => readCodeMap('const CODES = { A: 1001, A: 1002 }', 'CODES'), /Duplicate/)
  assert.throws(() => readCodeMap('const CODES = { A: "1001" }', 'CODES'), /numeric/)
  assert.throws(
    () => readCodeMap('const CODES = { A: OTHER }; const OTHER = CODES.A', 'CODES'),
    /Cyclic/
  )
})

for (const mutation of [
  'definitions[999999] = {}',
  'definitions = { 999999: {} }',
  'Object.assign(definitions, { 999999: {} })',
  'const alias = definitions; alias[999999] = {}'
]) {
  test(`rejects mutated registration definitions: ${mutation}`, () => {
    const source = `
      const CODES = { FIRST: 1001 }
      let definitions = { [CODES.FIRST]: {} }
      ${mutation}
      addCodes(definitions)
    `
    assert.throws(() => referencedCodeMaps(source), /Mutated error/)
  })
}

test('rejects mutation of a numeric map instead of reading its obsolete initializer', () => {
  const source = 'const CODES = { FIRST: 1001 }; CODES.FIRST = 999999'
  assert.throws(() => readCodeMap(source, 'CODES'), /Mutated error/)
})

test('rejects a function parameter shadowing a module code map', () => {
  const source = `
    const CODES = { FIRST: 1001 }
    const register = (CODES) => addCodes({ [CODES.BAD]: {} })
    register({ BAD: 999999 })
  `
  assert.throws(() => referencedCodeMaps(source), /module.scope/)
})

test('unrelated shadowed bindings do not mark module maps as mutated', () => {
  const source = `
    const CODES = { FIRST: 1001 }
    function unrelated(CODES) { CODES.FIRST = 999999 }
    function register() { addCodes({ [CODES.FIRST]: {} }) }
    register()
  `
  assert.deepEqual(referencedCodeMaps(source), ['CODES'])
  assert.deepEqual(readCodeMap(source, 'CODES'), { FIRST: 1001 })
})

test('copying a numeric property does not alias its code map', () => {
  const source = `
    const CODES = { FIRST: 1001 }
    let code = CODES.FIRST
    code = 2000
  `
  assert.deepEqual(readCodeMap(source, 'CODES'), { FIRST: 1001 })
})

test('copying a numeric constant does not alias it', () => {
  const source = `
    const FIRST = 1001
    const CODES = { FIRST: FIRST }
    let code = FIRST
    code = 2000
  `
  assert.deepEqual(readCodeMap(source, 'CODES'), { FIRST: 1001 })
})
