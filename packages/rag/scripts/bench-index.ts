// Measures the vector index on a large namespace: ingest, rebuild from
// HyperDB, cold open from a snapshot, RSS, and search latency against the scan.
// Each phase runs in its own process so RSS figures don't carry over.
//
//   npm run build
//   bare scripts/bench-index.ts ingest  <dir> [--chunks 100000] [--dims 768] [--storage q8]
//   bare scripts/bench-index.ts rebuild <dir>   # later phases reuse ingest's settings
//   bare scripts/bench-index.ts cold    <dir>
//   bare scripts/bench-index.ts scan    <dir>
//   bare scripts/bench-index.ts replace <dir> [--rounds 20]   # rewrites the store
import fs from 'bare-fs'
import os from 'bare-os'
import Corestore from 'corestore'

import { createRag } from '../dist/index.js'
import { setNativeIndexLoader } from '../dist/vector-index/native.js'

const CHUNKS_PER_DOCUMENT = 100
const DOCUMENTS_PER_INGEST = 10
const SEARCHES = 50
const K = 10

const [phase, dir, ...rest] = Bare.argv.slice(2)
if (!phase || !dir || phase === '--help') {
  console.log(
    'usage: bare scripts/bench-index.ts <ingest|rebuild|cold|scan|replace> <dir> [options]'
  )
  Bare.exit(phase === '--help' ? 0 : 1)
}

function option(name: string, fallback: string): string {
  const at = rest.indexOf(`--${name}`)
  return at === -1 ? fallback : rest[at + 1]
}

interface Settings {
  chunks: number
  dims: number
  storage: 'f32' | 'q8' | 'turbovec-q4' | 'turbovec-q2'
}

// Ingest records its settings next to the store, so later phases open the
// namespace with the same space instead of the defaults.
const settingsPath = `${dir}/bench.json`
const { chunks, dims, storage }: Settings =
  phase === 'ingest'
    ? {
        chunks: Number(option('chunks', '100000')),
        dims: Number(option('dims', '768')),
        storage: option('storage', 'q8') as Settings['storage']
      }
    : readSettings()

function readSettings(): Settings {
  try {
    return JSON.parse(fs.readFileSync(settingsPath, 'utf8') as string) as Settings
  } catch {
    console.log(`no ${settingsPath}; run the ingest phase first`)
    Bare.exit(1)
    throw new Error('unreachable')
  }
}
const space = {
  model: 'bench',
  revision: '1',
  dimensions: dims,
  metric: 'cosine' as const,
  normalized: true,
  documentEncoding: '',
  queryEncoding: '',
  preprocessing: 'none'
}

let state = 42
function random(): number {
  state = (Math.imul(state, 1664525) + 1013904223) >>> 0
  return state / 0x100000000 - 0.5
}

function vector(): Float32Array {
  const out = new Float32Array(dims)
  for (let i = 0; i < dims; i++) out[i] = random()
  return out
}

function mib(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(0)} MiB`
}

// libuv reports maxRSS in KiB on Linux and macOS.
function report(label: string, extra: Record<string, string> = {}): void {
  const rss = os.memoryUsage().rss
  const peak = Math.max(rss, os.resourceUsage().maxRSS * 1024)
  console.log(JSON.stringify({ phase: label, rss: mib(rss), peakRss: mib(peak), ...extra }))
}

function ms(start: number): string {
  return `${(Date.now() - start).toFixed(0)} ms`
}

async function open() {
  const corestore = new Corestore(`${dir}/store`)
  const rag = createRag({ corestore, index: { dir: `${dir}/index` } })
  await rag.ready()
  return { corestore, rag }
}

async function searchLatency(
  rag: Awaited<ReturnType<typeof open>>['rag'],
  spaceId: string
): Promise<string> {
  const times: number[] = []
  for (let i = 0; i < SEARCHES; i++) {
    const query = vector()
    const start = Date.now()
    await rag.search({ scope: { namespace: 'bench' }, vector: query, spaceId, k: K })
    times.push(Date.now() - start)
  }
  times.sort((a, b) => a - b)
  return `p50 ${times[Math.floor(SEARCHES / 2)]} ms, p95 ${times[Math.floor(SEARCHES * 0.95)]} ms`
}

// Writes every document; on an existing store, with new vectors, so each one is replaced.
async function ingestAll(
  rag: Awaited<ReturnType<typeof open>>['rag'],
  spaceId: string
): Promise<void> {
  for (let next = 0; next < chunks;) {
    const documents = []
    for (let d = 0; d < DOCUMENTS_PER_INGEST && next < chunks; d++) {
      const id = `doc-${next / CHUNKS_PER_DOCUMENT}`
      const docChunks = []
      for (let c = 0; c < CHUNKS_PER_DOCUMENT && next < chunks; c++, next++) {
        docChunks.push({ content: `chunk ${next}`, embedding: vector(), spaceId })
      }
      documents.push({ id, chunks: docChunks })
    }
    await rag.ingest({ namespace: 'bench', documents })
  }
}

if (phase === 'ingest') {
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(settingsPath, JSON.stringify({ chunks, dims, storage }))
  const { corestore, rag } = await open()
  const { spaceId } = await rag.createNamespace({ name: 'bench', space, index: { storage } })
  const start = Date.now()
  await ingestAll(rag, spaceId)
  report('ingest', { chunks: String(chunks), dims: String(dims), storage, time: ms(start) })
  await rag.close()
  await corestore.close()
} else if (phase === 'replace') {
  // Replaces every document in one process with the index open.
  const rounds = Number(option('rounds', '20'))
  state = Date.now() >>> 0
  const { corestore, rag } = await open()
  const { spaceId } = await rag.createNamespace({ name: 'bench', space })
  await rag.search({ scope: { namespace: 'bench' }, vector: vector(), spaceId, k: K })
  report('replace open')
  const start = Date.now()
  for (let round = 1; round <= rounds; round++) await ingestAll(rag, spaceId)
  report('replace', {
    rounds: String(rounds),
    time: ms(start),
    search: await searchLatency(rag, spaceId)
  })
  await rag.close()
  await corestore.close()
} else {
  if (phase === 'rebuild') fs.rmSync(`${dir}/index`, { recursive: true, force: true })
  if (phase === 'scan') setNativeIndexLoader(() => Promise.resolve(null))
  const start = Date.now()
  const { corestore, rag } = await open()
  const { spaceId } = await rag.createNamespace({ name: 'bench', space })
  await rag.search({ scope: { namespace: 'bench' }, vector: vector(), spaceId, k: K })
  const firstSearch = ms(start)
  const latency = await searchLatency(rag, spaceId)
  report(phase, { openAndFirstSearch: firstSearch, search: latency })
  const closing = Date.now()
  await rag.close()
  await corestore.close()
  console.log(JSON.stringify({ phase: `${phase} close`, time: ms(closing) }))
}
