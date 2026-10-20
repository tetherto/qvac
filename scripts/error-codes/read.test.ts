import assert from 'node:assert/strict'
import test from 'node:test'
import { readCodeMap } from './read.js'

test('reads numeric maps without importing or executing the module', () => {
  const source = `
    require('native-addon-that-is-not-installed')
    throw new Error('must never run')
    const RANGE = Object.freeze({ start: 1001, end: 2000 })
    export const CODES = Object.freeze({ FIRST: RANGE.start, LAST: 2000 } as const)
  `
  assert.deepEqual(readCodeMap(source, 'CODES'), { FIRST: 1001, LAST: 2000 })
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
