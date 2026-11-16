import { QvacErrorRAG, ERR_CODES } from '../errors.js'
import { decodeNativeId, decodeVectorInto, unpackNativeIds } from '../db/encoding.js'
import {
  CHUNKS,
  MUTATIONS,
  NAMESPACES,
  NATIVE_IDS,
  SPACES,
  type ChunkRecord,
  type MutationRecord,
  type NamespaceRecord,
  type NativeIdRecord,
  type SpaceRecord
} from '../db/records.js'
import { checkStoredVector } from '../search.js'
import { BIT_WIDTHS, loadNativeIndex, type NativeIndex, type NativeIndexModule } from './native.js'
import { createSnapshotStore, type SnapshotIdentity, type SnapshotStore } from './snapshots.js'
import type { HyperDBInstance, HyperDBReader, HyperDBTransaction } from '../db/db-types.js'
import type { IndexStorage } from '../types.js'

// Rows decoded per native add while rebuilding; memory stays bounded by this.
export const REBUILD_BATCH_SIZE = 1024
export const DEFAULT_SNAPSHOT_EVERY = 256
export const DEFAULT_INDEX_STORAGE: IndexStorage = 'q8'
// TurboVec's remove() only tombstones a row; compact once removed rows reach
// this share of the live ones, so replacing documents doesn't grow memory.
export const COMPACT_SHARE = 0.25

export interface IndexConfig {
  // Where snapshots go. Without it the index lives in memory and is rebuilt
  // from HyperDB on every open.
  dir?: string
  // Committed mutations between snapshots.
  snapshotEvery: number
}

// A namespace index caught up to at least the revision a search reads.
export interface OpenIndex {
  native: NativeIndex
  normalize: boolean
  storage: IndexStorage
  // The index's revision now; commits move it on between awaits.
  revision(): number
  // Drops an index whose native search failed; searches scan from then on.
  fail(): void
}

interface Entry {
  namespace: string
  store: SnapshotStore | null
  snapshotEvery: number
  native: NativeIndex | null
  identity: SnapshotIdentity | null
  normalize: boolean
  revision: number
  persistedRevision: number
  // Rows removed since the index was built, loaded or last compacted.
  tombstones: number
  // Set while the index is loading, replaying or rebuilding; commits skip the
  // entry then and the next search replays them from `mutations`.
  syncing: Promise<void> | null
  // Set when the index could not be built or searched. The index is derived,
  // so searches scan instead of failing, until the RAG is reopened.
  broken: boolean
  // The last snapshot write; writes share a sidecar temp file, so they chain.
  persisting: Promise<void>
  needsPrepare: boolean
}

export interface IndexRegistry {
  open(namespace: string, config: IndexConfig): Promise<OpenIndex | null>
  // Called inside a namespace's committing transaction, before its flush:
  // deletes the mutations a written snapshot no longer needs.
  prune(tx: HyperDBTransaction, namespace: string): Promise<void>
  // Called after the commit's flush. `vectors` is only built when an open
  // index takes the commit.
  apply(
    namespace: string,
    revision: number,
    added: bigint[],
    vectors: () => Float32Array,
    removed: bigint[]
  ): Promise<void>
  close(): Promise<void>
}

// One registry per shared HyperDB, so every RAG on a core sees one index per
// namespace and snapshot directory.
export function createIndexRegistry(db: HyperDBInstance, coreKey: string): IndexRegistry {
  const entries = new Map<string, Entry>()
  // Per namespace, the newest snapshot revision; mutations up to it can go. A
  // flush ends a HyperDB transaction, so pruning rides on the next one instead
  // of the commit that triggered the snapshot.
  const prunable = new Map<string, number>()
  let closed = false

  function entryFor(namespace: string, config: IndexConfig): Entry {
    const key = `${config.dir ?? ''}\0${namespace}`
    let entry = entries.get(key)
    if (!entry) {
      entry = {
        namespace,
        store: config.dir ? createSnapshotStore(config.dir, coreKey) : null,
        snapshotEvery: config.snapshotEvery,
        native: null,
        identity: null,
        normalize: false,
        revision: 0,
        persistedRevision: 0,
        tombstones: 0,
        syncing: null,
        broken: false,
        persisting: Promise.resolve(),
        needsPrepare: true
      }
      entries.set(key, entry)
    }
    return entry
  }

  async function open(namespace: string, config: IndexConfig): Promise<OpenIndex | null> {
    const module = await loadNativeIndex()
    if (!module || closed) return null
    const entry = entryFor(namespace, config)
    // Another call's sync may finish below the revision this one needs.
    for (;;) {
      while (entry.syncing) await entry.syncing.catch(() => {})
      if (entry.broken) return null
      const reader = db.snapshot()
      let target: number
      try {
        target = (await getNamespace(reader, namespace)).revision
      } finally {
        await reader.close()
      }
      if (entry.native && entry.revision >= target) break
      // Another call may have started a sync while this one awaited.
      if (entry.syncing) continue
      const syncing = sync(entry, module)
      entry.syncing = syncing
      try {
        await syncing
      } catch {
        entry.broken = true
        return null
      } finally {
        entry.syncing = null
      }
    }
    const native = entry.native as NativeIndex
    if (entry.needsPrepare) {
      native.prepare()
      entry.needsPrepare = false
    }
    return {
      native,
      normalize: entry.normalize,
      storage: entry.identity?.storage ?? DEFAULT_INDEX_STORAGE,
      revision: () => entry.revision,
      fail: () => {
        entry.broken = true
        discard(entry)
      }
    }
  }

  async function sync(entry: Entry, module: NativeIndexModule): Promise<void> {
    const reader = db.snapshot()
    try {
      const ns = await getNamespace(reader, entry.namespace)
      const space = await reader.get<SpaceRecord>(SPACES, { spaceId: ns.spaceId })
      if (!space) {
        throw new QvacErrorRAG({
          code: ERR_CODES.DB_OPERATION_FAILED,
          adds: `embedding space ${ns.spaceId} of namespace '${entry.namespace}' is missing`
        })
      }
      const identity: SnapshotIdentity = {
        namespace: ns.name,
        createdAt: ns.createdAt.getTime(),
        spaceId: ns.spaceId,
        storage: (ns.indexStorage as IndexStorage | undefined) ?? DEFAULT_INDEX_STORAGE,
        dimensions: space.dimensions
      }
      entry.normalize = space.metric === 'cosine'

      if (entry.native && !sameIdentity(entry.identity, identity)) discard(entry)
      entry.identity = identity
      if (!entry.native) await load(entry, module, identity, ns.revision)
      if (entry.native && entry.revision < ns.revision) {
        const replayed = await replay(entry, reader, ns.revision).catch(() => false)
        if (!replayed) discard(entry)
      }
      if (!entry.native) await rebuild(entry, module, reader, identity, ns.revision)
    } catch (error) {
      discard(entry)
      throw error
    } finally {
      await reader.close()
    }
    if (entry.store && entry.revision - entry.persistedRevision >= entry.snapshotEvery) {
      await persistAndPrune(entry)
    }
  }

  async function load(
    entry: Entry,
    module: NativeIndexModule,
    identity: SnapshotIdentity,
    revision: number
  ): Promise<void> {
    if (!entry.store) return
    const stored = await entry.store.read(identity)
    // A snapshot ahead of the database belongs to a state this store never
    // reached, so it can't be trusted.
    if (!stored || stored.revision > revision) return
    let native: NativeIndex
    try {
      native = module.load(stored.path)
    } catch {
      return
    }
    if (native.dim !== identity.dimensions || native.bitWidth !== BIT_WIDTHS[identity.storage]) {
      native.dispose()
      return
    }
    install(entry, native, stored.revision)
    entry.persistedRevision = stored.revision
  }

  // Applies the mutations after the index's revision, reading added vectors
  // from the current chunks. Returns false when a mutation row is missing,
  // which means it was pruned after a newer snapshot and only a rebuild can
  // reach the database's state.
  async function replay(entry: Entry, reader: HyperDBReader, target: number): Promise<boolean> {
    const namespace = entry.namespace
    let expected = entry.revision + 1
    const stream = reader.find<MutationRecord>(MUTATIONS, {
      gte: { namespace, revision: expected },
      lte: { namespace, revision: target }
    })
    for await (const mutation of stream) {
      if (mutation.revision !== expected) return false
      const added = unpackNativeIds(mutation.added)
      const ids: bigint[] = []
      const vectors: Float32Array[] = []
      const native = entry.native as NativeIndex
      for (const id of added) {
        if (native.contains(id)) continue
        // Absent rows were removed by a later mutation in this range.
        const vector = await readVector(reader, namespace, id)
        if (vector) {
          ids.push(id)
          vectors.push(vector)
        }
      }
      removeRows(entry, native, unpackNativeIds(mutation.removed))
      addRows(entry, native, ids, concat(vectors, native.dim))
      compactIfNeeded(entry, native)
      entry.revision = mutation.revision
      expected++
    }
    return entry.revision === target
  }

  async function rebuild(
    entry: Entry,
    module: NativeIndexModule,
    reader: HyperDBReader,
    identity: SnapshotIdentity,
    revision: number
  ): Promise<void> {
    const native = module.create(identity.dimensions, identity.storage)
    try {
      const dims = identity.dimensions
      const vectors = new Float32Array(REBUILD_BATCH_SIZE * dims)
      const ids = new BigUint64Array(REBUILD_BATCH_SIZE)
      let rows = 0
      const flush = () => {
        if (rows === 0) return
        const batch = vectors.subarray(0, rows * dims)
        if (entry.normalize) normalizeRows(batch, dims)
        native.addWithIds(batch, ids.subarray(0, rows))
        rows = 0
      }
      const namespace = entry.namespace
      const stream = reader.find<ChunkRecord>(CHUNKS, { gte: { namespace }, lte: { namespace } })
      for await (const chunk of stream) {
        checkStoredVector(chunk, dims)
        decodeVectorInto(chunk.vector, vectors, rows * dims)
        ids[rows++] = decodeNativeId(chunk.nativeId)
        if (rows === REBUILD_BATCH_SIZE) flush()
      }
      flush()
    } catch (error) {
      native.dispose()
      throw error
    }
    install(entry, native, revision)
    entry.persistedRevision = 0
  }

  async function apply(
    namespace: string,
    revision: number,
    added: bigint[],
    vectors: () => Float32Array,
    removed: bigint[]
  ): Promise<void> {
    let rows: Float32Array | null = null
    for (const entry of entries.values()) {
      if (entry.namespace !== namespace || !entry.native || entry.syncing) continue
      if (entry.revision !== revision - 1) continue
      try {
        removeRows(entry, entry.native, removed)
        rows ??= vectors()
        addRows(entry, entry.native, added, entry.normalize ? rows.slice() : rows)
        compactIfNeeded(entry, entry.native)
        entry.revision = revision
      } catch {
        // The commit is durable; the next search rebuilds from HyperDB.
        discard(entry)
        continue
      }
      if (entry.revision - entry.persistedRevision >= entry.snapshotEvery) {
        await persist(entry).catch(() => {})
      }
    }
  }

  // Snapshot failures are not fatal: the mutations stay, and the next open
  // replays them.
  function persist(entry: Entry): Promise<void> {
    const next = entry.persisting.then(() => write(entry))
    entry.persisting = next.catch(() => {})
    return next
  }

  async function write(entry: Entry): Promise<void> {
    const { store, native, identity } = entry
    if (!store || !native || !identity) return
    if (entry.revision <= entry.persistedRevision) return
    const revision = await store.write(identity, native, () => {
      // A rebuild may swap the index while the store awaits the filesystem.
      if (entry.native !== native) throw new Error('index replaced during snapshot')
      return entry.revision
    })
    if (entry.native !== native) return
    entry.persistedRevision = Math.max(entry.persistedRevision, revision)
    prunable.set(entry.namespace, Math.max(prunable.get(entry.namespace) ?? 0, revision))
  }

  async function persistAndPrune(entry: Entry): Promise<void> {
    try {
      await persist(entry)
      if (!prunable.has(entry.namespace)) return
      await withTransaction(async (tx) => {
        await prune(tx, entry.namespace)
        await tx.flush()
      })
    } catch {}
  }

  async function prune(tx: HyperDBTransaction, namespace: string): Promise<void> {
    const revision = prunable.get(namespace)
    if (revision === undefined) return
    const stale = await tx
      .find<MutationRecord>(MUTATIONS, { gte: { namespace }, lte: { namespace, revision } })
      .toArray()
    for (const mutation of stale) {
      await tx.delete(MUTATIONS, { namespace, revision: mutation.revision })
    }
    // If this transaction never flushes, the rows stay until the next
    // snapshot. Replay starts after a snapshot's revision and never reads them.
    prunable.delete(namespace)
  }

  async function close(): Promise<void> {
    closed = true
    for (const entry of entries.values()) {
      while (entry.syncing) await entry.syncing.catch(() => {})
      if (entry.store && entry.native) await persistAndPrune(entry)
      discard(entry)
    }
    entries.clear()
  }

  async function withTransaction(run: (tx: HyperDBTransaction) => Promise<void>): Promise<void> {
    const tx = await db.exclusiveTransaction()
    try {
      await run(tx)
    } finally {
      await tx.close()
    }
  }

  return { open, prune, apply, close }
}

function install(entry: Entry, native: NativeIndex, revision: number): void {
  if (entry.native && entry.native !== native) entry.native.dispose()
  entry.native = native
  entry.revision = revision
  entry.tombstones = 0
  entry.needsPrepare = true
}

function discard(entry: Entry): void {
  entry.native?.dispose()
  entry.native = null
  entry.revision = 0
  entry.persistedRevision = 0
  entry.tombstones = 0
}

function removeRows(entry: Entry, native: NativeIndex, ids: bigint[]): void {
  for (const id of ids) {
    if (native.remove(id)) entry.tombstones++
  }
}

function compactIfNeeded(entry: Entry, native: NativeIndex): void {
  if (entry.tombstones === 0 || entry.tombstones < native.length * COMPACT_SHARE) return
  native.compact()
  entry.tombstones = 0
  entry.needsPrepare = true
}

function addRows(entry: Entry, native: NativeIndex, ids: bigint[], vectors: Float32Array): void {
  if (ids.length === 0) return
  if (entry.normalize) normalizeRows(vectors, native.dim)
  native.addWithIds(vectors, BigUint64Array.from(ids))
  entry.needsPrepare = true
}

async function readVector(
  reader: HyperDBReader,
  namespace: string,
  id: bigint
): Promise<Float32Array | null> {
  const nativeId = new Uint8Array(8)
  new DataView(nativeId.buffer).setBigUint64(0, id, false)
  const row = await reader.get<NativeIdRecord>(NATIVE_IDS, { namespace, nativeId })
  if (!row) return null
  const chunk = await reader.get<ChunkRecord>(CHUNKS, {
    namespace,
    documentId: row.documentId,
    generation: row.generation,
    ordinal: row.ordinal
  })
  if (!chunk) return null
  const vector = new Float32Array(chunk.vector.byteLength / 4)
  decodeVectorInto(chunk.vector, vector, 0)
  return vector
}

function concat(rows: Float32Array[], dims: number): Float32Array {
  const out = new Float32Array(rows.length * dims)
  rows.forEach((row, i) => out.set(row, i * dims))
  return out
}

// Cosine namespaces index unit vectors, so the native dot product is the cosine.
export function normalizeRows(vectors: Float32Array, dims: number): void {
  for (let offset = 0; offset < vectors.length; offset += dims) {
    let sum = 0
    for (let i = offset; i < offset + dims; i++) sum += vectors[i] * vectors[i]
    if (sum === 0) continue
    const scale = 1 / Math.sqrt(sum)
    for (let i = offset; i < offset + dims; i++) vectors[i] *= scale
  }
}

function sameIdentity(a: SnapshotIdentity | null, b: SnapshotIdentity): boolean {
  return (
    a !== null &&
    a.namespace === b.namespace &&
    a.createdAt === b.createdAt &&
    a.spaceId === b.spaceId &&
    a.storage === b.storage &&
    a.dimensions === b.dimensions
  )
}

async function getNamespace(reader: HyperDBReader, name: string): Promise<NamespaceRecord> {
  const ns = await reader.get<NamespaceRecord>(NAMESPACES, { name })
  if (!ns) throw new QvacErrorRAG({ code: ERR_CODES.NAMESPACE_NOT_FOUND, adds: name })
  return ns
}
