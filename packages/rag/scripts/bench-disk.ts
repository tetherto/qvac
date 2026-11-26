// Splits a namespace's on-disk size into vectors, text, keys and record
// fields, Hyperbee tree overhead, Hypercore/RocksDB storage, and the index
// snapshot directory.
//
//   npm run build
//   bare scripts/bench-disk.ts <dir> [--chunks 10400] [--dims 768] [--text 1000]
//                                    [--per-doc 8] [--storage q8] [--encoding f32]
import fs from 'bare-fs'
import Corestore from 'corestore'

import { createRag } from '../dist/index.js'
import hyperdbSpec from '../dist/db/hyperspec/hyperdb/index.js'

const CORE_NAME = 'qvac-rag'
const DOCUMENTS_PER_INGEST = 10
const COLLECTIONS = [
  'spaces',
  'namespaces',
  'documents',
  'chunks',
  'nativeIds',
  'mutations',
  'tombstones'
]

const [dir, ...rest] = Bare.argv.slice(2)
if (!dir || dir === '--help') {
  console.log(
    'usage: bare scripts/bench-disk.ts <dir> [--chunks n] [--dims n] [--text bytes] [--per-doc n] [--storage q8] [--encoding f32]'
  )
  Bare.exit(dir ? 0 : 1)
}

function option(name: string, fallback: string): string {
  const at = rest.indexOf(`--${name}`)
  return at === -1 ? fallback : rest[at + 1]
}

const chunks = Number(option('chunks', '10400'))
const dims = Number(option('dims', '768'))
const textBytes = Number(option('text', '1000'))
const perDoc = Number(option('per-doc', '8'))
const storage = option('storage', 'q8') as 'f32' | 'q8' | 'turbovec-q4' | 'turbovec-q2'
const vectorEncoding = option('encoding', 'f32') as 'f32' | 'f16'

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
  return state / 0x100000000
}

function vector(): Float32Array {
  const out = new Float32Array(dims)
  let norm = 0
  for (let i = 0; i < dims; i++) {
    out[i] = random() - 0.5
    norm += out[i] * out[i]
  }
  norm = Math.sqrt(norm)
  for (let i = 0; i < dims; i++) out[i] /= norm
  return out
}

const WORDS =
  'the index store vector chunk search query model document namespace rebuild snapshot export import sync device peer local first private embedding score rank recall latency memory disk file record field key value tree block core append write read open close ready batch commit revision generation ordinal metadata content text token sentence paragraph section heading list table code example config option default error warning retry timeout'.split(
    ' '
  )

function text(): string {
  let out = ''
  while (out.length < textBytes) {
    const word = WORDS[Math.floor(random() * WORDS.length)]
    out += out.length === 0 ? word : (random() < 0.08 ? '. ' : ' ') + word
  }
  return out.slice(0, textBytes)
}

function mb(bytes: number): string {
  return (bytes / 1e6).toFixed(2)
}

interface Usage {
  [group: string]: number
}

function walk(path: string, usage: Usage, group: (file: string) => string): number {
  let total = 0
  for (const entry of fs.readdirSync(path) as string[]) {
    const full = `${path}/${entry}`
    const stat = fs.statSync(full)
    if (stat.isDirectory()) {
      total += walk(full, usage, group)
    } else {
      const g = group(entry)
      usage[g] = (usage[g] ?? 0) + stat.size
      total += stat.size
    }
  }
  return total
}

function rocksGroup(file: string): string {
  if (file.endsWith('.blob')) return 'blob files'
  if (file.endsWith('.sst')) return 'sst files'
  if (file.endsWith('.log')) return 'wal'
  return 'other (MANIFEST, OPTIONS, LOG, lock)'
}

// Hyperbee nodes are protobuf: 1 = tree index, 2 = key, 3 = value.
function decodeNode(block: Uint8Array): {
  index: number
  key: Uint8Array
  value: Uint8Array | null
} {
  let offset = 0
  let index = 0
  let key = new Uint8Array(0)
  let value: Uint8Array | null = null
  function varint(): number {
    let result = 0
    let shift = 0
    for (;;) {
      const byte = block[offset++]
      result += (byte & 0x7f) * 2 ** shift
      if (byte < 0x80) return result
      shift += 7
    }
  }
  while (offset < block.byteLength) {
    const tag = varint()
    const length = varint()
    const bytes = block.subarray(offset, offset + length)
    offset += length
    if (tag >> 3 === 1) index = length
    else if (tag >> 3 === 2) key = bytes
    else if (tag >> 3 === 3) value = bytes
  }
  return { index, key, value }
}

async function ingest(): Promise<void> {
  const corestore = new Corestore(`${dir}/store`)
  const rag = createRag({ corestore, index: { dir: `${dir}/index` } })
  await rag.ready()
  const { spaceId } = await rag.createNamespace({
    name: 'bench',
    space,
    index: { storage },
    vectorEncoding
  })
  for (let next = 0, doc = 0; next < chunks;) {
    const documents = []
    for (let d = 0; d < DOCUMENTS_PER_INGEST && next < chunks; d++, doc++) {
      const docChunks = []
      for (let c = 0; c < perDoc && next < chunks; c++, next++) {
        docChunks.push({ content: text(), embedding: vector(), spaceId })
      }
      const id = `knowledge/section-${String(doc % 40).padStart(2, '0')}/topic-${String(doc).padStart(5, '0')}.md`
      documents.push({ id, chunks: docChunks })
    }
    await rag.ingest({ namespace: 'bench', documents })
  }
  // The index is built on the first search; its snapshot is written on close.
  await rag.search({ scope: { namespace: 'bench' }, vector: vector(), spaceId, k: 10 })
  await rag.close()
  await corestore.close()
}

interface Split {
  blocks: number
  bytes: number
  tree: number
  key: number
  value: number
}

async function inspect() {
  const corestore = new Corestore(`${dir}/store`)
  const core = corestore.get({ name: CORE_NAME })
  await core.ready()
  const chunkEnc = hyperdbSpec.resolveCollection('@rag/chunks')
  const byCollection: Record<string, Split> = {}
  let header = 0
  let protobufFraming = 0
  const chunk = { vector: 0, content: 0, otherFields: 0, deletes: 0 }
  for (let i = 0; i < core.length; i++) {
    const block = (await core.get(i)) as Uint8Array
    if (i === 0) {
      header += block.byteLength
      continue
    }
    const node = decodeNode(block)
    const name = COLLECTIONS[node.key[0]] ?? `prefix ${node.key[0]}`
    const split = (byCollection[name] ??= { blocks: 0, bytes: 0, tree: 0, key: 0, value: 0 })
    split.blocks++
    split.bytes += block.byteLength
    split.tree += node.index
    split.key += node.key.byteLength
    split.value += node.value?.byteLength ?? 0
    protobufFraming +=
      block.byteLength - node.index - node.key.byteLength - (node.value?.byteLength ?? 0)
    if (name === 'chunks') {
      if (!node.value) {
        chunk.deletes++
        continue
      }
      const record = chunkEnc.reconstruct(1, node.key, node.value)
      const vectorBytes = record.vector.byteLength
      const contentBytes = Buffer.byteLength(record.content)
      chunk.vector += vectorBytes
      chunk.content += contentBytes
      chunk.otherFields += node.value.byteLength - vectorBytes - contentBytes
    }
  }
  const blocks = core.length
  const blockBytes = core.byteLength
  await core.close()
  await corestore.close()
  return { byCollection, header, protobufFraming, chunk, blocks, blockBytes }
}

fs.rmSync(dir, { recursive: true, force: true })
fs.mkdirSync(dir, { recursive: true })
const start = Date.now()
await ingest()
const ingestMs = Date.now() - start

const storeUsage: Usage = {}
const storeTotal = walk(`${dir}/store`, storeUsage, rocksGroup)
const indexUsage: Usage = {}
const indexTotal = fs.existsSync(`${dir}/index`)
  ? walk(`${dir}/index`, indexUsage, () => 'snapshot')
  : 0
const logical = await inspect()

// Reopening flushes the memtable, so measure the store again after it.
const storeUsageReopened: Usage = {}
const storeTotalReopened = walk(`${dir}/store`, storeUsageReopened, rocksGroup)

const c = logical.byCollection.chunks
const treeAll = Object.values(logical.byCollection).reduce((sum, s) => sum + s.tree, 0)
const keysAll = Object.values(logical.byCollection).reduce((sum, s) => sum + s.key, 0)
const nonChunkValues = Object.entries(logical.byCollection)
  .filter(([name]) => name !== 'chunks')
  .reduce((sum, [, s]) => sum + s.value, 0)

const rows: [string, number][] = [
  [`vectors (${vectorEncoding})`, logical.chunk.vector],
  ['chunk text', logical.chunk.content],
  ['chunk other fields (chunkId, nativeId, type/version)', logical.chunk.otherFields],
  ['keys, all collections', keysAll],
  ['Hyperbee tree index in each node', treeAll],
  ['other rows (documents, nativeIds, mutations, ...)', nonChunkValues],
  ['protobuf framing + header', logical.protobufFraming + logical.header],
  ['= Hypercore block bytes', logical.blockBytes],
  [
    'Hypercore/RocksDB storage overhead (store dir − blocks)',
    storeTotalReopened - logical.blockBytes
  ],
  ['= store dir', storeTotalReopened],
  ['index snapshot dir', indexTotal],
  ['= total', storeTotalReopened + indexTotal]
]

console.log(
  JSON.stringify(
    {
      chunks,
      dims,
      textBytes,
      perDoc,
      storage,
      vectorEncoding,
      ingest: `${ingestMs} ms`,
      blocks: logical.blocks
    },
    null,
    0
  )
)
console.log('\ncomponent'.padEnd(62) + 'MB'.padStart(9) + '  share')
const total = storeTotalReopened + indexTotal
for (const [label, bytes] of rows) {
  console.log(label.padEnd(61) + mb(bytes).padStart(9) + `  ${((bytes / total) * 100).toFixed(1)}%`)
}
console.log('\nper collection (blocks, MB, tree MB, key MB, value MB):')
for (const [name, s] of Object.entries(logical.byCollection)) {
  console.log(
    `  ${name.padEnd(12)} ${String(s.blocks).padStart(7)} ${mb(s.bytes).padStart(8)} ${mb(s.tree).padStart(8)} ${mb(s.key).padStart(8)} ${mb(s.value).padStart(8)}`
  )
}
console.log(
  `  chunk deletes: ${logical.chunk.deletes}; chunk avg block ${(c.bytes / c.blocks).toFixed(0)} B`
)
console.log(
  '\nstore dir files right after close:',
  JSON.stringify(Object.fromEntries(Object.entries(storeUsage).map(([k, v]) => [k, mb(v)]))),
  `total ${mb(storeTotal)}`
)
console.log(
  'store dir files after reopen:',
  JSON.stringify(
    Object.fromEntries(Object.entries(storeUsageReopened).map(([k, v]) => [k, mb(v)]))
  ),
  `total ${mb(storeTotalReopened)}`
)
console.log('index dir:', mb(indexTotal), 'MB')
