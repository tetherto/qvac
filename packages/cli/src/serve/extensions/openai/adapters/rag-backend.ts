import { createHash, randomBytes } from 'node:crypto'
import {
  link,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  unlink,
  writeFile
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import Corestore from 'corestore'
import { createRag, type EmbeddingSpace, type EmbeddingsPort, type Rag } from '@qvac/rag'
import { embed } from '@qvac/sdk'

// Snap's HOME can be revision-scoped; SNAP_USER_COMMON is stable, as in the SDK.
const HOME_DIR = process.env['SNAP_USER_COMMON'] ?? os.homedir()
const DEFAULT_CACHE_DIRECTORY = path.join(HOME_DIR, '.qvac', 'models')
const NAMESPACE = 'files'
const RECORD_FILE = 'store.json'
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/
// Not a valid store id, so a folder being deleted is never listed as a store.
const DELETED_PREFIX = '.deleted-'
const IDLE_CLOSE_MS = 60_000

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
  /** Folder inside the store that holds its Corestore and index. */
  dataDir: string
  files: Record<string, string>
}

interface OpenRag {
  dataDir: string
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

function isLockError(err: unknown): boolean {
  return err instanceof Error && /could not be locked/i.test(err.message)
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

// Each store has its own folder: its record and a data folder with its
// Corestore and index. Stores never contend for one Corestore lock.
export function createRagBackend(
  options: { dir?: string; embedTexts?: EmbedTexts; idleMs?: number } = {}
): RagBackend {
  const baseDir = options.dir ?? vectorStoreDirFor(undefined)
  const embedTexts = options.embedTexts ?? embedTextsWithSdk
  const idleMs = options.idleMs ?? IDLE_CLOSE_MS
  const storesDir = path.join(baseDir, 'stores')
  const open = new Map<string, OpenRag>()
  const queues = new Map<string, Promise<unknown>>()
  const idleTimers = new Map<string, NodeJS.Timeout>()

  function cancelIdleClose(id: string): void {
    clearTimeout(idleTimers.get(id))
    idleTimers.delete(id)
  }

  // An open store holds its Corestore lock, which keeps other servers on the
  // same directory out of it, so a store nothing is using gets closed.
  function scheduleIdleClose(id: string): void {
    cancelIdleClose(id)
    if (!open.has(id)) return
    const timer = setTimeout(() => {
      idleTimers.delete(id)
      void serialize(id, () => closeOpen(id)).catch(() => {})
    }, idleMs)
    timer.unref()
    idleTimers.set(id, timer)
  }

  // One operation per store at a time; other stores and the record reads
  // (list, embeddingAlias) are not held up.
  function serialize<T>(id: string, task: () => Promise<T>): Promise<T> {
    cancelIdleClose(id)
    const previous = queues.get(id) ?? Promise.resolve()
    const run = previous.then(task, task)
    const tail = run.catch(() => {})
    queues.set(id, tail)
    void tail.then(() => {
      if (queues.get(id) !== tail) return
      queues.delete(id)
      scheduleIdleClose(id)
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

  // Fails with EEXIST when another server published the store first.
  async function publishStore(id: string, record: StoreRecord): Promise<void> {
    const tmp = `${recordPath(id)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
    await writeFile(tmp, JSON.stringify(record, null, 2))
    try {
      await link(tmp, recordPath(id))
    } finally {
      await unlink(tmp).catch(() => {})
    }
  }

  function dataPath(id: string, record: Pick<StoreRecord, 'dataDir'>): string {
    return path.join(storeDir(id), record.dataDir)
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

  // Returns null when the store was deleted or recreated before this server
  // took its lock. `published: false` is for a store this server is creating.
  async function openRag(
    id: string,
    record: StoreRecord,
    model: EmbeddingModelRef,
    { published = true }: { published?: boolean } = {}
  ): Promise<OpenRag | null> {
    const current = open.get(id)
    if (current && current.dataDir === record.dataDir) {
      current.port.sdkModelId = model.sdkModelId
      return current
    }
    // Another server deleted and recreated the store since this one opened it.
    await closeOpen(id)

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

    const dir = dataPath(id, record)
    const corestore = new Corestore(path.join(dir, 'corestore'))
    const rag = createRag({ corestore, embeddings: port, index: { dir: path.join(dir, 'index') } })
    try {
      await rag.ready()
      if (published) {
        const latest = await readStore(id)
        if (!latest || latest.dataDir !== record.dataDir) {
          await rag.close()
          await corestore.close()
          // Opening recreated the deleted folder; nothing else uses it.
          await rm(dir, { recursive: true, force: true })
          await rmdir(storeDir(id)).catch(() => {})
          return null
        }
      }
      await rag.createNamespace({ name: NAMESPACE, space })
    } catch (err) {
      await rag.close().catch(() => {})
      await corestore.close().catch(() => {})
      if (isLockError(err)) throw new VectorStoreInUseError(id)
      throw err
    }
    const opened = { dataDir: record.dataDir, rag, corestore, port }
    open.set(id, opened)
    return opened
  }

  // A Corestore has one opener at a time, so holding it keeps other servers
  // out of the store. Returns null when the store was deleted or recreated
  // before the lock was taken. Any other open failure leaves a broken store
  // deletable, so it does not stop the delete.
  async function lockStore(id: string, seen: StoreRecord) {
    const corestore = new Corestore(path.join(dataPath(id, seen), 'corestore'))
    try {
      await corestore.ready()
    } catch (err) {
      await corestore.close().catch(() => {})
      if (isLockError(err)) throw new VectorStoreInUseError(id)
    }
    const record = await readStore(id).catch(async (err: unknown) => {
      await corestore.close().catch(() => {})
      throw err
    })
    if (!record || record.dataDir !== seen.dataDir) {
      await corestore.close().catch(() => {})
      return null
    }
    return corestore
  }

  // Under the lock, moves the record out first: a server that opens the data
  // afterwards finds no record and leaves it. The data is removed only once
  // the lock is released, since Windows cannot rename a folder with open files.
  async function removeStore(id: string): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const record = await readStore(id)
      if (!record) return false
      await closeOpen(id)
      const lock = await lockStore(id, record)
      if (!lock) continue
      const tag = `${DELETED_PREFIX}${id}-${randomBytes(4).toString('hex')}`
      try {
        await rename(recordPath(id), path.join(storesDir, `${tag}.json`))
      } finally {
        await lock.close().catch(() => {})
      }
      const deleted = path.join(storesDir, tag)
      await rename(dataPath(id, record), deleted)
      // Fails harmlessly when another server already created the id again.
      await rmdir(storeDir(id)).catch(() => {})
      await rm(`${deleted}.json`, { force: true })
      await rm(deleted, { recursive: true, force: true })
      return true
    }
    throw new VectorStoreInUseError(id)
  }

  async function ingest(rag: Rag, file: VectorStoreFile & { text: string }) {
    const result = await rag.ingest({
      namespace: NAMESPACE,
      documents: [{ id: file.fileId, text: file.text, metadata: { filename: file.fileName } }]
    })
    return { chunkCount: result.documents[0]?.chunkCount ?? 0 }
  }

  // Opens a fresh data folder, which takes its Corestore lock, before the
  // record is published. Until then no other server can find the folder, so a
  // failure only removes what this attempt created. Returns null when another
  // server published the store first.
  async function createStore(
    id: string,
    model: EmbeddingModelRef,
    file: VectorStoreFile & { text: string }
  ) {
    const record: StoreRecord = {
      embeddingAlias: model.alias,
      embeddingModel: identityOf(model),
      dataDir: `data-${randomBytes(6).toString('hex')}`,
      files: { [file.fileId]: file.fileName }
    }
    const dir = dataPath(id, record)
    await mkdir(dir, { recursive: true })
    let rag: Rag
    try {
      const opened = await openRag(id, record, model, { published: false })
      if (!opened) throw new Error('unreachable: an unpublished store is never stale')
      rag = opened.rag
      await publishStore(id, record)
    } catch (err) {
      await closeOpen(id).catch(() => {})
      await rm(dir, { recursive: true, force: true })
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return null
      throw err
    }
    try {
      return await ingest(rag, file)
    } catch (err) {
      // This server still holds the lock, so nothing else was added.
      await closeOpen(id).catch(() => {})
      await unlink(recordPath(id)).catch(() => {})
      await rm(dir, { recursive: true, force: true }).catch(() => {})
      throw err
    }
  }

  // Takes the store's lock before changing its record. Returns null when the
  // store was deleted or recreated meanwhile.
  async function attachToStore(
    id: string,
    seen: StoreRecord,
    model: EmbeddingModelRef,
    file: VectorStoreFile & { text: string }
  ) {
    const opened = await openRag(id, seen, model)
    if (!opened) return null
    const { rag } = opened
    const record = await readStore(id)
    if (!record || record.dataDir !== seen.dataDir) {
      await closeOpen(id)
      return null
    }
    assertModel(id, record, model)
    const isNewFile = !(file.fileId in record.files)
    // Record the file before ingesting it, so a half-landed ingest is still
    // covered by the store's delete.
    await writeStore(id, { ...record, files: { ...record.files, [file.fileId]: file.fileName } })
    try {
      return await ingest(rag, file)
    } catch (err) {
      if (isNewFile) await writeStore(id, record).catch(() => {})
      throw err
    }
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
        for (let attempt = 0; attempt < 3; attempt++) {
          const existing = await readStore(id)
          if (existing) assertModel(id, existing, model)
          const result = existing
            ? await attachToStore(id, existing, model, file)
            : await createStore(id, model, file)
          if (result) return result
        }
        throw new VectorStoreInUseError(id)
      }),

    search: (id, model, query, k) =>
      serialize(id, async () => {
        const record = await readStore(id)
        if (!record) return []
        assertModel(id, record, model)
        const opened = await openRag(id, record, model)
        if (!opened) return []
        const hits = await opened.rag.search({ scope: { namespace: NAMESPACE }, query, k })
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

    // The store is gone once its record moves, even if removing its data
    // fails; the next listing retries the removal.
    delete: (id) => serialize(id, () => removeStore(id)),

    async close() {
      await Promise.all([...open.keys()].map((id) => serialize(id, () => closeOpen(id))))
      for (const id of [...idleTimers.keys()]) cancelIdleClose(id)
    }
  }
}
