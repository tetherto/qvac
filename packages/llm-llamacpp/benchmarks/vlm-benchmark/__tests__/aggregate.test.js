'use strict'

// aggregate.js turns [VLMROW] markers into the report tables. markers-v2.sample.txt is the
// committed contract fixture, covering two sources, two backends, VQA and OCR tasks, a warmup
// block, an error row, a phone-shaped row and one legacy v1 row. Locking its numbers here
// catches an aggregation regression, e.g. warmup rows leaking into the average or a rep being
// counted twice, which the marker-level selfcheck in run-desktop.cjs cannot see.

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')
const { execFileSync } = require('child_process')

const DIR = path.resolve(__dirname, '..')
const SAMPLE = path.join(DIR, 'markers-v2.sample.txt')

function runAggregate (args) {
  return execFileSync(process.execPath, [path.join(DIR, 'aggregate.js'), ...args], {
    cwd: DIR,
    encoding: 'utf8'
  })
}

const OUT = runAggregate(['--title', 'probe', SAMPLE])

test('the sample resolves to two-models mode with the expected base and candidate', () => {
  assert.match(OUT, /two models \(qwen3\.5-f16 vs qwen3\.5-q8; engine fixed\)/)
})

test('quality per leg is stable', () => {
  const gpu = OUT.split('\n').find(l => l.startsWith('| — · GPU | 100.0 |'))
  assert.ok(gpu, 'expected a GPU quality row')
  assert.match(gpu, /\| 91\.7 \| -8\.3 \|/)
})

test('speed per leg is stable and the delta keeps its sign convention', () => {
  const gpu = OUT.split('\n').find(l => l.includes('TTFT ms (incl. enc) | 834 |'))
  assert.ok(gpu, 'expected a GPU speed row')
  assert.match(gpu, /\| 658 \| -175 \| -21\.0% \|/)
})

test('the warmup block does not reach the averages', () => {
  // The sample's block 0 row carries pred "warmup" against gold "philippe molitor". Counting
  // it would drag candidate quality below the locked 91.7 above, so that assertion plus this
  // one pin the warmup handling from both sides.
  assert.doesNotMatch(OUT, /warmup/i)
})

test('passing the same log twice does not change the aggregate', () => {
  // Reps are averaged per item, so a duplicated input must not shift the numbers. If it does,
  // rows are being summed somewhere they should be pooled.
  const twice = runAggregate(['--title', 'probe', SAMPLE, SAMPLE])
  const numbers = (s) => s.split('\n').filter(l => l.startsWith('| — · '))
  assert.deepEqual(numbers(twice), numbers(OUT))
})
