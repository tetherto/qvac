// Compares an 'f16' namespace with an 'f32' one holding the same vectors:
// recall@k of the f16 results against the f32 ones, and how far the scores of
// the same chunks moved. Runs the scan and the native index.
//
//   npm run build
//   bare scripts/bench-f16.ts <dir> [--chunks 10400] [--dims 768] [--queries 200]
//                                   [--clusters 200] [--noise 0.05]
//
// `--clusters 0` draws uniform random vectors, whose near-tied neighbours are
// the worst case for ranking.
import fs from 'bare-fs'
import Corestore from 'corestore'

import { createRag } from '../dist/index.js'
import { setNativeIndexLoader } from '../dist/vector-index/native.js'

const CHUNKS_PER_DOCUMENT = 8
const DOCUMENTS_PER_INGEST = 50
const K = 10

const [dir, ...rest] = Bare.argv.slice(2)
if (!dir || dir === '--help') {
  console.log(
    'usage: bare scripts/bench-f16.ts <dir> [--chunks n] [--dims n] [--queries n] [--clusters n] [--noise x]'
  )
  Bare.exit(dir ? 0 : 1)
}

function option(name: string, fallback: string): string {
  const at = rest.indexOf(`--${name}`)
  return at === -1 ? fallback : rest[at + 1]
}

const chunks = Number(option('chunks', '10400'))
const dims = Number(option('dims', '768'))
const queries = Number(option('queries', '200'))
const clusters = Number(option('clusters', '200'))
const noise = Number(option('noise', '0.05'))

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

let state = 7
function uniform(): number {
  state = (Math.imul(state, 1664525) + 1013904223) >>> 0
  return state / 0x100000000
}

function gaussian(): number {
  return Math.sqrt(-2 * Math.log(uniform() || 1e-12)) * Math.cos(2 * Math.PI * uniform())
}

function normalize(vector: Float32Array): Float32Array {
  let sum = 0
  for (const value of vector) sum += value * value
  const norm = Math.sqrt(sum)
  for (let i = 0; i < vector.length; i++) vector[i] /= norm
  return vector
}

function randomUnit(): Float32Array {
  const out = new Float32Array(dims)
  for (let i = 0; i < dims; i++) out[i] = gaussian()
  return normalize(out)
}

const centers = Array.from({ length: clusters }, randomUnit)

function sample(): Float32Array {
  if (clusters === 0) return randomUnit()
  const center = centers[Math.floor(uniform() * clusters)]
  const out = new Float32Array(dims)
  for (let i = 0; i < dims; i++) out[i] = center[i] + gaussian() * noise
  return normalize(out)
}

type Rag = ReturnType<typeof createRag>
type Hit = { id: string; score: number }

async function open(scan: boolean): Promise<{ rag: Rag; corestore: Corestore }> {
  setNativeIndexLoader(scan ? () => Promise.resolve(null) : null)
  const corestore = new Corestore(`${dir}/store`)
  const rag = createRag({ corestore })
  await rag.ready()
  return { rag, corestore }
}

async function ingest(): Promise<string> {
  const { rag, corestore } = await open(true)
  let spaceId = ''
  for (const vectorEncoding of ['f32', 'f16'] as const) {
    spaceId = (await rag.createNamespace({ name: vectorEncoding, space, vectorEncoding })).spaceId
  }
  for (let next = 0, doc = 0; next < chunks;) {
    const documents = []
    for (let d = 0; d < DOCUMENTS_PER_INGEST && next < chunks; d++, doc++) {
      const docChunks = []
      for (let c = 0; c < CHUNKS_PER_DOCUMENT && next < chunks; c++, next++) {
        docChunks.push({ content: `chunk ${next}`, embedding: sample(), spaceId })
      }
      documents.push({ id: `doc-${doc}`, chunks: docChunks })
    }
    for (const namespace of ['f32', 'f16']) await rag.ingest({ namespace, documents })
  }
  await rag.close()
  await corestore.close()
  return spaceId
}

async function run(
  scan: boolean,
  spaceId: string,
  queryVectors: Float32Array[]
): Promise<Record<string, number | string>> {
  const { rag, corestore } = await open(scan)
  let overlap = 0
  let sameTop = 0
  let compared = 0
  let deltaSum = 0
  let deltaMax = 0
  let relativeSum = 0
  for (const vector of queryVectors) {
    const results: Record<string, Hit[]> = {}
    for (const namespace of ['f32', 'f16']) {
      const hits = await rag.search({ scope: { namespace }, vector, spaceId, k: K })
      results[namespace] = hits.map((hit) => ({
        id: `${hit.documentId}:${hit.ordinal}`,
        score: hit.score
      }))
    }
    const full = new Map(results.f32.map((hit) => [hit.id, hit.score]))
    if (results.f16[0]?.id === results.f32[0]?.id) sameTop++
    for (const hit of results.f16) {
      const reference = full.get(hit.id)
      if (reference === undefined) continue
      overlap++
      const delta = Math.abs(hit.score - reference)
      compared++
      deltaSum += delta
      relativeSum += delta / Math.abs(reference)
      deltaMax = Math.max(deltaMax, delta)
    }
  }
  await rag.close()
  await corestore.close()
  return {
    path: scan ? 'scan' : 'native index',
    [`recall@${K}`]: (overlap / (queryVectors.length * K)).toFixed(4),
    sameTop1: (sameTop / queryVectors.length).toFixed(4),
    meanScoreDelta: (deltaSum / compared).toExponential(2),
    maxScoreDelta: deltaMax.toExponential(2),
    meanRelativeDelta: (relativeSum / compared).toExponential(2)
  }
}

fs.rmSync(dir, { recursive: true, force: true })
fs.mkdirSync(dir, { recursive: true })
const spaceId = await ingest()
const queryVectors = Array.from({ length: queries }, sample)
console.log(JSON.stringify({ chunks, dims, queries, clusters, noise }))
for (const scan of [true, false]) {
  console.log(JSON.stringify(await run(scan, spaceId, queryVectors)))
}
