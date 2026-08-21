'use strict'

// aggregate.js turns [VLMROW] markers into the report tables. markers-v2.sample.txt is the
// committed contract fixture, covering two sources, two backends, VQA and OCR tasks, a warmup
// block, an error row, a phone-shaped row and one legacy v1 row. Locking its numbers here
// catches an aggregation regression, e.g. warmup rows leaking into the average or a rep being
// counted twice, which the marker-level selfcheck in run-desktop.cjs cannot see.

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')
const fs = require('fs')
const os = require('os')
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

test('the warmup block is excluded from the measured row count', () => {
  // The sample's one block 0 row belongs to qwen3.5-q8 on GPU, so the Details table's n for
  // that leg is 5 with the warmup dropped and 6 without. Asserting on n rather than on the
  // absence of the word "warmup": aggregate.js scores `pred` but never prints it, so a text
  // match cannot tell a dropped warmup row from a counted one.
  const details = OUT.split('\n').filter(l => l.startsWith('| `qwen3.5-q8` · GPU |'))
  const row = details[details.length - 1]
  assert.ok(row, 'expected a q8 GPU details row')
  assert.equal(row.split('|')[3].trim(), '5')
})

// An upstream-cli leg never receives cliArgs, because they are fabric-fork flags, so it can
// run base preprocessing under the same model label as an addon leg that applied them. The
// numbers alone give no hint of that, which is what these two assertions guard.
const ASYM = (() => {
  const meta = (cell, preproc) => '[VLMMETA]' + JSON.stringify({
    v: 2, scenario: 'default', cell, source: cell, model: 'flash-q4',
    main_origin: 'repo@sha', main_source: 'HF', mmproj_origin: 'repo@sha · mmproj', mmproj_source: 'HF', preproc
  }) + '[/VLMMETA]'
  const row = (cell, ms) => '[VLMROW]' + JSON.stringify({
    v: 2, scenario: 'default', block: 1, cell, source: cell, model: 'flash-q4', device: 'gpu', rep: 0,
    task: 'textvqa', id: 'textvqa_0', metric: 'vqa', gold: ['paris'], pred: 'paris', ms, ttft_ms: 100,
    decode_tps: 10, gen_tokens: 5, prompt_tokens: 30
  }) + '[/VLMROW]'
  const file = path.join(os.tmpdir(), 'vlm-aggregate-asym.log')
  fs.writeFileSync(file, [meta('addon', 'image-no-upscale=on'), row('addon', 500), meta('upstream-cli', ''), row('upstream-cli', 600)].join('\n') + '\n')
  const out = runAggregate(['--title', 'probe', file])
  fs.unlinkSync(file)
  return out
})()

test('the origins table reports what preprocessing each leg applied', () => {
  assert.match(ASYM, /\| `addon` \|.*\| `image-no-upscale=on` \|/)
  assert.match(ASYM, /\| `upstream-cli` \|.*\| base \|/)
})

test('legs of one model that preprocessed differently are called out', () => {
  assert.match(ASYM, /Preprocessing differs across the legs of `flash-q4`/)
  assert.match(ASYM, /`upstream-cli` ran base preprocessing/)
})

test('a log with no preproc field gets no mismatch warning', () => {
  // Older logs predate the field, and absent must not read as "ran base preprocessing".
  assert.doesNotMatch(OUT, /Preprocessing differs/)
})

test('passing the same log twice does not change the aggregate', () => {
  // Reps are averaged per item, so a duplicated input must not shift the numbers. If it does,
  // rows are being summed somewhere they should be pooled.
  const twice = runAggregate(['--title', 'probe', SAMPLE, SAMPLE])
  const numbers = (s) => s.split('\n').filter(l => l.startsWith('| — · '))
  assert.deepEqual(numbers(twice), numbers(OUT))
})
