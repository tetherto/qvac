'use strict'

// Single source of truth for the mobile perf benchmark matrix. The per-shard
// test files (benchmark-perf-<size>-<quant>-<cache>.test.js) and the Benchmark
// Performance workflow's test_groups override are both generated from this
// list by scripts/generate-benchmark-shards.js, so the 2 x 5 x 7 matrix is
// defined in exactly one place. Underscore prefix keeps it out of the test
// globs (it is not a *.test.js file).

const SIZES = ['0.8B', '2B']
const QUANTS = ['Q4_0', 'Q4_1', 'Q4_K_M', 'Q6_K', 'Q8_0']
// KV-cache types as (k, v) pairs. f16/q8_0/q4_0 are symmetric (k === v); the
// TurboQuant/PolarQuant schemes pair a TBQ or PQ key with a PQ value, so k may
// differ from v. TBQ/PQ ship Vulkan + CPU kernels only, so they are reported as
// Crashed on Metal (iOS) and on GPUs that lack support (e.g. Samsung).
const CACHE_TYPES = [
  { k: 'f16', v: 'f16' },
  { k: 'q8_0', v: 'q8_0' },
  { k: 'q4_0', v: 'q4_0' },
  { k: 'tbq3_0', v: 'pq3_0' },
  { k: 'tbq4_0', v: 'pq4_0' },
  { k: 'pq3_0', v: 'pq3_0' },
  { k: 'pq4_0', v: 'pq4_0' }
]

// Additive batch/ubatch sweep, kept SEPARATE from the cross-product above rather
// than crossed into it. batch-size/ubatch-size only affect prefill throughput
// and their effect is invariant across quantization and KV-cache type, so
// sweeping batch once at a fixed baseline (quant BATCH_SWEEP_QUANT, symmetric
// f16 KV) adds a handful of shards instead of multiplying the whole matrix.
// Each batch cell carries a `batch` field; the cross-product cells above do not,
// so their shard names, keys and labels are unchanged. batch === ubatch (set on
// device by the runner). See benchmarks/performance for the desktop twin.
const BATCH_SWEEP_QUANT = 'Q4_0'
const BATCH_SWEEP_CACHE = { k: 'f16', v: 'f16' }
const BATCH_SWEEP_SIZES = [512, 1024]

// Cross-product (size x quant x cache) plus the additive batch cells.
function matrix() {
  const out = []
  for (const size of SIZES) {
    for (const quant of QUANTS) {
      for (const cache of CACHE_TYPES) {
        out.push({ size, quant, cache })
      }
    }
  }
  for (const size of SIZES) {
    for (const batch of BATCH_SWEEP_SIZES) {
      out.push({ size, quant: BATCH_SWEEP_QUANT, cache: BATCH_SWEEP_CACHE, batch })
    }
  }
  return out
}

// Filename slug: lowercase, drop dots, underscores -> dashes.
// '0.8B' -> '08b', 'Q4_K_M' -> 'q4-k-m', 'q8_0' -> 'q8-0'.
function slug(value) {
  return String(value).toLowerCase().replace(/\./g, '').replace(/_/g, '-')
}

// Single slash-free token identifying a KV-cache type (filesystem and artifact
// safe): the cache type when k === v, else 'k-v'. Used for shard filenames and
// the workflow batch / artifact-suffix name.
function cacheId(cache) {
  return cache.k === cache.v ? cache.k : `${cache.k}-${cache.v}`
}

// Display label for a KV-cache type in report rows: the cache type when
// k === v, else 'k/v', matching the renderer's [kv=...] tag.
function cacheLabel(cache) {
  return cache.k === cache.v ? cache.k : `${cache.k}/${cache.v}`
}

// Trailing '-bs<N>' token for batch-sweep cells; empty for cross-product cells,
// so their filenames, keys and function names are unchanged.
function batchSuffix(cell) {
  return cell.batch !== undefined ? `-bs${cell.batch}` : ''
}

function shardFileName(cell) {
  return `benchmark-perf-${slug(cell.size)}-${slug(cell.quant)}-${slug(cacheId(cell.cache))}${batchSuffix(cell)}.test.js`
}

// HuggingFace model id for a cell, e.g. {size:'0.8B',quant:'Q4_0'} -> 'qwen3.5-0.8b-Q4_0'.
// Single source for the id used by the on-device benchmark (modelSpec) and by
// the report renderer's coverage check, so both agree on shard identity.
function modelId(size, quant) {
  return `qwen3.5-${size.toLowerCase()}-${quant}`
}

function modelFileName(size, quant) {
  return `Qwen3.5-${size}-${quant}.gguf`
}

// Stable per-shard key matching the renderer's "[<modelId>] ... [kv=<cache>]
// [bs=<N>]" row label, so coverage can be reconciled against the matrix. The
// '|bs<N>' suffix is present only for batch-sweep cells, so cross-product cells
// keep their existing keys.
function mobileShardKey(cell) {
  const base = `${modelId(cell.size, cell.quant)}|${cacheLabel(cell.cache)}`
  return cell.batch !== undefined ? `${base}|bs${cell.batch}` : base
}

// Mirrors toFunctionName in scripts/generate-mobile-integration-tests.js:
// split the base name on non-alphanumerics, capitalize each part, prefix run.
function runFunctionName(cell) {
  const base = shardFileName(cell).replace(/\.js$/, '')
  const parts = base.split(/[^a-zA-Z0-9]+/).filter(Boolean)
  const suffix = parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('')
  return `run${suffix}`
}

// The exact lines + trailing newline each generated shard file holds. Batch
// cells pass their batch size as the 5th argument; cross-product cells omit it
// so their generated files are byte-identical to before.
function shardContents(cell) {
  const batchArg = cell.batch !== undefined ? `, ${cell.batch}` : ''
  return [
    "'use strict'",
    "const { benchmarkModel } = require('./_benchmark-perf.js')",
    `benchmarkModel('${cell.size}', '${cell.quant}', '${cell.cache.k}', '${cell.cache.v}'${batchArg})`,
    ''
  ].join('\n')
}

// Workflow test_groups, one matrix entry per Device Farm batch. Seven entries
// (one per KV-cache type) carry the cross-product's 10 groups each; a final
// 'batchsweep' entry carries the additive batch cells (size x batch) so they run
// as their own bounded Device Farm job instead of enlarging a KV batch.
function workflowBatches() {
  const groupOf = (cell) => {
    const grep = runFunctionName(cell)
    return { name: grep.slice(3).replace(/Test$/, ''), grep }
  }
  const cacheBatches = CACHE_TYPES.map((cache) => ({
    cache: cacheId(cache),
    groups: SIZES.flatMap((size) => QUANTS.map((quant) => groupOf({ size, quant, cache })))
  }))
  const batchGroups = SIZES.flatMap((size) =>
    BATCH_SWEEP_SIZES.map((batch) =>
      groupOf({ size, quant: BATCH_SWEEP_QUANT, cache: BATCH_SWEEP_CACHE, batch })
    )
  )
  return [...cacheBatches, { cache: 'batchsweep', groups: batchGroups }]
}

module.exports = {
  SIZES,
  QUANTS,
  CACHE_TYPES,
  matrix,
  slug,
  cacheId,
  cacheLabel,
  shardFileName,
  modelId,
  modelFileName,
  mobileShardKey,
  runFunctionName,
  shardContents,
  workflowBatches
}
