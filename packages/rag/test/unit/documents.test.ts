import test from 'brittle'

import { ERR_CODES, createRag } from '../../src/index.js'
import { DOCUMENTS, type DocumentRecord } from '../../src/db/records.js'
import { doc, mutate, openRag, rejectsWithCode } from './helpers.js'
import type { DocumentPage, EmbeddedDocumentInput } from '../../src/types.js'

function chunked(id: string, spaceId: string, count: number): EmbeddedDocumentInput {
  return doc(
    id,
    spaceId,
    Array.from({ length: count }, (_, i): [string, number[]] => [`${id}${i}`, [1, i, 0]])
  )
}

function contents(page: DocumentPage): string[] {
  return page.chunks.map((chunk) => chunk.content)
}

test('readDocument pages through one generation in ordinal order', async (t) => {
  const { rag, spaceId } = await openRag(t)
  const manual = {
    ...chunked('manual', spaceId, 5),
    metadata: { title: 'Manual' }
  }
  manual.chunks[1] = { ...manual.chunks[1], metadataJson: '{"page":2}' }
  await rag.ingest({ namespace: 'ns', documents: [manual] })

  const first = await rag.readDocument({ namespace: 'ns', documentId: 'manual', limit: 2 })
  t.is(first.generation, 1)
  t.is(first.chunkCount, 5)
  t.alike(first.metadata, { title: 'Manual' })
  t.alike(first.chunks, [
    { chunkId: 'manual:0', ordinal: 0, content: 'manual0' },
    { chunkId: 'manual:1', ordinal: 1, content: 'manual1', metadataJson: '{"page":2}' }
  ])
  t.is(first.nextOrdinal, 2)

  const pages = [contents(first)]
  let next = first.nextOrdinal
  while (next !== null) {
    const page = await rag.readDocument({
      namespace: 'ns',
      documentId: 'manual',
      generation: first.generation,
      fromOrdinal: next,
      limit: 2
    })
    pages.push(contents(page))
    next = page.nextOrdinal
  }
  t.alike(pages, [['manual0', 'manual1'], ['manual2', 'manual3'], ['manual4']])

  const whole = await rag.readDocument({ namespace: 'ns', documentId: 'manual' })
  t.is(whole.chunks.length, 5, 'the default limit covers a short document')
  t.is(whole.nextOrdinal, null)

  const around = await rag.readDocument({
    namespace: 'ns',
    documentId: 'manual',
    fromOrdinal: 2,
    limit: 3
  })
  t.alike(contents(around), ['manual2', 'manual3', 'manual4'], 'read-around a hit')

  const past = await rag.readDocument({ namespace: 'ns', documentId: 'manual', fromOrdinal: 9 })
  t.alike(past.chunks, [], 'past the end')
  t.is(past.nextOrdinal, null)
})

test('readDocument fails with DOCUMENT_CHANGED once the generation moves on', async (t) => {
  const { rag, spaceId } = await openRag(t)
  await rag.ingest({ namespace: 'ns', documents: [chunked('a', spaceId, 4)] })
  const first = await rag.readDocument({ namespace: 'ns', documentId: 'a', limit: 2 })

  await rag.ingest({ namespace: 'ns', documents: [chunked('a', spaceId, 3)] })
  await rejectsWithCode(
    t,
    rag.readDocument({
      namespace: 'ns',
      documentId: 'a',
      generation: first.generation,
      fromOrdinal: 2
    }),
    ERR_CODES.DOCUMENT_CHANGED,
    're-ingested',
    /generation 2, not 1/
  )
  const current = await rag.readDocument({ namespace: 'ns', documentId: 'a' })
  t.is(current.generation, 2, 'without a generation, the current one is read')

  await rag.deleteDocuments({ namespace: 'ns', documentIds: ['a'] })
  await rejectsWithCode(
    t,
    rag.readDocument({ namespace: 'ns', documentId: 'a', generation: 2 }),
    ERR_CODES.DOCUMENT_CHANGED,
    'deleted',
    /was deleted/
  )
  await rejectsWithCode(
    t,
    rag.readDocument({ namespace: 'ns', documentId: 'a' }),
    ERR_CODES.DOCUMENT_OUT_OF_SCOPE,
    'deleted, no generation given'
  )
})

test('readDocument and listDocuments validate their input', async (t) => {
  const { rag } = await openRag(t)
  await rejectsWithCode(
    t,
    rag.readDocument({ namespace: 'missing', documentId: 'a' }),
    ERR_CODES.NAMESPACE_NOT_FOUND,
    'unknown namespace'
  )
  await rejectsWithCode(
    t,
    rag.listDocuments({ namespace: 'missing' }),
    ERR_CODES.NAMESPACE_NOT_FOUND,
    'unknown namespace on list'
  )
  const bad: Array<[string, Record<string, unknown>]> = [
    ['limit 0', { limit: 0 }],
    ['limit above 1,024', { limit: 1025 }],
    ['negative fromOrdinal', { fromOrdinal: -1 }],
    ['generation 0', { generation: 0 }],
    ['unknown key', { vectors: true }]
  ]
  for (const [name, extra] of bad) {
    await rejectsWithCode(
      t,
      rag.readDocument({ namespace: 'ns', documentId: 'a', ...extra }),
      ERR_CODES.INVALID_INPUT,
      name
    )
  }
  await rejectsWithCode(
    t,
    rag.listDocuments({ namespace: 'ns', limit: 2000 }),
    ERR_CODES.INVALID_INPUT,
    'list limit above 1,024'
  )
  await rejectsWithCode(
    t,
    rag.scoped({ namespace: 'ns' }).readDocument({
      namespace: 'other',
      documentId: 'a'
    } as never),
    ERR_CODES.INVALID_INPUT,
    'a handle takes no namespace'
  )
})

test('listDocuments pages in document ID order with the committing revision', async (t) => {
  const { rag, spaceId } = await openRag(t)
  const first = await rag.ingest({
    namespace: 'ns',
    documents: [chunked('c', spaceId, 1), { ...chunked('a', spaceId, 2), metadata: { n: 1 } }]
  })
  const second = await rag.ingest({ namespace: 'ns', documents: [chunked('b', spaceId, 3)] })
  await rag.ingest({ namespace: 'ns', documents: [chunked('c', spaceId, 2)] })
  const unchanged = await rag.ingest({ namespace: 'ns', documents: [chunked('b', spaceId, 3)] })
  t.is(unchanged.documents[0].status, 'unchanged')

  const page1 = await rag.listDocuments({ namespace: 'ns', limit: 2 })
  t.alike(page1.documents, [
    { documentId: 'a', generation: 1, chunkCount: 2, revision: first.revision, metadata: { n: 1 } },
    { documentId: 'b', generation: 1, chunkCount: 3, revision: second.revision }
  ])
  t.is(page1.next, 'b')

  const page2 = await rag.listDocuments({ namespace: 'ns', after: page1.next!, limit: 2 })
  t.alike(
    page2.documents.map((d) => [d.documentId, d.generation, d.revision]),
    [['c', 2, second.revision + 1]],
    're-ingest moves the revision; an unchanged re-ingest does not'
  )
  t.is(page2.next, null)

  const all = await rag.listDocuments({ namespace: 'ns' })
  const oldestFirst = all.documents
    .slice()
    .sort((x, y) => x.revision - y.revision)
    .map((d) => d.documentId)
  t.alike(oldestFirst, ['a', 'b', 'c'], 'revision gives ingest order')

  await rag.deleteDocuments({ namespace: 'ns', documentIds: ['b'] })
  const afterDelete = await rag.listDocuments({ namespace: 'ns' })
  t.alike(
    afterDelete.documents.map((d) => d.documentId),
    ['a', 'c']
  )
})

test('documents written without a revision list it as 0', async (t) => {
  const { rag, store, spaceId } = await openRag(t)
  await rag.ingest({ namespace: 'ns', documents: [chunked('old', spaceId, 1)] })
  await rag.close()

  await mutate(store, async (tx) => {
    const row = await tx.get<DocumentRecord>(DOCUMENTS, { namespace: 'ns', documentId: 'old' })
    const { revision, ...legacy } = row!
    t.ok(revision! > 0, 'new rows record their revision')
    await tx.insert(DOCUMENTS, legacy)
  })

  const reopened = createRag({ corestore: store })
  await reopened.ready()
  t.teardown(() => reopened.close())
  const { documents } = await reopened.listDocuments({ namespace: 'ns' })
  t.is(documents[0].revision, 0)
})

test('a scoped handle reads and lists only its granted documents', async (t) => {
  const { rag, spaceId } = await openRag(t, ['ns', 'other'])
  await rag.ingest({
    namespace: 'ns',
    documents: [chunked('a', spaceId, 2), chunked('b', spaceId, 1), chunked('secret', spaceId, 1)]
  })
  await rag.ingest({ namespace: 'other', documents: [chunked('x', spaceId, 1)] })

  const handle = rag.scoped({ namespace: 'ns', documentIds: ['b', 'a', 'gone'] })
  const page = await handle.readDocument({ documentId: 'a' })
  t.alike(contents(page), ['a0', 'a1'])
  t.is(page.namespace, 'ns')

  // An ungranted document and a missing one fail the same way.
  const errors: string[] = []
  for (const documentId of ['secret', 'gone', 'x']) {
    try {
      await handle.readDocument({ documentId })
      t.fail(`${documentId} should not be readable`)
    } catch (error) {
      const e = error as { code: number; message: string }
      t.is(e.code, ERR_CODES.DOCUMENT_OUT_OF_SCOPE, documentId)
      errors.push(e.message.replace(documentId, '<id>'))
    }
  }
  t.is(new Set(errors).size, 1, 'same message for ungranted and missing')

  const listed = await handle.listDocuments()
  t.alike(
    listed.documents.map((d) => d.documentId),
    ['a', 'b'],
    'existing granted documents, in ID order'
  )
  const paged = await handle.listDocuments({ limit: 1 })
  t.alike(
    paged.documents.map((d) => d.documentId),
    ['a']
  )
  t.is(paged.next, 'a')
  const rest = await handle.listDocuments({ after: 'a', limit: 1 })
  t.alike(
    rest.documents.map((d) => d.documentId),
    ['b']
  )
  t.is(rest.next, null)

  const wide = rag.scoped({ namespace: 'ns' })
  t.alike(
    (await wide.listDocuments()).documents.map((d) => d.documentId),
    ['a', 'b', 'secret'],
    'a namespace-wide handle lists the namespace, nothing from another'
  )
  t.is((await wide.readDocument({ documentId: 'secret' })).chunks.length, 1)
})
