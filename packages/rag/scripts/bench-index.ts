// Measures the vector index on a large namespace: ingest, rebuild from
// HyperDB, cold open from a snapshot, RSS, and search latency against the scan.
// Each phase runs in its own process so RSS figures don't carry over.
//
//   npm run build
//   bare scripts/bench-index.ts ingest  <dir> [--chunks 100000] [--dims 768] [--storage q8]
//   bare scripts/bench-index.ts rebuild <dir>
//   bare scripts/bench-index.ts cold    <dir>
//   bare scripts/bench-index.ts scan    <dir>
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
  console.log('usage: bare scripts/bench-index.ts <ingest|rebuild|cold|scan> <dir> [options]')
  Bare.exit(phase === '--help' ? 0 : 1)
}

function option(name: string, fallback: string): string {
  const at = rest.indexOf(`--${name}`)
  return at === -1 ? fallback : rest[at + 1]
}

const chunks = Number(option('chunks', '100000'))
const dims = Number(option('dims', '768'))
const storage = option('storage', 'q8') as 'f32' | 'q8' | 'turbovec-q4' | 'turbovec-q2'
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

if (phase === 'ingest') {
  fs.rmSync(dir, { recursive: true, force: true })
  const { corestore, rag } = await open()
  const { spaceId } = await rag.createNamespace({ name: 'bench', space, index: { storage } })
  const start = Date.now()
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
  report('ingest', { chunks: String(chunks), dims: String(dims), storage, time: ms(start) })
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
