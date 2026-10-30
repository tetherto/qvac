import tmp from 'test-tmp'
import Corestore from 'corestore'
import HyperDB from 'hyperdb'

import dbSpec from '../../src/db/hyperspec/hyperdb/index.js'
import { createRag } from '../../src/index.js'
import { QvacErrorRAG } from '../../src/errors.js'
import type { Corestore as Store, HyperDBReader } from '../../src/db/db-types.js'
import type { EmbeddedDocumentInput, EmbeddingSpace, Rag } from '../../src/types.js'

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

export interface Fixture {
  rag: Rag
  store: Store
  spaceId: string
}

export async function openRag(t: Test, namespaces: string[] = ['ns']): Promise<Fixture> {
  const store = new Corestore(await tmp(t))
  const rag = createRag({ corestore: store })
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

export async function rejectsWithCode(
  t: Test,
  promise: Promise<unknown> | (() => unknown),
  code: number,
  message: string
): Promise<void> {
  try {
    await (typeof promise === 'function' ? promise() : promise)
    t.fail(`${message}: expected error ${code}`)
  } catch (error) {
    t.ok(error instanceof QvacErrorRAG, `${message}: QvacErrorRAG`)
    t.is((error as QvacErrorRAG).code, code, message)
  }
}
