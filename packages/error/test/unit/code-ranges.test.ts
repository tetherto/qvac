import test from 'brittle'
import {
  validateCodeRanges,
  validatePackageCodes,
  type CodeRangeRegistry
} from '../../src/code-ranges.js'

function registry(): CodeRangeRegistry {
  return {
    version: 1,
    allocations: [
      { owner: '@qvac/error', ranges: [[0, 999]], status: 'active' },
      { owner: '@qvac/example', ranges: [[1001, 2000]], status: 'active' },
      { owner: '@qvac/retired', ranges: [[2001, 3000]], status: 'retired' },
      { owner: '@qvac/core', ranges: [[100001, 102000]], status: 'reserved' }
    ]
  }
}

test('reservations include unused codes, external packages and retired owners', (t) => {
  t.execution(() => validateCodeRanges(registry()))
  t.execution(() => validatePackageCodes(registry(), '@qvac/core', { FIRST: 100001, LAST: 102000 }))
  t.exception(() => validatePackageCodes(registry(), '@qvac/new', { FIRST: 1500 }))
  t.exception(() => validatePackageCodes(registry(), '@qvac/retired', { OLD: 2001 }))
  t.exception(() => validatePackageCodes(registry(), '@qvac/example', { INTERNAL: 500 }))
  t.exception(() => validatePackageCodes(registry(), '@qvac/example', { OUTSIDE: 8999 }))
})

test('overlapping ranges fail even when neither owner has defined codes', (t) => {
  const data = registry()
  data.allocations.push({ owner: '@qvac/new', ranges: [[1500, 2500]], status: 'reserved' })
  t.exception(() => validateCodeRanges(data), /overlap/)
})

test('invalid bounds and malformed registries fail closed', (t) => {
  for (const ranges of [[[2, 1]], [[-1, 2]], [[1.5, 2]], [[1, Infinity]], [[1]], []]) {
    const data = registry()
    data.allocations[1]!.ranges = ranges as [number, number][]
    t.exception(() => validateCodeRanges(data))
  }
  for (const data of [null, {}, { version: 2, allocations: [] }, { version: 1, allocations: [] }]) {
    t.exception(() => validateCodeRanges(data))
  }
})

test('shared families allow only named additional owners', (t) => {
  const data = registry()
  data.allocations[1]!.sharedWith = ['@qvac/inference']
  t.execution(() => validatePackageCodes(data, '@qvac/inference', { SHARED: 1001 }))
  t.exception(() => validatePackageCodes(data, '@qvac/other', { SHARED: 1001 }))
})

test('duplicate values, non-integers and empty inventories do not hide errors', (t) => {
  t.exception(() => validatePackageCodes(registry(), '@qvac/example', { A: 1001, B: 1001 }))
  t.exception(() => validatePackageCodes(registry(), '@qvac/example', { A: 1001.5 }))
  t.exception(() => validatePackageCodes(registry(), '@qvac/unknown', {}))
})
