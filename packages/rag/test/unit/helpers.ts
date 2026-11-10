import tmp from 'test-tmp'
import Corestore from 'corestore'
import HyperDB from 'hyperdb'

import dbSpec from '../../src/db/hyperspec/hyperdb/index.js'
import { createRag } from '../../src/index.js'
import { QvacErrorRAG } from '../../src/errors.js'
import {
  loadNativeIndex,
  setNativeIndexLoader,
  type NativeIndexModule
} from '../../src/vector-index/native.js'
import type {
  Corestore as Store,
  HyperDBReader,
  HyperDBTransaction
} from '../../src/db/db-types.js'
import type {
  EmbeddedDocumentInput,
  EmbeddingSpace,
  EmbeddingsPort,
  IndexOptions,
  Rag
} from '../../src/types.js'

// brittle's types don't export the test instance; the last overload returns it.
export type Test = ReturnType<typeof import('brittle')>

export const SPACE: EmbeddingSpace = {
  model: 'test-embedder',
  revision: '1',
  dimensions: 3,
  metric: 'dot',
  normalized: true,
  documentEncoding: '',
  queryEncoding: '',
  preprocessing: 'none'
}

const WORDS = ['cat', 'dog', 'fish']

// One dimension per keyword, so a query ranks the chunks that mention it.
function embed(text: string): number[] {
  const lower = text.toLowerCase()
  return WORDS.map((word) => (lower.includes(word) ? 1 : 0))
}

export interface FakePort extends EmbeddingsPort {
  batches: string[][]
  queries: string[]
}

export function fakePort(
  space: EmbeddingSpace = SPACE,
  onBatch?: (batch: number, signal?: AbortSignal) => void
): FakePort {
  const port: FakePort = {
    space,
    batches: [],
    queries: [],
    embedDocuments(texts, options) {
      port.batches.push(texts)
      try {
        onBatch?.(port.batches.length, options?.signal)
      } catch (error) {
        return Promise.reject(error)
      }
      return Promise.resolve(Float32Array.from(texts.flatMap(embed)))
    },
    embedQuery(text) {
      port.queries.push(text)
      return Promise.resolve(Float32Array.from(embed(text)))
    }
  }
  return port
}

export interface Fixture {
  rag: Rag
  store: Store
  spaceId: string
}

export async function openRag(
  t: Test,
  namespaces: string[] = ['ns'],
  index?: IndexOptions
): Promise<Fixture> {
  const store = new Corestore(await tmp(t))
  const rag = createRag({ corestore: store, index })
  await rag.ready()
  let spaceId = ''
  for (const name of namespaces) {
    spaceId = (await rag.createNamespace({ name, space: SPACE })).spaceId
  }
  t.teardown(async () => {
    await rag.close()
    await store.close()
  })
  return { rag, store, spaceId }
}

// One chunk per text, with the given vectors.
export function doc(
  id: string,
  spaceId: string,
  chunks: Array<[string, number[]]>
): EmbeddedDocumentInput {
  return {
    id,
    chunks: chunks.map(([content, embedding]) => ({ content, embedding, spaceId }))
  }
}

// Reads the raw HyperDB rows after the RAG has been closed.
export async function inspect<T>(
  store: Store,
  read: (reader: HyperDBReader) => Promise<T>
): Promise<T> {
  const db = HyperDB.bee(store.get({ name: 'qvac-rag' }), dbSpec, { autoUpdate: true })
  await db.ready()
  const snapshot = db.snapshot()
  try {
    return await read(snapshot)
  } finally {
    await snapshot.close()
    await db.close()
  }
}

// Writes raw HyperDB rows while no RAG is open on the store.
export async function mutate(
  store: Store,
  write: (tx: HyperDBTransaction) => Promise<void>
): Promise<void> {
  const db = HyperDB.bee(store.get({ name: 'qvac-rag' }), dbSpec, { autoUpdate: true })
  await db.ready()
  const tx = await db.exclusiveTransaction()
  try {
    await write(tx)
    await tx.flush()
  } finally {
    await tx.close()
    await db.close()
  }
}

export async function rejectsWithCode(
  t: Test,
  promise: Promise<unknown> | (() => unknown),
  code: number,
  message: string,
  pattern?: RegExp
): Promise<void> {
  try {
    await (typeof promise === 'function' ? promise() : promise)
    t.fail(`${message}: expected error ${code}`)
  } catch (error) {
    t.ok(error instanceof QvacErrorRAG, `${message}: QvacErrorRAG`)
    t.is((error as QvacErrorRAG).code, code, message)
    if (pattern) t.ok(pattern.test((error as Error).message), `${message}: ${pattern}`)
  }
}

// Forces the scan path for one test, as if the addon were not installed.
export function useScan(t: Test): void {
  setNativeIndexLoader(() => Promise.resolve(null))
  t.teardown(() => setNativeIndexLoader(null))
}

export interface NativeCalls {
  creates: number
  loads: number
}

// Counts how the index was opened: `create` is a rebuild, `load` a snapshot.
export async function countNativeCalls(t: Test): Promise<NativeCalls> {
  setNativeIndexLoader(null)
  const real = (await loadNativeIndex()) as NativeIndexModule
  if (!real) throw new Error('@qvac/turbovec-ggml is not loadable; index tests need it')
  const calls: NativeCalls = { creates: 0, loads: 0 }
  setNativeIndexLoader(() =>
    Promise.resolve({
      create(dim, storage) {
        calls.creates++
        return real.create(dim, storage)
      },
      load(path) {
        calls.loads++
        return real.load(path)
      }
    })
  )
  t.teardown(() => setNativeIndexLoader(null))
  return calls
}
