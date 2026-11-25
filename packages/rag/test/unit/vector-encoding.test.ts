import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import url from 'bare-url'
import tmp from 'test-tmp'
import Corestore from 'corestore'

import { ERR_CODES, createRag } from '../../src/index.js'
import { fromHalf, roundToEncoding, toHalf } from '../../src/db/encoding.js'
import { CHUNKS, type ChunkRecord } from '../../src/db/records.js'
import { SPACE, inspect, openRag, rejectsWithCode, useScan, type Test } from './helpers.js'
import type { Rag } from '../../src/types.js'

const FIXTURE = path.join(
  path.dirname(url.fileURLToPath(import.meta.url)),
  '../../../fixtures/rag-0.11.0'
)

async function collect(stream: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = []
  for await (const part of stream) parts.push(part)
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.byteLength
  }
  return out
}

async function* source(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield bytes
}

function header(bytes: Uint8Array): Record<string, unknown> {
  const length = new DataView(bytes.buffer, bytes.byteOffset).getUint32(8, true)
  return JSON.parse(String.fromCharCode(...bytes.subarray(13, 13 + length))) as Record<
    string,
    unknown
  >
}

// The frames after the header, which names the namespace.
function afterHeader(bytes: Uint8Array): Uint8Array {
  const length = new DataView(bytes.buffer, bytes.byteOffset).getUint32(8, true)
  return bytes.subarray(13 + length)
}

function rounded(values: number[]): number[] {
  const vector = Float32Array.from(values)
  roundToEncoding(vector, 'f16')
  return Array.from(vector)
}

function dotScore(a: number[], b: number[]): number {
  return Math.fround(a.reduce((sum, value, i) => Math.fround(sum + Math.fround(value * b[i])), 0))
}

const VECTORS: Record<string, number[]> = {
  a: [0.1, 0.3, 0.7],
  b: [0.7, 0.2, 0.05],
  c: [0.33, 0.33, 0.333]
}

async function openF16(
  t: Test,
  name = 'ns'
): Promise<{ rag: Rag; store: Corestore; spaceId: string }> {
  const { rag, store } = await openRag(t, [])
  const info = await rag.createNamespace({ name, space: SPACE, vectorEncoding: 'f16' })
  await rag.ingest({
    namespace: name,
    documents: Object.entries(VECTORS).map(([id, embedding]) => ({
      id,
      chunks: [{ content: `text ${id}`, embedding, spaceId: info.spaceId }]
    }))
  })
  return { rag, store: store as Corestore, spaceId: info.spaceId }
}

async function scores(
  rag: Rag,
  namespace: string,
  spaceId: string
): Promise<Array<[string, number]>> {
  const hits = await rag.search({ scope: { namespace }, vector: [1, 1, 1], spaceId, k: 5 })
  return hits.map((hit) => [hit.documentId, hit.score])
}

function expectedScores(): Array<[string, number]> {
  return Object.entries(VECTORS)
    .map(([id, values]): [string, number] => [id, dotScore(rounded(values), [1, 1, 1])])
    .sort((x, y) => y[1] - x[1])
}

test('toHalf rounds to nearest even and maps edge values', (t) => {
  const cases: Array<[number, number, string]> = [
    [0, 0x0000, 'zero'],
    [-0, 0x8000, 'negative zero'],
    [1, 0x3c00, 'one'],
    [-2, 0xc000, 'minus two'],
    [65504, 0x7bff, 'largest finite'],
    [65519, 0x7bff, 'below the overflow midpoint rounds down'],
    [65520, 0x7c00, 'the overflow midpoint rounds to Infinity'],
    [1e6, 0x7c00, 'overflow'],
    [-1e6, 0xfc00, 'negative overflow'],
    [Infinity, 0x7c00, 'Infinity'],
    [-Infinity, 0xfc00, '-Infinity'],
    [1 + 2 ** -11, 0x3c00, 'tie rounds to the even mantissa below'],
    [1 + 3 * 2 ** -11, 0x3c02, 'tie rounds to the even mantissa above'],
    [1 + 2 ** -11 + 2 ** -20, 0x3c01, 'just past a tie rounds up'],
    [2 ** -14, 0x0400, 'smallest normal'],
    [1023 * 2 ** -24, 0x03ff, 'largest subnormal'],
    [2 ** -14 - 2 ** -25, 0x0400, 'subnormal tie carries into the smallest normal'],
    [2 ** -24, 0x0001, 'smallest subnormal'],
    [2 ** -25, 0x0000, 'half the smallest subnormal ties to zero'],
    [1.5 * 2 ** -25, 0x0001, 'three quarters of the smallest subnormal rounds up'],
    [3 * 2 ** -25, 0x0002, 'subnormal tie rounds to even'],
    [-(2 ** -24), 0x8001, 'negative subnormal'],
    [2 ** -30, 0x0000, 'underflow'],
    [1e-45, 0x0000, 'float32 subnormal']
  ]
  for (const [value, bits, label] of cases) t.is(toHalf(value), bits, label)
  t.is(toHalf(NaN) & 0x7c00, 0x7c00, 'NaN keeps an all-ones exponent')
  t.ok(Number.isNaN(fromHalf(toHalf(NaN))), 'NaN round-trips as NaN')
  t.ok(Object.is(fromHalf(0x8000), -0), 'negative zero decodes')
  t.is(fromHalf(0x0001), 2 ** -24)
  t.is(fromHalf(0x7c00), Infinity)
})

test('every float16 value round-trips', (t) => {
  let mismatches = 0
  for (let bits = 0; bits < 0x10000; bits++) {
    const exponent = (bits >>> 10) & 0x1f
    if (exponent === 0x1f && bits & 0x3ff) continue
    if (toHalf(fromHalf(bits)) !== bits) mismatches++
  }
  t.is(mismatches, 0)
})

test('a namespace stores f32 vectors by default and f16 when asked', async (t) => {
  const { rag, store } = await openRag(t, [])
  const plain = await rag.createNamespace({ name: 'plain', space: SPACE })
  t.is(plain.vectorEncoding, 'f32')
  const half = await rag.createNamespace({ name: 'half', space: SPACE, vectorEncoding: 'f16' })
  t.is(half.vectorEncoding, 'f16')

  const again = await rag.createNamespace({ name: 'half', space: SPACE })
  t.is(again.vectorEncoding, 'f16', 'omitting it accepts the existing encoding')
  await rejectsWithCode(
    t,
    rag.createNamespace({ name: 'half', space: SPACE, vectorEncoding: 'f32' }),
    ERR_CODES.NAMESPACE_EXISTS,
    'the encoding is fixed at creation'
  )
  await rejectsWithCode(
    t,
    // @ts-expect-error not an encoding
    rag.createNamespace({ name: 'bad', space: SPACE, vectorEncoding: 'f64' }),
    ERR_CODES.INVALID_INPUT,
    'unknown encodings are rejected'
  )

  const summaries = await rag.listNamespaces()
  t.alike(
    summaries.map((ns) => [ns.name, ns.vectorEncoding]),
    [
      ['half', 'f16'],
      ['plain', 'f32']
    ]
  )

  for (const name of ['plain', 'half']) {
    await rag.ingest({
      namespace: name,
      documents: [
        { id: 'd', chunks: [{ content: 'x', embedding: [0.1, 0.2, 0.3], spaceId: plain.spaceId }] }
      ]
    })
  }
  await rag.close()
  const sizes = await inspect(store, async (reader) => {
    const out: Record<string, number> = {}
    for await (const chunk of reader.find<ChunkRecord>(CHUNKS, {})) {
      out[chunk.namespace] = chunk.vector.byteLength
    }
    return out
  })
  t.alike(sizes, { half: 6, plain: 12 }, '2 bytes per dimension for f16')
})

test('an f16 namespace rejects components above 65504', async (t) => {
  const { rag, store: _store, spaceId } = await openF16(t)
  await rejectsWithCode(
    t,
    rag.ingest({
      namespace: 'ns',
      documents: [{ id: 'big', chunks: [{ content: 'x', embedding: [70000, 0, 0], spaceId }] }]
    }),
    ERR_CODES.INVALID_INPUT,
    'overflow is rejected',
    /65504/
  )
})

test('f16 search scores the rounded vectors through the index, the scan and a rebuild', async (t) => {
  const { rag, store, spaceId } = await openF16(t)
  const expected = expectedScores()
  t.alike(await scores(rag, 'ns', spaceId), expected, 'native index')

  const read = await rag.readDocument({ namespace: 'ns', documentId: 'a' })
  t.is(read.chunks.length, 1)

  await rag.close()
  const reopened = createRag({ corestore: store })
  t.teardown(() => reopened.close())
  await reopened.ready()
  t.alike(await scores(reopened, 'ns', spaceId), expected, 'index rebuilt from the store')

  useScan(t)
  const scanned = createRag({ corestore: store })
  t.teardown(() => scanned.close())
  await scanned.ready()
  t.alike(await scores(scanned, 'ns', spaceId), expected, 'scan')
})

test('re-ingesting the same f16 input is unchanged', async (t) => {
  const { rag, spaceId } = await openF16(t)
  const result = await rag.ingest({
    namespace: 'ns',
    documents: [{ id: 'a', chunks: [{ content: 'text a', embedding: VECTORS.a, spaceId }] }]
  })
  t.is(result.documents[0].status, 'unchanged')
})

test('an f16 export keeps its encoding through import and re-import', async (t) => {
  const { rag: from, spaceId } = await openF16(t)
  const bytes = await collect(from.exportNamespace({ namespace: 'ns' }))
  t.alike(
    [header(bytes).format, header(bytes).vectorEncoding],
    [2, 'f16'],
    'the header names the encoding'
  )

  const { rag: to } = await openRag(t, [])
  const result = await to.importNamespace({ namespace: 'copy', source: source(bytes) })
  t.is(result.documents.length, 3)
  const [copy] = await to.listNamespaces()
  t.is(copy.vectorEncoding, 'f16', 'the created namespace is not widened')
  t.alike(await scores(to, 'copy', spaceId), expectedScores(), 'same scores')

  const again = await to.importNamespace({ namespace: 'copy', source: source(bytes) })
  t.alike(
    again.documents.map((entry) => entry.status),
    ['unchanged', 'unchanged', 'unchanged'],
    'content hashes match the stored vectors'
  )

  const back = await collect(to.exportNamespace({ namespace: 'copy' }))
  t.alike(afterHeader(back), afterHeader(bytes), 'exporting the copy gives the same frames')
})

test('import refuses an export in another encoding', async (t) => {
  const { rag: half, spaceId } = await openF16(t)
  const halfBytes = await collect(half.exportNamespace({ namespace: 'ns' }))

  const { rag: full } = await openRag(t)
  await full.ingest({
    namespace: 'ns',
    documents: [{ id: 'x', chunks: [{ content: 'x', embedding: [1, 0, 0], spaceId }] }]
  })
  const fullBytes = await collect(full.exportNamespace({ namespace: 'ns' }))
  t.alike(
    [header(fullBytes).format, 'vectorEncoding' in header(fullBytes)],
    [1, false],
    'an f32 export keeps format 1'
  )

  await rejectsWithCode(
    t,
    full.importNamespace({ namespace: 'ns', source: source(halfBytes) }),
    ERR_CODES.NAMESPACE_EXISTS,
    'f16 into f32',
    /'f16'/
  )
  await rejectsWithCode(
    t,
    half.importNamespace({ namespace: 'ns', source: source(fullBytes) }),
    ERR_CODES.NAMESPACE_EXISTS,
    'f32 into f16',
    /'f32'/
  )
})

async function copyDir(from: string, to: string): Promise<void> {
  fs.mkdirSync(to, { recursive: true })
  for (const entry of fs.readdirSync(from) as string[]) {
    const source = path.join(from, entry)
    const target = path.join(to, entry)
    if (fs.statSync(source).isDirectory()) await copyDir(source, target)
    else fs.writeFileSync(target, fs.readFileSync(source))
  }
}

test('a store written by 0.11.0 opens, searches and takes writes as f32', async (t) => {
  const dir = await tmp(t)
  await copyDir(path.join(FIXTURE, 'store'), dir)
  const store = new Corestore(dir)
  const rag = createRag({ corestore: store })
  t.teardown(async () => {
    await rag.close()
    await store.close()
  })
  await rag.ready()

  const [old] = await rag.listNamespaces()
  t.alike([old.name, old.vectorEncoding, old.documentCount], ['old', 'f32', 2])
  const hits = await rag.search({
    scope: { namespace: 'old' },
    vector: [0, 0, 1],
    spaceId: old.spaceId,
    k: 1
  })
  t.alike(
    hits.map((hit) => [hit.documentId, hit.score]),
    [['sea', Math.fround(0.333333343267)]],
    'old float32 vectors decode unchanged'
  )

  const result = await rag.ingest({
    namespace: 'old',
    documents: [
      { id: 'new', chunks: [{ content: 'new', embedding: [0, 1, 1], spaceId: old.spaceId }] }
    ]
  })
  t.is(result.documents[0].status, 'created')
  t.is((await rag.createNamespace({ name: 'old', space: SPACE })).vectorEncoding, 'f32')
})

test('an export written by 0.11.0 imports as f32', async (t) => {
  const bytes = new Uint8Array(fs.readFileSync(path.join(FIXTURE, 'old.qvragx')) as Uint8Array)
  t.is(header(bytes).format, 1)
  const { rag } = await openRag(t, [])
  const result = await rag.importNamespace({ namespace: 'imported', source: source(bytes) })
  t.is(result.documents.length, 2)
  const [ns] = await rag.listNamespaces()
  t.is(ns.vectorEncoding, 'f32')
  const roundTrip = await collect(rag.exportNamespace({ namespace: 'imported' }))
  t.is(header(roundTrip).format, 1, 'and exports in the old format again')
})
