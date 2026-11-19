import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import Corestore from 'corestore'
import { createRag, type EmbeddingSpace, type EmbeddingsPort, type Rag } from '@qvac/rag'
import { embed } from '@qvac/sdk'

export const DEFAULT_VECTOR_STORE_DIR = path.join(os.homedir(), '.qvac', 'serve', 'vector-stores')

export interface EmbeddingModelRef {
  alias: string
  sdkModelId: string
  /** Stable identity of the weights behind the alias: their source and checksum. */
  model: string
  revision: string
}

/** The store was ingested with other weights than the alias now points at. */
export class EmbeddingModelChangedError extends Error {
  constructor(
    readonly storeId: string,
    readonly recorded: string,
    readonly requested: string
  ) {
    super(
      `Vector store "${storeId}" was ingested with embedding model "${recorded}", ` +
        `but the alias now resolves to "${requested}".`
    )
    this.name = 'EmbeddingModelChangedError'
  }
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

interface StoreRecord {
  namespace: string
  embeddingAlias: string
  embeddingModel: { model: string; revision: string }
  files: Record<string, string>
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

function modelKey(model: StoreRecord['embeddingModel']): string {
  return createHash('sha256').update(`${model.model}\0${model.revision}`).digest('hex').slice(0, 16)
}

function describeModel(model: StoreRecord['embeddingModel']): string {
  return model.revision ? `${model.model}@${model.revision}` : model.model
}

// Each embedding model gets its own Corestore and RAG, since a RAG instance
// binds one embedding space for its whole life. Each store has its own record
// file, so servers sharing the directory never rewrite each other's stores.
export function createRagBackend(
  options: { dir?: string; embedTexts?: EmbedTexts } = {}
): RagBackend {
  const baseDir = options.dir ?? DEFAULT_VECTOR_STORE_DIR
  const embedTexts = options.embedTexts ?? embedTextsWithSdk
  const storesDir = path.join(baseDir, 'stores')
  const open = new Map<string, OpenRag>()
  let queue: Promise<unknown> = Promise.resolve()

  // One operation at a time: the RAG instances are shared, and reopening an
  // instance with a port must not race a search.
  function serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task)
    queue = run.catch(() => {})
    return run
  }

  function recordPath(id: string): string {
    return path.join(storesDir, `${id}.json`)
  }

  async function readStore(id: string): Promise<StoreRecord | null> {
    try {
      return JSON.parse(await readFile(recordPath(id), 'utf8')) as StoreRecord
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
  }

  async function writeStore(id: string, record: StoreRecord): Promise<void> {
    await mkdir(storesDir, { recursive: true })
    const tmp = `${recordPath(id)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
    await writeFile(tmp, JSON.stringify(record, null, 2))
    await rename(tmp, recordPath(id))
  }

  function assertModel(id: string, record: StoreRecord, model: EmbeddingModelRef): void {
    const requested = { model: model.model, revision: model.revision }
    if (modelKey(record.embeddingModel) === modelKey(requested)) return
    throw new EmbeddingModelChangedError(
      id,
      describeModel(record.embeddingModel),
      describeModel(requested)
    )
  }

  async function closeOpen(key: string): Promise<void> {
    const current = open.get(key)
    if (!current) return
    open.delete(key)
    await current.rag.close()
    await current.corestore.close()
  }

  async function openRag(
    embeddingModel: StoreRecord['embeddingModel'],
    model: EmbeddingModelRef | null
  ): Promise<OpenRag> {
    const key = modelKey(embeddingModel)
    const current = open.get(key)
    if (current && (model === null || current.port)) {
      if (model && current.port) current.port.sdkModelId = model.sdkModelId
      return current
    }
    await closeOpen(key)

    let port: OpenRag['port'] = null
    if (model) {
      const probe = await embedTexts(model.sdkModelId, ['dimension probe'])
      const space: EmbeddingSpace = {
        model: embeddingModel.model,
        revision: embeddingModel.revision,
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

    const dir = path.join(baseDir, 'models', key)
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
    open.set(key, opened)
    return opened
  }

  return {
    list: () =>
      serialize(async () => {
        try {
          const names = await readdir(storesDir)
          return names.filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -'.json'.length))
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
          throw err
        }
      }),

    embeddingAlias: (id) => serialize(async () => (await readStore(id))?.embeddingAlias ?? null),

    attach: (id, model, file) =>
      serialize(async () => {
        const record: StoreRecord = (await readStore(id)) ?? {
          namespace: `${id}-${randomBytes(4).toString('hex')}`,
          embeddingAlias: model.alias,
          embeddingModel: { model: model.model, revision: model.revision },
          files: {}
        }
        assertModel(id, record, model)
        const { rag, port } = await openRag(record.embeddingModel, model)
        await rag.createNamespace({ name: record.namespace, space: port!.space })
        const result = await rag.ingest({
          namespace: record.namespace,
          documents: [{ id: file.fileId, text: file.text, metadata: { filename: file.fileName } }]
        })
        record.files[file.fileId] = file.fileName
        await writeStore(id, record)
        return { chunkCount: result.documents[0]?.chunkCount ?? 0 }
      }),

    search: (id, model, query, k) =>
      serialize(async () => {
        const record = await readStore(id)
        if (!record) return []
        assertModel(id, record, model)
        const { rag } = await openRag(record.embeddingModel, model)
        const hits = await rag.search({ scope: { namespace: record.namespace }, query, k })
        return hits.map((hit) => {
          const filename = hit.documentMetadata?.['filename']
          return {
            fileId: hit.documentId,
            fileName:
              typeof filename === 'string'
                ? filename
                : (record.files[hit.documentId] ?? hit.documentId),
            content: hit.content,
            score: hit.score
          }
        })
      }),

    delete: (id) =>
      serialize(async () => {
        const record = await readStore(id)
        if (!record) return false
        const { rag } = await openRag(record.embeddingModel, null)
        await rag.deleteDocuments({
          namespace: record.namespace,
          documentIds: Object.keys(record.files)
        })
        // The namespace itself stays; a store recreated under this id gets a new one.
        await unlink(recordPath(id))
        return true
      }),

    close: () =>
      serialize(async () => {
        for (const key of [...open.keys()]) await closeOpen(key)
      })
  }
}
