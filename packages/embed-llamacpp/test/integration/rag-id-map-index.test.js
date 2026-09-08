'use strict'

const fs = require('bare-fs')
const os = require('bare-os')
const path = require('bare-path')

const IdMapIndex = require('../../idMapIndex')
const {
  cleanupResources,
  createEmbeddingsTestInstance,
  safeTest,
  waitForCompletion
} = require('./utils')

const TEST_TIMEOUT = 10 * 60 * 1000
const MODEL_NAME = 'embeddinggemma-300M-Q8_0.gguf'
const isMobile = os.platform() === 'ios' || os.platform() === 'android'
const supportsTurboVec = os.arch() === 's390x' || os.arch().includes('64')

let tmpCounter = 0

function tmpPath(name, extension) {
  tmpCounter += 1
  const pid = os.pid ? os.pid() : 0
  return path.join(os.tmpdir(), `${name}-${pid}-${Date.now()}-${tmpCounter}.${extension}`)
}

function removeFile(file) {
  if (fs.existsSync(file)) fs.unlinkSync(file)
}

function removeDeltaArtifacts(delta) {
  removeFile(delta)
  removeFile(`${delta}.lock`)
}

function expectThrows(t, fn, message) {
  try {
    fn()
    t.fail(message)
  } catch (error) {
    t.pass(`${message}: ${error.message || error.code}`)
  }
}

function normalizeEmbedding(embedding) {
  const normalized = new Float32Array(embedding.length)
  let norm = 0
  for (let i = 0; i < embedding.length; i++) {
    norm += embedding[i] * embedding[i]
  }
  norm = Math.sqrt(norm) || 1
  for (let i = 0; i < embedding.length; i++) {
    normalized[i] = embedding[i] / norm
  }
  return normalized
}

function flattenEmbeddings(embeddings) {
  const dim = embeddings[0].length
  const flattened = new Float32Array(embeddings.length * dim)
  for (let i = 0; i < embeddings.length; i++) {
    flattened.set(normalizeEmbedding(embeddings[i]), i * dim)
  }
  return flattened
}

safeTest(
  'desktop RAG workflow exercises all IdMapIndex operations',
  {
    timeout: TEST_TIMEOUT,
    skip: isMobile || !supportsTurboVec
  },
  async (t) => {
    const chunks = [
      { id: 11n, text: 'Saturn moon Titan has lakes, clouds, and rain made of liquid methane.' },
      { id: 22n, text: 'Solar panels convert sunlight into electricity using photovoltaic cells.' },
      { id: 33n, text: 'Honeybees communicate the location of flowers through a waggle dance.' },
      { id: 44n, text: 'The Pacific Ocean is the largest and deepest ocean on Earth.' }
    ]
    const chunkById = new Map(chunks.map((chunk) => [chunk.id, chunk]))
    const queryText = 'Which moon has methane rain and lakes?'
    const snapshot = tmpPath('rag-id-map-index-turbovec', 'tvim')
    const genericSnapshot = tmpPath('rag-id-map-index-generic', 'tvim')
    const delta = tmpPath('rag-id-map-index-generic', 'tvid')

    let inference = null
    let index = null
    let loaded = null
    let filter = null
    let generic = null
    let mmap = null
    let replayed = null

    try {
      ;({ inference } = await createEmbeddingsTestInstance(t, MODEL_NAME, 'cpu', '0', '1024'))

      const response = await inference.run([...chunks.map((chunk) => chunk.text), queryText])
      const output = await waitForCompletion(response)
      const embeddings = output[0]
      t.is(embeddings.length, chunks.length + 1, 'embeds every chunk and the retrieval query')

      const documentEmbeddings = flattenEmbeddings(embeddings.slice(0, chunks.length))
      const query = normalizeEmbedding(embeddings[chunks.length])
      const ids = new BigUint64Array(chunks.map((chunk) => chunk.id))
      const dim = query.length

      // RAG retrieval through TurboVec.
      index = new IdMapIndex({ dim, storage: 'turbovec-q4' })
      t.is(index.dim, dim, 'dimension getter matches the embedding model')
      t.is(index.bitWidth, 4, 'TurboVec q4 reports its effective bit width')
      t.is(index.length, 0, 'new vector database starts empty')

      index.addWithIds(documentEmbeddings, ids)
      t.is(index.length, chunks.length, 'all document chunks are indexed')
      t.ok(index.contains(11n), 'contains finds an indexed chunk')
      t.absent(index.contains(999n), 'contains rejects an unknown chunk')
      index.prepare()

      const nearest = index.search(query, 2)
      const nearestIds = Array.from(nearest.ids)
      t.ok(nearestIds.includes(11n), 'semantic retrieval finds the Titan chunk')
      const context = nearestIds
        .filter((id) => chunkById.has(id))
        .map((id) => chunkById.get(id).text)
        .join('\n')
      t.ok(context.includes('liquid methane'), 'retrieved IDs assemble the expected RAG context')

      const multiQuery = new Float32Array(dim * 2)
      multiQuery.set(query)
      multiQuery.set(documentEmbeddings.subarray(dim, dim * 2), dim)
      const multiResult = index.search(multiQuery, 1)
      t.is(multiResult.m, 2, 'multi-query search returns one row per query')
      t.is(multiResult.k, 1, 'multi-query search respects top-k')

      const allowedIds = new BigUint64Array([11n, 33n])
      const filtered = index.searchFiltered(query, 2, allowedIds)
      t.ok(
        filtered.ids[0] === 11n || filtered.ids[0] === 33n,
        'one-shot filtered search only returns allowed chunks'
      )
      filter = index.prepareFilter(allowedIds)
      const preparedFiltered = filter.search(query, 2)
      t.ok(
        preparedFiltered.ids[0] === 11n || preparedFiltered.ids[0] === 33n,
        'prepared-filter search only returns allowed chunks'
      )
      filter.dispose()
      filter.dispose()
      filter = null

      index.buildIvf(2, 1)
      const approximate = index.searchIvf(query, 2, 2)
      t.ok(Array.from(approximate.ids).includes(11n), 'IVF retrieval finds the relevant chunk')

      t.is(index.remove(44n), true, 'remove deletes an indexed chunk')
      t.is(index.remove(44n), false, 'remove reports a missing chunk')
      index.compact()
      t.is(index.length, chunks.length - 1, 'compact preserves live chunk count')

      index.write(snapshot)
      loaded = IdMapIndex.load(snapshot)
      t.is(loaded.length, chunks.length - 1, 'snapshot load restores live chunks')
      t.ok(
        Array.from(loaded.search(query, 2).ids).includes(11n),
        'loaded snapshot remains searchable'
      )

      expectThrows(t, () => IdMapIndex.loadMmap(snapshot), 'TurboVec rejects mmap loading')
      expectThrows(
        t,
        () => IdMapIndex.loadWithDelta(snapshot, delta),
        'TurboVec rejects delta-log loading'
      )
      expectThrows(
        t,
        () => index.addLogged(query, new BigUint64Array([55n]), delta),
        'TurboVec rejects logged additions'
      )
      expectThrows(t, () => index.removeLogged(11n, delta), 'TurboVec rejects logged removals')
      expectThrows(
        t,
        () => index.compactDelta(snapshot, delta),
        'TurboVec rejects delta compaction'
      )

      loaded.dispose()
      loaded.dispose()
      loaded = null
      index.dispose()
      index.dispose()
      index = null

      // Generic q4 supports the persistence operations that TurboVec intentionally rejects.
      generic = new IdMapIndex({ dim, storage: 'q4' })
      generic.addWithIds(documentEmbeddings, ids)
      generic.write(genericSnapshot)

      mmap = IdMapIndex.loadMmap(genericSnapshot)
      t.ok(Array.from(mmap.search(query, 2).ids).includes(11n), 'mmap index supports RAG retrieval')
      mmap.dispose()
      mmap = null

      const extraId = 55n
      generic.addLogged(query, new BigUint64Array([extraId]), delta)
      t.ok(generic.contains(extraId), 'logged addition updates the vector database')
      t.is(generic.removeLogged(44n, delta), true, 'logged removal updates the vector database')
      generic.compactDelta(genericSnapshot, delta)
      generic.dispose()
      generic = null

      replayed = IdMapIndex.loadWithDelta(genericSnapshot, delta)
      t.ok(replayed.contains(extraId), 'delta-compacted snapshot preserves logged additions')
      t.absent(replayed.contains(44n), 'delta-compacted snapshot preserves logged removals')
      t.ok(
        Array.from(replayed.search(query, 2).ids).includes(extraId),
        'replayed index remains searchable'
      )
    } finally {
      if (filter !== null) filter.dispose()
      if (replayed !== null) replayed.dispose()
      if (mmap !== null) mmap.dispose()
      if (generic !== null) generic.dispose()
      if (loaded !== null) loaded.dispose()
      if (index !== null) index.dispose()
      if (inference !== null) await cleanupResources(inference)
      removeFile(snapshot)
      removeFile(genericSnapshot)
      removeDeltaArtifacts(delta)
    }
  }
)
