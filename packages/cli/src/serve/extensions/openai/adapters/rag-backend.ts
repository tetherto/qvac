import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import Corestore from 'corestore'
import { createRag, type EmbeddingSpace, type EmbeddingsPort, type Rag } from '@qvac/rag'
import { embed } from '@qvac/sdk'

export const DEFAULT_VECTOR_STORE_DIR = path.join(os.homedir(), '.qvac', 'serve', 'vector-stores')

export interface EmbeddingModelRef {
  alias: string
  sdkModelId: string
}

export interface VectorStoreFile {
  fileId: string
  fileName: string
}

export interface VectorStoreHit {
  fileId: string
  fileName: string
  content: string
  score: number
}

export type EmbedTexts = (sdkModelId: string, texts: string[]) => Promise<number[][]>

export interface RagBackend {
  /** Ids of the stores that hold ingested files. */
  list: () => Promise<string[]>
  /** Embedding alias the store was ingested with, or null when it holds no files. */
  embeddingAlias: (id: string) => Promise<string | null>
  attach: (
    id: string,
    model: EmbeddingModelRef,
    file: VectorStoreFile & { text: string }
  ) => Promise<{ chunkCount: number }>
  search: (
    id: string,
    model: EmbeddingModelRef,
    query: string,
    k: number
  ) => Promise<VectorStoreHit[]>
  /** Deletes the store's files. Returns false when it held none. */
  delete: (id: string) => Promise<boolean>
  close: () => Promise<void>
}

interface ManifestStore {
  namespace: string
  embeddingAlias: string
  files: Record<string, string>
}

interface Manifest {
  version: 1
  nextNamespace: number
  stores: Record<string, ManifestStore>
}

interface OpenRag {
  rag: Rag
  corestore: Corestore
  port: (EmbeddingsPort & { sdkModelId: string }) | null
}

async function embedTextsWithSdk(sdkModelId: string, texts: string[]): Promise<number[][]> {
  if (texts.length === 1) {
    const { embedding } = await embed({ modelId: sdkModelId, text: texts[0]! })
    return [embedding]
  }
  const { embedding } = await embed({ modelId: sdkModelId, text: texts })
  return embedding
}

function flatten(rows: number[][]): Float32Array {
  const dim = rows[0]?.length ?? 0
  const out = new Float32Array(rows.length * dim)
  rows.forEach((row, i) => out.set(row, i * dim))
  return out
}

function aliasDir(baseDir: string, alias: string): string {
  return path.join(baseDir, createHash('sha256').update(alias).digest('hex').slice(0, 16))
}

// Each embedding model gets its own Corestore and RAG, since a RAG instance
// binds one embedding space for its whole life.
export function createRagBackend(
  options: { dir?: string; embedTexts?: EmbedTexts } = {}
): RagBackend {
  const baseDir = options.dir ?? DEFAULT_VECTOR_STORE_DIR
  const embedTexts = options.embedTexts ?? embedTextsWithSdk
  const manifestPath = path.join(baseDir, 'stores.json')
  const open = new Map<string, OpenRag>()
  let manifest: Manifest | null = null
  let queue: Promise<unknown> = Promise.resolve()

  // One operation at a time: the manifest and the RAG instances it opens are
  // shared, and reopening an instance with a port must not race a search.
  function serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task)
    queue = run.catch(() => {})
    return run
  }

  async function loadManifest(): Promise<Manifest> {
    if (manifest) return manifest
    try {
      const parsed = JSON.parse(await readFile(manifestPath, 'utf8')) as Manifest
      manifest = parsed.version === 1 ? parsed : { version: 1, nextNamespace: 0, stores: {} }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      manifest = { version: 1, nextNamespace: 0, stores: {} }
    }
    return manifest
  }

  async function saveManifest(): Promise<void> {
    await mkdir(baseDir, { recursive: true })
    const tmp = `${manifestPath}.tmp`
    await writeFile(tmp, JSON.stringify(manifest, null, 2))
    await rename(tmp, manifestPath)
  }

  async function closeOpen(alias: string): Promise<void> {
    const current = open.get(alias)
    if (!current) return
    open.delete(alias)
    await current.rag.close()
    await current.corestore.close()
  }

  async function openRag(alias: string, model: EmbeddingModelRef | null): Promise<OpenRag> {
    const current = open.get(alias)
    if (current && (model === null || current.port)) {
      if (model && current.port) current.port.sdkModelId = model.sdkModelId
      return current
    }
    await closeOpen(alias)

    let port: OpenRag['port'] = null
    if (model) {
      const probe = await embedTexts(model.sdkModelId, ['dimension probe'])
      const space: EmbeddingSpace = {
        model: alias,
        revision: '',
        dimensions: probe[0]?.length ?? 0,
        metric: 'cosine',
        normalized: false,
        documentEncoding: '',
        queryEncoding: '',
        preprocessing: 'none'
      }
      const ref = { sdkModelId: model.sdkModelId }
      port = {
        space,
        get sdkModelId() {
          return ref.sdkModelId
        },
        set sdkModelId(value: string) {
          ref.sdkModelId = value
        },
        async embedDocuments(texts) {
          return flatten(await embedTexts(ref.sdkModelId, texts))
        },
        async embedQuery(text) {
          return flatten(await embedTexts(ref.sdkModelId, [text]))
        }
      }
    }

    const dir = aliasDir(baseDir, alias)
    await mkdir(dir, { recursive: true })
    const corestore = new Corestore(path.join(dir, 'corestore'))
    const rag = createRag({
      corestore,
      ...(port && { embeddings: port }),
      index: { dir: path.join(dir, 'index') }
    })
    try {
      await rag.ready()
    } catch (err) {
      await corestore.close()
      throw err
    }
    const opened = { rag, corestore, port }
    open.set(alias, opened)
    return opened
  }

  return {
    list: () =>
      serialize(async () => {
        const m = await loadManifest()
        return Object.keys(m.stores)
      }),

    embeddingAlias: (id) =>
      serialize(async () => {
        const m = await loadManifest()
        return m.stores[id]?.embeddingAlias ?? null
      }),

    attach: (id, model, file) =>
      serialize(async () => {
        const m = await loadManifest()
        let store = m.stores[id]
        if (!store) {
          store = { namespace: `${id}-${m.nextNamespace}`, embeddingAlias: model.alias, files: {} }
        }
        const { rag, port } = await openRag(store.embeddingAlias, model)
        await rag.createNamespace({ name: store.namespace, space: port!.space })
        const result = await rag.ingest({
          namespace: store.namespace,
          documents: [{ id: file.fileId, text: file.text, metadata: { filename: file.fileName } }]
        })
        if (!m.stores[id]) {
          m.nextNamespace++
          m.stores[id] = store
        }
        store.files[file.fileId] = file.fileName
        await saveManifest()
        return { chunkCount: result.documents[0]?.chunkCount ?? 0 }
      }),

    search: (id, model, query, k) =>
      serialize(async () => {
        const m = await loadManifest()
        const store = m.stores[id]
        if (!store) return []
        const { rag } = await openRag(store.embeddingAlias, model)
        const hits = await rag.search({ scope: { namespace: store.namespace }, query, k })
        return hits.map((hit) => {
          const filename = hit.documentMetadata?.['filename']
          return {
            fileId: hit.documentId,
            fileName:
              typeof filename === 'string'
                ? filename
                : (store.files[hit.documentId] ?? hit.documentId),
            content: hit.content,
            score: hit.score
          }
        })
      }),

    delete: (id) =>
      serialize(async () => {
        const m = await loadManifest()
        const store = m.stores[id]
        if (!store) return false
        const { rag } = await openRag(store.embeddingAlias, null)
        await rag.deleteDocuments({
          namespace: store.namespace,
          documentIds: Object.keys(store.files)
        })
        // The namespace itself stays; a store recreated under this id gets a new one.
        delete m.stores[id]
        await saveManifest()
        return true
      }),

    close: () =>
      serialize(async () => {
        for (const alias of [...open.keys()]) await closeOpen(alias)
      })
  }
}
