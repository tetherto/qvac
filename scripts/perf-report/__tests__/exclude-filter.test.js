'use strict'

/**
 * Unit tests for the --exclude denylist in scripts/perf-report/aggregate.js
 * (QVAC-19942). Pure-function code paths only — no `gh`, no network.
 *
 * Run locally:
 *   node --test scripts/perf-report/__tests__/exclude-filter.test.js
 */

const test = require('node:test')
const assert = require('node:assert/strict')

const { excludeReports, filterReports } = require('../aggregate')

function reports () {
  return [
    {
      device: { name: 'ubuntu-24.04-x64' },
      results: [
        { test: '[EasyOCR basic_test] [CPU]', metrics: {} },
        { test: '[EasyOCR full-suite basic_test.bmp] [CPU]', metrics: {} },
        { test: '[EasyOCR full-suite english.bmp] [GPU]', metrics: {} },
        { test: '[EasyOCR canvasSize lab_results] [CPU]', metrics: {} },
        { test: '[DocTR lab_results] [CPU]', metrics: {} }
      ]
    }
  ]
}

test('excludeReports drops only rows matching the denylist', () => {
  const out = excludeReports(reports(), 'full-suite|canvasSize lab_results')
  assert.equal(out.length, 1)
  const names = out[0].results.map(r => r.test)
  assert.deepEqual(names, [
    '[EasyOCR basic_test] [CPU]',
    '[DocTR lab_results] [CPU]'
  ])
})

test('excludeReports is case-insensitive and matches both EP variants', () => {
  const out = excludeReports(reports(), 'FULL-SUITE')
  const names = out[0].results.map(r => r.test)
  // Both the [CPU] and [GPU] full-suite rows are removed.
  assert.ok(!names.some(n => n.toLowerCase().includes('full-suite')))
  assert.equal(names.length, 3)
})

test('excludeReports returns input unchanged when pattern is falsy', () => {
  const input = reports()
  assert.equal(excludeReports(input, null), input)
  assert.equal(excludeReports(input, ''), input)
})

test('excludeReports drops a report whose rows are all excluded', () => {
  const input = [
    { device: { name: 'd1' }, results: [{ test: '[EasyOCR full-suite x.png]' }] }
  ]
  const out = excludeReports(input, 'full-suite')
  assert.equal(out.length, 0)
})

test('exclude is the inverse of filter for the same pattern', () => {
  const pattern = 'full-suite'
  const kept = filterReports(reports(), pattern)[0].results.map(r => r.test)
  const dropped = excludeReports(reports(), pattern)[0].results.map(r => r.test)
  // No row should appear in both the filter-kept and exclude-kept sets.
  assert.ok(kept.every(n => !dropped.includes(n)))
  assert.ok(kept.every(n => n.toLowerCase().includes('full-suite')))
})
