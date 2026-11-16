'use strict'

// Per-call latency of searchAsync() against search(), one query at a time,
// to show what moving the work off the JS thread costs for small requests.
// Usage: bare benchmarks/performance/id-map-index-async-overhead.js

const process = require('bare-process')
const IdMapIndex = require('../../index')

const DIM = 384
const K = 10
const QUERIES = 500
const WARMUP = 50
const CASES = [
  { storage: 'f32', count: 1_000 },
  { storage: 'f32', count: 10_000 },
  { storage: 'turbovec-q4', count: 1_000 },
  { storage: 'turbovec-q4', count: 10_000 }
]

function createRows(count, seed) {
  let state = seed >>> 0
  const vectors = new Float32Array(count * DIM)
  for (let i = 0; i < vectors.length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    vectors[i] = state / 0x100000000 - 0.5
  }
  return vectors
}

function nowUs() {
  return Number(process.hrtime.bigint()) / 1e3
}

function percentile(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
}

function summarize(samples) {
  const sorted = samples.slice().sort((a, b) => a - b)
  return { p50: percentile(sorted, 0.5), p99: percentile(sorted, 0.99) }
}

async function measure(queries, call) {
  const samples = []
  for (let i = 0; i < WARMUP + QUERIES; i++) {
    const query = queries.subarray((i % QUERIES) * DIM, (i % QUERIES + 1) * DIM)
    const start = nowUs()
    await call(query)
    if (i >= WARMUP) samples.push(nowUs() - start)
  }
  return summarize(samples)
}

async function main() {
  const queries = createRows(QUERIES, 0xabc)
  const rows = []
  for (const { storage, count } of CASES) {
    const idx = new IdMapIndex({ dim: DIM, storage })
    const ids = new BigUint64Array(count)
    for (let i = 0; i < count; i++) ids[i] = BigInt(i + 1)
    idx.addWithIds(createRows(count, count), ids)

    const sync = await measure(queries, (query) => idx.search(query, K))
    const async = await measure(queries, (query) => idx.searchAsync(query, K))
    idx.dispose()
    rows.push({ storage, count, sync, async })
  }

  console.log('| storage | vectors | sync p50 µs | async p50 µs | sync p99 µs | async p99 µs |')
  console.log('|---|---:|---:|---:|---:|---:|')
  for (const { storage, count, sync, async } of rows) {
    const cells = [sync.p50, async.p50, sync.p99, async.p99].map((v) => v.toFixed(0))
    console.log(`| ${storage} | ${count} | ${cells.join(' | ')} |`)
  }
}

main()
