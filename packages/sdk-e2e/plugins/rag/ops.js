import { createRag } from '@qvac/rag'
import Corestore from 'corestore'

// The space of the suite's `embeddings` resource (GTE large, fp16).
export const SPACE = {
  model: 'gte-large-fp16',
  revision: '1',
  dimensions: 1024,
  metric: 'cosine',
  normalized: false,
  documentEncoding: '',
  queryEncoding: '',
  preprocessing: 'none'
}

/**
 * The @qvac/rag calls the e2e suite makes, shared by the worker plugin (Bare) and the
 * desktop consumer (Node). Every op takes plain JSON and returns a plain object, so the
 * same catalog steps drive both.
 *
 * `host` supplies what differs between the runtimes:
 * - `root`: a writable directory for stores
 * - `join(...parts)`, `removeDir(path)`, `listDir(path)`
 * - `embed(modelId, text)`: one vector as a number array
 */
export function createRagOps(host) {
  const stores = new Map()
  // One directory per instance, so overlapping runs never delete each other's stores.
  const base = host.join(
    host.root,
    `qvac-rag-e2e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  )
  // Bare has no AbortController or TextEncoder globals; the plugin passes them in.
  const AbortControllerImpl = host.AbortController ?? globalThis.AbortController
  const encode = host.encode ?? ((text) => new TextEncoder().encode(text))

  function storeOf(name) {
    const open = stores.get(name)
    if (!open) throw new Error(`store "${name}" is not open`)
    return open
  }

  function port(embedModelId) {
    return {
      space: SPACE,
      async embedDocuments(texts) {
        const out = []
        for (const text of texts) out.push(...(await host.embed(embedModelId, text)))
        return Float32Array.from(out)
      },
      async embedQuery(text) {
        return Float32Array.from(await host.embed(embedModelId, text))
      }
    }
  }

  async function closeStore(name) {
    const open = stores.get(name)
    if (!open) return false
    stores.delete(name)
    await open.rag.close()
    await open.corestore.close()
    return true
  }

  async function spaceIdOf(rag, namespace) {
    const info = (await rag.listNamespaces()).find((n) => n.name === namespace)
    if (!info) throw new Error(`namespace "${namespace}" not found`)
    return info.spaceId
  }

  // A store's data and its index snapshots live in sibling directories.
  function dirs(name) {
    const data = host.join(base, name)
    return { data, index: data + '-index' }
  }

  // Abort once `count` documents have committed.
  function abortAfterCommits(count) {
    const controller = new AbortControllerImpl()
    return {
      signal: controller.signal,
      onProgress(progress) {
        if (progress.stage === 'commit' && progress.done >= count) controller.abort()
      }
    }
  }

  const ops = {
    async open({ store, embedModelId, fresh = false }) {
      if (stores.has(store)) throw new Error(`store "${store}" is already open`)
      const { data, index } = dirs(store)
      if (fresh) {
        await host.removeDir(data)
        await host.removeDir(index)
      }
      const corestore = new Corestore(data)
      const rag = createRag({ corestore, embeddings: port(embedModelId), index: { dir: index } })
      await rag.ready()
      stores.set(store, { rag, corestore })
      return { store }
    },

    async close({ store }) {
      return { closed: await closeStore(store) }
    },

    // Closes and deletes every store; the teardown of each test.
    async reset() {
      const names = [...stores.keys()]
      for (const name of names) await closeStore(name)
      await host.removeDir(base)
      return { closed: names.length }
    },

    // Closes the RAG but keeps it registered, then searches it: what a caller holding a
    // closed instance gets.
    async searchAfterClose({ store, ...params }) {
      const { rag } = storeOf(store)
      await rag.close()
      return { hits: await rag.search(params) }
    },

    // Snapshots live under `<index>/<core key>/`: a `.json` sidecar per namespace and the
    // `.tvec` file it names.
    async snapshotFiles({ store }) {
      const { index } = dirs(store)
      const files = []
      for (const core of await host.listDir(index)) {
        files.push(...(await host.listDir(host.join(index, core))))
      }
      return {
        sidecars: files.filter((f) => f.endsWith('.json')).length,
        snapshots: files.filter((f) => f.endsWith('.tvec')).length
      }
    },

    async createNamespace({ store, name, dimensions, storage, vectorEncoding }) {
      const space = dimensions ? { ...SPACE, dimensions } : SPACE
      const info = await storeOf(store).rag.createNamespace({
        name,
        space,
        ...(storage && { index: { storage } }),
        ...(vectorEncoding && { vectorEncoding })
      })
      return info
    },

    // `embedWith` embeds each chunk here first, so the documents go in pre-embedded.
    // `inSpace` stamps pre-embedded documents with the namespace's space.
    async ingest({ store, namespace, documents, abortAfterDocuments, embedWith, inSpace }) {
      const { rag } = storeOf(store)
      const options = abortAfterDocuments ? abortAfterCommits(abortAfterDocuments) : {}
      if (embedWith) {
        const spaceId = await spaceIdOf(rag, namespace)
        // One at a time: the engine runs one embeddings request per model.
        const embedded = []
        for (const doc of documents) {
          const chunks = []
          for (const chunk of doc.chunks) {
            chunks.push({ ...chunk, embedding: await host.embed(embedWith, chunk.content) })
          }
          embedded.push({ ...doc, spaceId, chunks })
        }
        documents = embedded
      } else if (inSpace) {
        const spaceId = await spaceIdOf(rag, namespace)
        documents = documents.map((doc) => ({ ...doc, spaceId }))
      }
      return await rag.ingest({ namespace, documents }, options)
    },

    async deleteDocuments({ store, namespace, documentIds }) {
      return await storeOf(store).rag.deleteDocuments({ namespace, documentIds })
    },

    // `vectorOf` embeds that text first and searches by vector instead of by query.
    async search({ store, vectorOf, embedModelId, ...params }) {
      const { rag } = storeOf(store)
      if (vectorOf) {
        const spaceId = await spaceIdOf(rag, params.scope.namespace)
        const vector = await host.embed(embedModelId, vectorOf)
        return { hits: await rag.search({ ...params, vector, spaceId }) }
      }
      return { hits: await rag.search(params) }
    },

    async scopedSearch({ store, scope, ...params }) {
      return { hits: await storeOf(store).rag.scoped(scope).search(params) }
    },

    async readDocument({ store, ...params }) {
      return await storeOf(store).rag.readDocument(params)
    },

    async listDocuments({ store, ...params }) {
      return await storeOf(store).rag.listDocuments(params)
    },

    async listNamespaces({ store }) {
      return { namespaces: await storeOf(store).rag.listNamespaces() }
    },

    async dropNamespace({ store, name }) {
      return await storeOf(store).rag.dropNamespace({ name })
    },

    // Exports a namespace from one open store and imports it into another, optionally
    // aborting the import after `abortAfterChunks` chunks of the stream.
    async transfer({ from, to, namespace, documentIds, targetNamespace, abortAfterChunks }) {
      const source = storeOf(from).rag.exportNamespace({
        namespace,
        ...(documentIds && { documentIds })
      })
      const controller = new AbortControllerImpl()
      async function* counted() {
        let chunks = 0
        for await (const chunk of source) {
          if (abortAfterChunks !== undefined && chunks >= abortAfterChunks) controller.abort()
          chunks++
          yield chunk
        }
      }
      return await storeOf(to).rag.importNamespace(
        { namespace: targetNamespace ?? namespace, source: counted() },
        { signal: controller.signal }
      )
    },

    // An export as hex, so it can travel through a step to the other runtime.
    async exportHex({ store, namespace }) {
      let hex = ''
      for await (const chunk of storeOf(store).rag.exportNamespace({ namespace })) {
        for (const byte of chunk) hex += byte.toString(16).padStart(2, '0')
      }
      return { hex, bytes: hex.length / 2 }
    },

    async importHex({ store, namespace, hex }) {
      const bytes = new Uint8Array(hex.length / 2)
      for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
      async function* source() {
        yield bytes
      }
      return await storeOf(store).rag.importNamespace({ namespace, source: source() })
    },

    // Searches and compares the hits with `against`, hits from another search: whether the
    // same chunks come back in the same order, and the largest score difference between them.
    async searchDelta({ store, against, ...params }) {
      const hits = await storeOf(store).rag.search(params)
      const key = (hit) => `${hit.documentId}:${hit.ordinal}`
      const sameOrder =
        hits.length === against.length && hits.every((hit, i) => key(hit) === key(against[i]))
      let maxScoreDelta = 0
      for (let i = 0; i < Math.min(hits.length, against.length); i++) {
        maxScoreDelta = Math.max(maxScoreDelta, Math.abs(hits[i].score - against[i].score))
      }
      return { sameOrder, maxScoreDelta, hits: hits.length }
    },

    async importBytes({ store, namespace, text }) {
      async function* source() {
        yield encode(text)
      }
      return await storeOf(store).rag.importNamespace({ namespace, source: source() })
    }
  }

  /**
   * Runs one op. With `capture`, a rejection comes back as `{ error: { code, name, message } }`
   * instead of crossing the transport, so its numeric code survives on every client.
   */
  return async function run(op, params = {}) {
    const fn = ops[op]
    if (!fn) throw new Error(`unknown rag op "${op}"`)
    const { capture, ...rest } = params
    if (!capture) return await fn(rest)
    try {
      return { error: null, value: await fn(rest) }
    } catch (err) {
      return {
        error: {
          code: err?.code === undefined ? '' : String(err.code),
          name: err?.name ?? '',
          message: err?.message ?? String(err)
        }
      }
    }
  }
}

export const RAG_OPS = [
  'open',
  'close',
  'reset',
  'snapshotFiles',
  'searchAfterClose',
  'createNamespace',
  'ingest',
  'deleteDocuments',
  'search',
  'scopedSearch',
  'readDocument',
  'listDocuments',
  'listNamespaces',
  'dropNamespace',
  'transfer',
  'exportHex',
  'importHex',
  'searchDelta',
  'importBytes'
]
