'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const process = require('bare-process')
const IdMapIndex = require('../../idMapIndex')

const DIM = 384
const VECTOR_COUNT = 10000
const QUERY_COUNT = 128
const K = 10
const FILTER_COUNT = 1000
const IVF_LISTS = 100
const IVF_NPROBE = 10
const DELTA_COUNT = 128
const MEASURED_RUNS = 3
const STORAGE_CASES = [
  { storage: 'q4', bitWidth: 4, supportsMmap: true, supportsDelta: true },
  { storage: 'q8', bitWidth: 8, supportsMmap: true, supportsDelta: true },
  { storage: 'f32', bitWidth: 32, supportsMmap: true, supportsDelta: true },
  { storage: 'turbovec-q4', bitWidth: 4, supportsMmap: false, supportsDelta: false },
  { storage: 'turbovec-q2', bitWidth: 2, supportsMmap: false, supportsDelta: false }
]
const RUN_ID = `${process.pid || 'unknown'}-${Date.now()}`
const REPORT_PATH =
  (process.env && process.env.QVAC_BENCHMARK_REPORT_PATH) ||
  path.join(__dirname, 'id-map-index-turbovec-cpu-report.md')
const REPORT_TMP_PATH = `${REPORT_PATH}.${RUN_ID}.tmp`
const TMP_DIR = path.join(__dirname, `.tmp-id-map-index-turbovec-${RUN_ID}`)

function createRng(seed) {
  let state = seed >>> 0
  return function () {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x100000000
  }
}

function createNormalizedVectors(count, dim, seed) {
  const rng = createRng(seed)
  const values = new Float32Array(count * dim)
  for (let row = 0; row < count; row++) {
    let norm = 0
    const offset = row * dim
    for (let col = 0; col < dim; col++) {
      const value = rng() * 2 - 1
      values[offset + col] = value
      norm += value * value
    }
    norm = Math.sqrt(norm) || 1
    for (let col = 0; col < dim; col++) values[offset + col] /= norm
  }
  return values
}

function createIds(count, start) {
  const ids = new BigUint64Array(count)
  for (let i = 0; i < count; i++) ids[i] = BigInt(start + i)
  return ids
}

function createQueries(vectors) {
  const queries = new Float32Array(QUERY_COUNT * DIM)
  for (let row = 0; row < QUERY_COUNT; row++) {
    const source = (row * 7919) % VECTOR_COUNT
    queries.set(vectors.subarray(source * DIM, source * DIM + DIM), row * DIM)
  }
  return queries
}

function createFilterIds(ids) {
  const filterIds = new BigUint64Array(FILTER_COUNT)
  const step = Math.max(1, Math.floor(ids.length / FILTER_COUNT))
  for (let i = 0; i < FILTER_COUNT; i++) filterIds[i] = ids[(i * step) % ids.length]
  return filterIds
}

function nowMs() {
  return Number(process.hrtime.bigint()) / 1e6
}

function measureSync(fn) {
  const start = nowMs()
  const value = fn()
  return { ms: nowMs() - start, value }
}

function median(values) {
  return values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)]
}

function measureMedianMs(fn) {
  const samples = []
  for (let i = 0; i < MEASURED_RUNS; i++) samples.push(measureSync(fn).ms)
  return median(samples)
}

function qps(count, ms) {
  return ms === 0 ? 0 : (count * 1000) / ms
}

function round(value, digits = 3) {
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}

function fileSize(file) {
  return fs.statSync(file).size
}

function cleanupFile(file) {
  if (fs.existsSync(file)) fs.unlinkSync(file)
}

function cleanupDeltaArtifacts(delta) {
  cleanupFile(delta)
  cleanupFile(`${delta}.lock`)
}

function envValue(name) {
  return process.env && process.env[name] ? process.env[name] : 'unknown'
}

function agreementAtK(fullScanIds, ivfIds) {
  let hits = 0
  for (let row = 0; row < QUERY_COUNT; row++) {
    const fullScan = new Set()
    for (let slot = 0; slot < K; slot++) {
      fullScan.add(fullScanIds[row * K + slot].toString())
    }
    for (let slot = 0; slot < K; slot++) {
      if (fullScan.has(ivfIds[row * K + slot].toString())) hits++
    }
  }
  return hits / (QUERY_COUNT * K)
}

function bruteForceSearch(vectors, ids, queries, queryCount) {
  const outIds = new BigUint64Array(queryCount * K)
  for (let row = 0; row < queryCount; row++) {
    const bestScores = new Float32Array(K)
    const bestIds = new BigUint64Array(K)
    bestScores.fill(-Infinity)
    bestIds.fill((1n << 64n) - 1n)
    for (let vectorIndex = 0; vectorIndex < VECTOR_COUNT; vectorIndex++) {
      let score = 0
      for (let col = 0; col < DIM; col++) {
        score += queries[row * DIM + col] * vectors[vectorIndex * DIM + col]
      }
      for (let slot = 0; slot < K; slot++) {
        if (score <= bestScores[slot]) continue
        for (let shift = K - 1; shift > slot; shift--) {
          bestScores[shift] = bestScores[shift - 1]
          bestIds[shift] = bestIds[shift - 1]
        }
        bestScores[slot] = score
        bestIds[slot] = ids[vectorIndex]
        break
      }
    }
    outIds.set(bestIds, row * K)
  }
  return outIds
}

function assertV4Delta(delta) {
  const bytes = fs.readFileSync(delta)
  if (
    bytes.length < 5 ||
    bytes[0] !== 0x54 ||
    bytes[1] !== 0x56 ||
    bytes[2] !== 0x44 ||
    bytes[3] !== 0x4c ||
    bytes[4] !== 4
  ) {
    throw new Error('Expected a v4 TVDL delta log')
  }
}

function runCase(config, vectors, ids, queries, filterIds, deltaVectors) {
  const { storage, bitWidth, supportsMmap, supportsDelta } = config
  const snapshot = path.join(TMP_DIR, `id-map-index-${storage}.tvim`)
  const delta = path.join(TMP_DIR, `id-map-index-${storage}.tvid`)
  cleanupFile(snapshot)
  cleanupDeltaArtifacts(delta)

  let idx = null
  let loaded = null
  let mmap = null
  let filter = null
  try {
    idx = new IdMapIndex({ dim: DIM, bitWidth, storage })
    const add = measureSync(() => idx.addWithIds(vectors, ids))

    idx.search(queries.subarray(0, DIM * 8), K)
    const fullScanResult = idx.search(queries, K)
    const fullScanMs = measureMedianMs(() => idx.search(queries, K))

    const filterBuild = measureSync(() => {
      filter = idx.prepareFilter(filterIds)
    })
    filter.search(queries.subarray(0, DIM * 8), K)
    const filterMs = measureMedianMs(() => filter.search(queries, K))

    const ivfBuild = measureSync(() => idx.buildIvf(IVF_LISTS, 1))
    idx.searchIvf(queries.subarray(0, DIM * 8), K, IVF_NPROBE)
    const ivfResult = idx.searchIvf(queries, K, IVF_NPROBE)
    const ivfMs = measureMedianMs(() => idx.searchIvf(queries, K, IVF_NPROBE))

    const write = measureSync(() => idx.write(snapshot))
    const load = measureSync(() => IdMapIndex.load(snapshot))
    loaded = load.value

    let mmapLoadMs = 'n/a'
    let mmapFullScanQps = 'n/a'
    if (supportsMmap) {
      const mmapLoad = measureSync(() => IdMapIndex.loadMmap(snapshot))
      mmap = mmapLoad.value
      mmapLoadMs = round(mmapLoad.ms, 2)
      mmap.search(queries.subarray(0, DIM * 8), K)
      mmapFullScanQps = Math.round(
        qps(QUERY_COUNT, measureMedianMs(() => mmap.search(queries, K)))
      )
    }

    let addLoggedUsPerVector = 'n/a'
    let removeLoggedUsPerCall = 'n/a'
    let deltaKb = 'n/a'
    if (supportsDelta) {
      const deltaIds = createIds(DELTA_COUNT, 9000000 + bitWidth * 1000)
      const added = measureSync(() => idx.addLogged(deltaVectors, deltaIds, delta))
      addLoggedUsPerVector = round((added.ms * 1000) / DELTA_COUNT, 2)
      const removed = measureSync(() => {
        for (let i = 0; i < DELTA_COUNT; i++) {
          if (idx.removeLogged(ids[i], delta) !== true) {
            throw new Error(`removeLogged unexpectedly missed id ${ids[i]}`)
          }
        }
      })
      removeLoggedUsPerCall = round((removed.ms * 1000) / DELTA_COUNT, 2)
      assertV4Delta(delta)
      deltaKb = round(fileSize(delta) / 1024, 1)
    }

    return {
      storage,
      fileMb: round(fileSize(snapshot) / 1024 / 1024, 2),
      ingestVectorsPerSec: Math.round(qps(VECTOR_COUNT, add.ms)),
      fullScanQps: Math.round(qps(QUERY_COUNT, fullScanMs)),
      ivfBuildMs: round(ivfBuild.ms, 2),
      ivfQps: Math.round(qps(QUERY_COUNT, ivfMs)),
      ivfAgreementAt10: round(agreementAtK(fullScanResult.ids, ivfResult.ids)),
      writeMs: round(write.ms, 2),
      loadMs: round(load.ms, 2),
      mmapLoadMs,
      mmapFullScanQps,
      filterBuildMs: round(filterBuild.ms, 2),
      preparedFilterQps: Math.round(qps(QUERY_COUNT, filterMs)),
      addLoggedUsPerVector,
      removeLoggedUsPerCall,
      deltaKb
    }
  } finally {
    if (filter !== null) filter.dispose()
    if (loaded !== null) loaded.dispose()
    if (mmap !== null) mmap.dispose()
    if (idx !== null) idx.dispose()
    cleanupFile(snapshot)
    cleanupDeltaArtifacts(delta)
  }
}

function toMarkdown(report) {
  const lines = [
    '# IdMapIndex TurboVec CPU Benchmark',
    '',
    `- Generated: ${report.generatedAt}`,
    '- Command: `bare benchmarks/performance/id-map-index-turbovec-cpu.js`',
    `- Runtime: ${report.runtime}`,
    `- Platform: ${report.platform}`,
    `- CPU model: ${report.cpuModel}`,
    `- QVAC commit: ${report.qvacCommit}`,
    `- Fabric source: ${report.fabricSource}`,
    `- Dataset: ${VECTOR_COUNT} vectors x ${DIM} dimensions`,
    `- Queries: ${QUERY_COUNT}, top-k: ${K}`,
    '',
    '## CPU Results',
    '',
    '| Storage | .tvim MB | Ingest vectors/s | Full-scan q/s | IVF build ms | IVF q/s | IVF agreement@10 | Write ms |',
    '|---|---:|---:|---:|---:|---:|---:|---:|'
  ]
  for (const item of report.results) {
    lines.push(
      `| ${item.storage} | ${item.fileMb} | ${item.ingestVectorsPerSec} | ${item.fullScanQps}` +
        ` | ${item.ivfBuildMs} | ${item.ivfQps} | ${item.ivfAgreementAt10} | ${item.writeMs} |`
    )
  }
  lines.push(
    '',
    '## Persistence, Filter, Mmap, Delta',
    '',
    '| Storage | Load ms | Mmap load ms | Mmap full-scan q/s | Filter build ms | Filter q/s | addLogged µs/vector | removeLogged µs/call | Delta KB |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|'
  )
  for (const item of report.results) {
    lines.push(
      `| ${item.storage} | ${item.loadMs} | ${item.mmapLoadMs} | ${item.mmapFullScanQps}` +
        ` | ${item.filterBuildMs} | ${item.preparedFilterQps} | ${item.addLoggedUsPerVector}` +
        ` | ${item.removeLoggedUsPerCall} | ${item.deltaKb} |`
    )
  }
  lines.push(
    '',
    '## Notes',
    '',
    `- JS brute-force exact search baseline: ${report.bruteForceQps} q/s.`,
    '- Generic q4/q8/f32 delta persistence is validated as v4 TVDL.',
    '- TurboVec q2/q4 use normal snapshot load; mmap and delta-log mutations are unsupported.',
    '- Synthetic normalized vectors measure index mechanics, not embedding quality.',
    ''
  )
  return `${lines.join('\n')}\n`
}

function main() {
  const arch = process.arch || 'unknown'
  if (arch !== 's390x' && !arch.includes('64')) {
    throw new Error(`TurboVec CPU benchmark requires a 64-bit target; detected ${arch}`)
  }

  fs.mkdirSync(TMP_DIR, { recursive: true })
  try {
    console.log('Generating synthetic vectors...')
    const vectors = createNormalizedVectors(VECTOR_COUNT, DIM, 0x5eed1234)
    const ids = createIds(VECTOR_COUNT, 1000000)
    const queries = createQueries(vectors)
    const filterIds = createFilterIds(ids)
    const deltaVectors = createNormalizedVectors(DELTA_COUNT, DIM, 0x9e3779b9)

    console.log('Benchmarking JS brute-force baseline...')
    bruteForceSearch(vectors, ids, queries.subarray(0, DIM * 8), 8)
    const bruteForceMs = measureMedianMs(() =>
      bruteForceSearch(vectors, ids, queries, QUERY_COUNT)
    )

    const results = []
    for (const config of STORAGE_CASES) {
      console.log(`Benchmarking storage=${config.storage}...`)
      results.push(runCase(config, vectors, ids, queries, filterIds, deltaVectors))
    }

    const report = {
      generatedAt: new Date().toISOString(),
      runtime: process.version || 'unknown',
      platform: `${process.platform || 'unknown'} ${process.arch || 'unknown'}`,
      cpuModel: envValue('QVAC_BENCHMARK_CPU_MODEL'),
      qvacCommit: envValue('QVAC_COMMIT'),
      fabricSource: envValue('QVAC_FABRIC_REF'),
      bruteForceQps: Math.round(qps(QUERY_COUNT, bruteForceMs)),
      results
    }
    fs.writeFileSync(REPORT_TMP_PATH, toMarkdown(report))
    fs.renameSync(REPORT_TMP_PATH, REPORT_PATH)
    console.log(`Wrote ${REPORT_PATH}`)
  } finally {
    cleanupFile(REPORT_TMP_PATH)
    fs.rmSync(TMP_DIR, { recursive: true, force: true })
  }
}

try {
  main()
} catch (error) {
  console.error(error && error.stack ? error.stack : error)
  process.exit(1)
}
