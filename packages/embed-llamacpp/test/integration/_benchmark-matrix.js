'use strict'

// Single source of truth for the mobile perf benchmark matrix. The per-shard
// test files (benchmark-perf-<model>-<quant>-bs<N>-fa<on|off>.test.js) and the
// Benchmark Performance workflow's test_groups override are both generated from
// this list by scripts/generate-benchmark-shards.js, so the
// (model x quant x batchSize x flashAttn) matrix is defined in exactly one
// place. Underscore prefix keeps it out of the test globs (it is not a
// *.test.js file).
//
// batchSize and flashAttn each need a fresh GGMLBert()+load(), so making them
// the shard key keeps every shard to ONE (batchSize, flashAttn) pair — its
// internal sweep is only device (2 loads). A coarser (model x quant) shard would
// load the model up to 8 times per session; one (batchSize, flashAttn) per shard
// bounds each session to at most 2 loads (one per device), keeping per-session
// peak device memory and runtime low.
//
// The cells are hardcoded here rather than read from the manifest because the
// mobile Device Farm bundler only bundles test/integration, so this module
// (reachable from the on-device shards) must not require anything outside it.
// The desktop sweep + renderer read benchmarks/performance/models.manifest.json
// directly; these cells mirror it. scripts/generate-benchmark-shards.js --check
// asserts they stay in sync with the manifest (read under Node), so they cannot
// silently drift.
// `file` is the exact GGUF filename in the HF repo. Repos are inconsistent about
// case per quant (embeddinggemma-300M-Q8_0 vs -300m-Q4_0; Qwen ...-f16 lowercase),
// so the filename is pinned here rather than reconstructed: a guessed name 404s,
// and a 404 is not retried. Verified against each repo's HF file listing.
// MOBILE matrix is a SUBSET of the desktop manifest: the Qwen3-embedding-4B
// (4.5-8GB) does not fit Device Farm phones (OOM hard-crash, confirmed on-device
// run 27878011366), so it is desktop-only, mirroring the LLM benchmark which
// dropped Qwen3-4B from mobile for the same reason. The desktop sweep
// (benchmarks/performance) still covers all 3 models via the manifest.
const CELLS = [
  {
    model: 'embeddingGemma',
    quant: 'Q8_0',
    repo: 'unsloth/embeddinggemma-300m-GGUF',
    revision: 'main',
    file: 'embeddinggemma-300M-Q8_0.gguf'
  },
  {
    model: 'embeddingGemma',
    quant: 'Q4_0',
    repo: 'unsloth/embeddinggemma-300m-GGUF',
    revision: 'main',
    file: 'embeddinggemma-300m-Q4_0.gguf'
  },
  {
    model: 'Qwen3-embedding-0.6B',
    quant: 'Q8_0',
    repo: 'Qwen/Qwen3-Embedding-0.6B-GGUF',
    revision: 'main',
    file: 'Qwen3-Embedding-0.6B-Q8_0.gguf'
  },
  {
    model: 'Qwen3-embedding-0.6B',
    quant: 'F16',
    repo: 'Qwen/Qwen3-Embedding-0.6B-GGUF',
    revision: 'main',
    file: 'Qwen3-Embedding-0.6B-f16.gguf'
  }
]

// Mobile sweep axes, kept as standalone literals (not shared with the desktop
// benchmarks/performance/_sweep-grid.js) so this module stays self-contained for
// the mobile bundler. They intentionally differ from desktop (cpu+gpu vs gpu-only,
// batch <= 2048 vs <= 8192) and must not be resynced. Model/quant come from CELLS.
const PARAMETER_SWEEP = {
  device: ['cpu', 'gpu'],
  batchSize: [256, 512, 1024, 2048],
  flashAttn: ['off', 'on']
}

// Cross-product of the 4 base (model x quant) download cells with the
// reload-heavy axes batchSize (4) x flashAttn (2) = 32 cells, preserving order
// (model/quant outer, batchSize middle, flashAttn inner) so the shard list and
// workflow groups are stable.
function matrix() {
  const out = []
  for (const cell of CELLS) {
    for (const batchSize of PARAMETER_SWEEP.batchSize) {
      for (const flashAttn of PARAMETER_SWEEP.flashAttn) {
        out.push({
          model: cell.model,
          quant: cell.quant,
          repo: cell.repo,
          revision: cell.revision,
          file: cell.file,
          batchSize,
          flashAttn
        })
      }
    }
  }
  return out
}

// Filename slug: lowercase, drop dots, underscores -> dashes.
// 'embeddingGemma' -> 'embeddinggemma', 'Qwen3-embedding-0.6B' ->
// 'qwen3-embedding-06b', 'Q4_K_M' -> 'q4-k-m', 'F16' -> 'f16'.
function slug(value) {
  return String(value).toLowerCase().replace(/\./g, '').replace(/_/g, '-')
}

// Slash-free token for the (batchSize, flashAttn) pair, used in shard
// filenames, run-function names, the workflow batch key, and the artifact
// suffix: 'bs<N>-fa<on|off>'.
function configId(cell) {
  return `bs${cell.batchSize}-fa${cell.flashAttn}`
}

function shardFileName(cell) {
  return `benchmark-perf-${slug(cell.model)}-${slug(cell.quant)}-${configId(cell)}.test.js`
}

// Manifest model id for a cell. Single source for the id used by the on-device
// benchmark (modelSpec) and the report renderer's coverage check, so both agree
// on shard identity.
function modelId(cell) {
  return cell.model
}

// Stable per-shard key matching the renderer's
// "[<modelId> q=<quant>] ... [bs=<N>] [fa=<on|off>]" row label, so coverage can
// be reconciled against the matrix. device is NOT in the key: each shard emits
// the per-device configs for its one (bs, fa) pair.
function mobileShardKey(cell) {
  return `${modelId(cell)}|${cell.quant}|bs${cell.batchSize}|fa${cell.flashAttn}`
}

// Mirrors toFunctionName in scripts/generate-mobile-integration-tests.js:
// split the base name on non-alphanumerics, capitalize each part, prefix run.
// The shard file ends in `.test.js`, so the `test` token survives and the name
// carries a `Test` suffix, exactly matching the generated mobile runner.
function runFunctionName(cell) {
  const base = shardFileName(cell).replace(/\.js$/, '')
  const parts = base.split(/[^a-zA-Z0-9]+/).filter(Boolean)
  const suffix = parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('')
  return `run${suffix}`
}

// The exact lines + trailing newline each generated shard file holds.
function shardContents(cell) {
  return [
    "'use strict'",
    "const { benchmarkModel } = require('./_benchmark-perf.js')",
    `benchmarkModel('${cell.model}', '${cell.quant}', ${cell.batchSize}, '${cell.flashAttn}')`,
    ''
  ].join('\n')
}

// One workflow matrix entry per (batchSize, flashAttn) pair, each carrying its
// 4 model x quant groups in matrix order, matching the mobile-benchmark job's
// test_groups. Batching by the reload-heavy (bs, fa) pair keeps every Device
// Farm session to one (batchSize, flashAttn) so it does at most 2 model loads
// (one per device), mirroring the LLM benchmark's per-KV-cache batching.
function workflowBatches() {
  const byConfig = new Map()
  for (const cell of matrix()) {
    const key = configId(cell)
    if (!byConfig.has(key)) byConfig.set(key, [])
    const grep = runFunctionName(cell)
    byConfig.get(key).push({ name: grep.slice(3).replace(/Test$/, ''), grep })
  }
  return [...byConfig.entries()].map(([config, groups]) => ({ config, groups }))
}

module.exports = {
  matrix,
  slug,
  configId,
  shardFileName,
  modelId,
  mobileShardKey,
  runFunctionName,
  shardContents,
  workflowBatches,
  PARAMETER_SWEEP
}
