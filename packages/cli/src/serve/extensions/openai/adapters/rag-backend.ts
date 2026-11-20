import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import Corestore from 'corestore'
import { createRag, type EmbeddingSpace, type EmbeddingsPort, type Rag } from '@qvac/rag'
import { embed } from '@qvac/sdk'

const DEFAULT_CACHE_DIRECTORY = path.join(os.homedir(), '.qvac', 'models')
const NAMESPACE = 'files'
const RECORD_FILE = 'store.json'
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/
// Not a valid store id, so a folder being deleted is never listed as a store.
const DELETED_PREFIX = '.deleted-'

/** Vector stores live next to the SDK's model cache, like the rest of its data. */
export function vectorStoreDirFor(cacheDirectory: string | undefined): string {
  return path.join(
    path.dirname(cacheDirectory ?? DEFAULT_CACHE_DIRECTORY),
    'serve',
    'vector-stores'
  )
}

export interface EmbeddingModelRef {
  alias: string
  sdkModelId: string
  /** Stable identity of the weights behind the alias: their source and checksum. */
  model: string
  revision: string
  /** Load config the vectors depend on (pooling, normalization, ...), as stable JSON. */
  config: string
}

/** The store was ingested with other weights or settings than the alias now has. */
export class EmbeddingModelChangedError extends Error {
  constructor(
    readonly storeId: string,
    readonly recorded: string,
    readonly requested: string
  ) {
    super(
      `Vector store "${storeId}" was ingested with embedding model ${recorded}, ` +
        `but the alias now resolves to ${requested}.`
    )
    this.name = 'EmbeddingModelChangedError'
  }
}

/** Another server on the same directory has the store open. */
export class VectorStoreInUseError extends Error {
  constructor(readonly storeId: string) {
    super(`Vector store "${storeId}" is in use by another server.`)
    this.name = 'VectorStoreInUseError'
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
  /** Ids of the stores that hold files. */
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
  /**
   * Deletes the store and its data. Returns false when it held none, and
   * throws VectorStoreInUseError while another server has it open.
   */
  delete: (id: string) => Promise<boolean>
  close: () => Promise<void>
}

type ModelIdentity = Pick<EmbeddingModelRef, 'model' | 'revision' | 'config'>

interface StoreRecord {
  embeddingAlias: string
  embeddingModel: ModelIdentity
  files: Record<string, string>
}

interface OpenRag {
  rag: Rag
  corestore: Corestore
  port: EmbeddingsPort & { sdkModelId: string }
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

function identityOf(model: ModelIdentity): ModelIdentity {
  return { model: model.model, revision: model.revision, config: model.config }
}

function sameIdentity(a: ModelIdentity, b: ModelIdentity): boolean {
  return a.model === b.model && a.revision === b.revision && a.config === b.config
}

function describeModel(model: ModelIdentity): string {
  const name = model.revision ? `${model.model}@${model.revision}` : model.model
  return `"${name}" with config ${model.config}`
}

// The space a RAG instance is bound to. The revision carries the config, so
// two configs of the same weights never share an index.
function spaceRevision(model: ModelIdentity): string {
  const config = createHash('sha256').update(model.config).digest('hex').slice(0, 16)
  return model.revision ? `${model.revision}+${config}` : config
}

// Each store has its own folder: its record, Corestore and index. Deleting a
// store removes the folder, and stores never contend for one Corestore lock.
export function createRagBackend(
  options: { dir?: string; embedTexts?: EmbedTexts } = {}
): RagBackend {
  const baseDir = options.dir ?? vectorStoreDirFor(undefined)
  const embedTexts = options.embedTexts ?? embedTextsWithSdk
  const storesDir = path.join(baseDir, 'stores')
  const open = new Map<string, OpenRag>()
  const queues = new Map<string, Promise<unknown>>()

  // One operation per store at a time; other stores and the record reads
  // (list, embeddingAlias) are not held up.
  function serialize<T>(id: string, task: () => Promise<T>): Promise<T> {
    const previous = queues.get(id) ?? Promise.resolve()
    const run = previous.then(task, task)
    const tail = run.catch(() => {})
    queues.set(id, tail)
    void tail.then(() => {
      if (queues.get(id) === tail) queues.delete(id)
    })
    return run
  }

  function storeDir(id: string): string {
    if (!SAFE_ID.test(id)) throw new Error(`Invalid vector store id "${id}".`)
    return path.join(storesDir, id)
  }

  function recordPath(id: string): string {
    return path.join(storeDir(id), RECORD_FILE)
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
    await mkdir(storeDir(id), { recursive: true })
    const tmp = `${recordPath(id)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
    await writeFile(tmp, JSON.stringify(record, null, 2))
    await rename(tmp, recordPath(id))
  }

  function assertModel(id: string, record: StoreRecord, model: EmbeddingModelRef): void {
    if (sameIdentity(record.embeddingModel, model)) return
    throw new EmbeddingModelChangedError(
      id,
      describeModel(record.embeddingModel),
      describeModel(identityOf(model))
    )
  }

  async function closeOpen(id: string): Promise<void> {
    const current = open.get(id)
    if (!current) return
    open.delete(id)
    await current.rag.close()
    await current.corestore.close()
  }

  async function openRag(id: string, record: StoreRecord, model: EmbeddingModelRef) {
    const current = open.get(id)
    if (current) {
      current.port.sdkModelId = model.sdkModelId
      return current
    }

    const probe = await embedTexts(model.sdkModelId, ['dimension probe'])
    const space: EmbeddingSpace = {
      model: record.embeddingModel.model,
      revision: spaceRevision(record.embeddingModel),
      dimensions: probe[0]?.length ?? 0,
      metric: 'cosine',
      normalized: false,
      documentEncoding: '',
      queryEncoding: '',
      preprocessing: 'none'
    }
    const ref = { sdkModelId: model.sdkModelId }
    const port: OpenRag['port'] = {
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

    const dir = storeDir(id)
    const corestore = new Corestore(path.join(dir, 'corestore'))
    const rag = createRag({ corestore, embeddings: port, index: { dir: path.join(dir, 'index') } })
    try {
      await rag.ready()
      await rag.createNamespace({ name: NAMESPACE, space })
    } catch (err) {
      await rag.close().catch(() => {})
      await corestore.close()
      throw err
    }
    const opened = { rag, corestore, port }
    open.set(id, opened)
    return opened
  }

  // A Corestore has one opener at a time, so opening it fails while another
  // server holds the store. Any other failure leaves a broken store deletable.
  async function assertNotOpenElsewhere(id: string): Promise<void> {
    const corestore = new Corestore(path.join(storeDir(id), 'corestore'))
    try {
      await corestore.ready()
    } catch (err) {
      if (/could not be locked/i.test((err as Error).message)) throw new VectorStoreInUseError(id)
    } finally {
      await corestore.close().catch(() => {})
    }
  }

  async function removeStore(id: string): Promise<void> {
    await closeOpen(id)
    await rm(storeDir(id), { recursive: true, force: true })
  }

  return {
    async list() {
      let names: string[]
      try {
        names = await readdir(storesDir)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw err
      }
      // Finish the deletes whose folder could not be removed at the time.
      await Promise.all(
        names
          .filter((name) => name.startsWith(DELETED_PREFIX))
          .map((name) => rm(path.join(storesDir, name), { recursive: true, force: true }))
      ).catch(() => {})
      const ids = await Promise.all(
        names.map(async (name) => (SAFE_ID.test(name) && (await readStore(name)) ? name : null))
      )
      return ids.filter((id): id is string => id !== null)
    },

    embeddingAlias: async (id) => (await readStore(id))?.embeddingAlias ?? null,

    attach: (id, model, file) =>
      serialize(id, async () => {
        const existing = await readStore(id)
        if (existing) assertModel(id, existing, model)
        // A folder without a record is what a failed create or delete left.
        else await removeStore(id)

        const record: StoreRecord = existing ?? {
          embeddingAlias: model.alias,
          embeddingModel: identityOf(model),
          files: {}
        }
        const isNewFile = !(file.fileId in record.files)
        // Record the file before ingesting it, so a store whose ingest
        // half-landed is still listed and its delete removes everything.
        await writeStore(id, {
          ...record,
          files: { ...record.files, [file.fileId]: file.fileName }
        })

        try {
          const { rag } = await openRag(id, record, model)
          const result = await rag.ingest({
            namespace: NAMESPACE,
            documents: [{ id: file.fileId, text: file.text, metadata: { filename: file.fileName } }]
          })
          return { chunkCount: result.documents[0]?.chunkCount ?? 0 }
        } catch (err) {
          if (!existing) await removeStore(id).catch(() => {})
          else if (isNewFile) await writeStore(id, record).catch(() => {})
          throw err
        }
      }),

    search: (id, model, query, k) =>
      serialize(id, async () => {
        const record = await readStore(id)
        if (!record) return []
        assertModel(id, record, model)
        const { rag } = await openRag(id, record, model)
        const hits = await rag.search({ scope: { namespace: NAMESPACE }, query, k })
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
      serialize(id, async () => {
        if (!(await readStore(id))) return false
        await closeOpen(id)
        await assertNotOpenElsewhere(id)
        // Move the folder out of the listing first: the store is gone even if
        // removing its data fails, and the next listing retries the removal.
        const deleted = path.join(
          storesDir,
          `${DELETED_PREFIX}${id}-${randomBytes(4).toString('hex')}`
        )
        await rename(storeDir(id), deleted)
        await rm(deleted, { recursive: true, force: true })
        return true
      }),

    async close() {
      await Promise.all([...open.keys()].map((id) => serialize(id, () => closeOpen(id))))
    }
  }
}
