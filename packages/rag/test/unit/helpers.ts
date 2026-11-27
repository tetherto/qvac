import tmp from 'test-tmp'
import Corestore from 'corestore'
import HyperDB from 'hyperdb'

import dbSpec from '../../src/db/hyperspec/hyperdb/index.js'
import { createRag } from '../../src/index.js'
import { QvacErrorRAG } from '../../src/errors.js'
import { loadNativeIndex } from '../../src/vector-index/native.js'
import type {
  Corestore as Store,
  HyperDBReader,
  HyperDBTransaction
} from '../../src/db/db-types.js'
import type {
  EmbeddedDocumentInput,
  EmbeddingSpace,
  EmbeddingsPort,
  IndexHandle,
  IndexOptions,
  IndexProvider,
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
  const rag = createRag({ corestore: store, index: { provider: testProvider, ...index } })
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

// The runtime's timers; the test tsconfig loads no types that declare them.
const timers = globalThis as unknown as {
  setTimeout: (callback: () => void, ms: number) => unknown
  clearTimeout: (timer: unknown) => void
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => timers.setTimeout(resolve, ms))
}

// A hang fails the test instead of stalling the run.
export async function settles<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: unknown
  const timeout = new Promise<never>((resolve, reject) => {
    timer = timers.setTimeout(() => reject(new Error(`${label} did not settle`)), 5000)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    timers.clearTimeout(timer)
  }
}

// The provider `openRag` and other test openers pass, for one test.
let testProvider: IndexProvider | undefined

export function useProvider(t: Test, provider: IndexProvider | undefined): void {
  testProvider = provider
  t.teardown(() => {
    testProvider = undefined
  })
}

export function currentProvider(): IndexProvider | undefined {
  return testProvider
}

// Every index build fails, so search scans.
export const SCAN_ONLY: IndexProvider = {
  create() {
    throw new Error('scan only')
  }
}

// Forces the scan path for one test.
export function useScan(t: Test): void {
  useProvider(t, SCAN_ONLY)
}

export interface NativeCalls {
  creates: number
  loads: number
  compacts: number
}

export interface RealProvider extends IndexProvider {
  create(dim: number, storage: Parameters<IndexProvider['create']>[1]): IndexHandle
  load(path: string): Promise<IndexHandle>
}

// The installed TurboVec module.
export async function realNativeIndex(): Promise<RealProvider> {
  const { module } = await loadNativeIndex()
  if (!module) throw new Error('@qvac/turbovec-ggml is not loadable; index tests need it')
  return module as RealProvider
}

// Counts how the index was opened: `create` is a rebuild, `load` a snapshot.
export async function countNativeCalls(t: Test): Promise<NativeCalls> {
  const real = await realNativeIndex()
  const calls: NativeCalls = { creates: 0, loads: 0, compacts: 0 }
  function counted(native: IndexHandle): IndexHandle {
    const compact = (native.compact as () => Promise<void>).bind(native)
    native.compact = () => {
      calls.compacts++
      return compact()
    }
    return native
  }
  useProvider(t, {
    create(dim, storage) {
      calls.creates++
      return counted(real.create(dim, storage))
    },
    async load(path) {
      calls.loads++
      return counted(await real.load(path))
    }
  })
  return calls
}
