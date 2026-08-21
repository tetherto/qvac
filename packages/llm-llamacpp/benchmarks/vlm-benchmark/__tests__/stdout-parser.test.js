'use strict'

// Fixtures below are copied verbatim from llama-mtmd-cli output (VisionPsy Flash q8_0, Metal,
// 640x480 input) and from the addon marker sample in markers-v2.sample.txt. The parser reads
// two different encode logs, and the risk it carries is double counting: the addon path logs
// one "image slice encoded" line per slice through mtmd_helper_eval_chunks, while the CLI path
// runs its own loop and logs a batch line instead, so a stream carrying both must not add up
// to the sum of the two.

const test = require('node:test')
const assert = require('node:assert/strict')

const { parseStdoutMetrics } = require('../stdout-parser')

// Real CLI encode log. Three batches, one chunk each, 38 + 27 + 27 ms.
const CLI_BATCH_LOG = [
  '0.00.239.977 I encoding mtmd batch, n_chunks = 1 (done = 1, total = 7)',
  '0.00.278.177 I mtmd batch encoding done in 38 ms',
  '0.00.288.674 I encoding mtmd batch, n_chunks = 1 (done = 3, total = 7)',
  '0.00.316.229 I mtmd batch encoding done in 27 ms',
  '0.00.326.419 I encoding mtmd batch, n_chunks = 1 (done = 5, total = 7)',
  '0.00.353.442 I mtmd batch encoding done in 27 ms'
].join('\n')

// Addon encode log lines, one per slice. mtmd-helper.cpp always emits the `slice encoded`
// form; the sliceless third line is not a shape fabric produces, and is here only to hold the
// regex's tolerance for it in place.
const ADDON_HELPER_LOG = [
  'image slice encoded in 150 ms',
  'image slice encoded in 142 ms',
  'image encoded in 120 ms'
].join('\n')

// Real llama.cpp timing block, same run as CLI_BATCH_LOG.
const PERF_LOG = [
  '0.00.495.670 I llama_perf_context_print:        load time =     155.25 ms',
  '0.00.495.671 I llama_perf_context_print: prompt eval time =     132.35 ms /   205 tokens (    0.65 ms per token,  1548.92 tokens per second)',
  '0.00.495.672 I llama_perf_context_print:        eval time =      20.14 ms /     7 runs   (    2.88 ms per token,   347.60 tokens per second)',
  '0.00.495.673 I llama_perf_context_print:       total time =     260.39 ms /   212 tokens'
].join('\n')

test('CLI batch lines sum the encode time and count chunks, not batches', () => {
  const out = parseStdoutMetrics(CLI_BATCH_LOG)
  assert.equal(out.visionEncodeMs, 92)
  assert.equal(out.visionEncodeSliceCount, 3)
})

test('chunk counts come from n_chunks, so one batch can carry several slices', () => {
  // mtmd-cli breaks its encode batch on every text chunk, so it only ever logs n_chunks = 1.
  // The server path batches, and the count has to follow the field rather than the line count.
  const batched = [
    '0.00.100.000 I encoding mtmd batch, n_chunks = 4 (done = 1, total = 9)',
    '0.00.400.000 I mtmd batch encoding done in 300 ms',
    '0.00.500.000 I encoding mtmd batch, n_chunks = 2 (done = 5, total = 9)',
    '0.00.650.000 I mtmd batch encoding done in 150 ms'
  ].join('\n')
  const out = parseStdoutMetrics(batched)
  assert.equal(out.visionEncodeMs, 450)
  assert.equal(out.visionEncodeSliceCount, 6)
})

test('addon helper lines sum across every slice', () => {
  const out = parseStdoutMetrics(ADDON_HELPER_LOG)
  assert.equal(out.visionEncodeMs, 412)
  assert.equal(out.visionEncodeSliceCount, 3)
})

test('a stream with both helper and batch lines does not double count', () => {
  const out = parseStdoutMetrics(ADDON_HELPER_LOG + '\n' + CLI_BATCH_LOG)
  // Helper lines win outright. 412 + 92 would be the double-counted answer.
  assert.equal(out.visionEncodeMs, 412)
  assert.equal(out.visionEncodeSliceCount, 3)
})

test('prompt eval is not read as decode eval', () => {
  const out = parseStdoutMetrics(PERF_LOG)
  assert.equal(out.promptEvalMs, 132.35)
  assert.equal(out.promptTokens, 205)
  assert.equal(out.promptTps, 1548.92)
  assert.equal(out.decodeMs, 20.14)
  assert.equal(out.decodeTokens, 7)
  assert.equal(out.decodeTps, 347.6)
  assert.equal(out.loadMs, 155.25)
  assert.equal(out.totalMs, 260.39)
})

test('a log with no encode lines reports no encode fields', () => {
  const out = parseStdoutMetrics(PERF_LOG)
  assert.equal(out.visionEncodeMs, undefined)
  assert.equal(out.visionEncodeSliceCount, undefined)
})

test('empty input parses to an empty object', () => {
  assert.deepEqual(parseStdoutMetrics(''), {})
  assert.deepEqual(parseStdoutMetrics(null), {})
})
