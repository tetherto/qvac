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
import { checkStoredVector, throwIfAborted } from '../search.js'
import {
  BIT_WIDTHS,
  PADDING_ID,
  type NativeIndex,
  type NativeIndexLoad,
  type NativeIndexModule,
  type NativeSearchResult
} from './native.js'
import {
  createSnapshotStore,
  type FileSystem,
  type SnapshotIdentity,
  type SnapshotStore
} from './snapshots.js'
import type { HyperDBInstance, HyperDBReader, HyperDBTransaction } from '../db/db-types.js'
import type { IndexStatus, IndexStorage } from '../types.js'

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
  // Replaces TurboVec.
  provider?: NativeIndexModule
  // Replaces bare-fs.
  fs?: FileSystem
}

// What `ready()` loaded, before a host can seal module loading.
export interface IndexRuntime {
  native: NativeIndexLoad
  // Null without the index module, or when the file system failed to load.
  files: FileSystem | null
  filesError?: unknown
}

// A namespace index caught up to at least the revision a search reads.
export interface OpenIndex {
  normalize: boolean
  storage: IndexStorage
  // -1 once the index is replaced or dropped.
  revision(): number
  // Upper bound on rows; TurboVec's `length` lags pending calls.
  rows(): number
  // 'stale' if the index moved past `revision` or was replaced meanwhile.
  search(
    revision: number,
    query: Float32Array,
    k: number,
    allowlist: BigUint64Array | null,
    signal?: AbortSignal
  ): Promise<NativeSearchResult | 'stale' | 'unavailable'>
}

interface Entry {
  namespace: string
  dir: string | undefined
  store: SnapshotStore | null
  snapshotEvery: number
  native: NativeIndex | null
  identity: SnapshotIdentity | null
  normalize: boolean
  revision: number
  rows: number
  // False once a mutation failed and left the index half-applied.
  settled: Promise<boolean>
  persistedRevision: number
  // Rows removed since the index was built, loaded or last compacted.
  tombstones: number
  // Set while the index is loading, replaying or rebuilding; commits skip the
  // entry then and the next search replays them from `mutations`.
  syncing: Promise<void> | null
  // Set when the index could not be built or searched. The index is derived,
  // so searches scan instead of failing, until the RAG is reopened.
  failure: { reason: 'rebuild-failed' | 'search-failed'; error: unknown } | null
  // The last snapshot read or write failure; the index stays in memory.
  snapshotError: { error: unknown } | null
  // The last snapshot write; writes share a sidecar temp file, so they chain.
  persisting: Promise<void>
  needsPrepare: boolean
}

export interface IndexRegistry {
  open(namespace: string, config: IndexConfig, runtime: IndexRuntime): Promise<OpenIndex | null>
  // Reports the namespace's index without opening it.
  status(namespace: string, config: IndexConfig, runtime: IndexRuntime): IndexStatus
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
  // Forgets a dropped namespace's index and deletes its snapshot. A snapshot
  // left behind never loads: a re-created namespace has another identity.
  drop(
    namespace: string,
    createdAt: number,
    config: IndexConfig,
    runtime: IndexRuntime
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
  // A dropped entry's late write must not prune a re-created namespace.
  const dropped = new WeakSet<Entry>()
  // Snapshot writes and removals of one namespace run in order, so a removal
  // never reads one sidecar and deletes another written in between.
  const disk = new Map<string, Promise<unknown>>()
  const retiring = new Set<Promise<void>>()
  let closed = false

  function onDisk<T>(namespace: string, run: () => Promise<T>): Promise<T> {
    const next = (disk.get(namespace) ?? Promise.resolve()).then(run)
    const settled = next.catch(() => {})
    disk.set(namespace, settled)
    void settled.then(() => {
      if (disk.get(namespace) === settled) disk.delete(namespace)
    })
    return next
  }

  // RAGs on one core share an index only with the same provider and directory.
  const providerIds = new WeakMap<NativeIndexModule, number>()
  let nextProviderId = 1
  function keyOf(namespace: string, config: IndexConfig, runtime: IndexRuntime): string {
    const module = runtime.native.module
    let id = 0
    if (module) {
      id = providerIds.get(module) ?? nextProviderId++
      providerIds.set(module, id)
    }
    return `${id}\0${config.dir ?? ''}\0${namespace}`
  }

  function entryFor(namespace: string, config: IndexConfig, runtime: IndexRuntime): Entry {
    const key = keyOf(namespace, config, runtime)
    let entry = entries.get(key)
    if (!entry) {
      const { files } = runtime
      // A provider that can't load a snapshot keeps its index in memory.
      const snapshots = config.dir !== undefined && runtime.native.module?.load !== undefined
      entry = {
        namespace,
        dir: config.dir,
        store:
          snapshots && files ? createSnapshotStore(config.dir as string, coreKey, files) : null,
        snapshotEvery: config.snapshotEvery,
        native: null,
        identity: null,
        normalize: false,
        revision: 0,
        rows: 0,
        settled: SETTLED,
        persistedRevision: 0,
        tombstones: 0,
        syncing: null,
        failure: null,
        snapshotError: snapshots && !files ? { error: runtime.filesError } : null,
        persisting: Promise.resolve(),
        needsPrepare: true
      }
      entries.set(key, entry)
    }
    return entry
  }

  async function open(
    namespace: string,
    config: IndexConfig,
    runtime: IndexRuntime
  ): Promise<OpenIndex | null> {
    const module = runtime.native.module
    if (!module || closed) return null
    const entry = entryFor(namespace, config, runtime)
    // Another call's sync may finish below the revision this one needs.
    for (;;) {
      while (entry.syncing) await entry.syncing.catch(() => {})
      if (entry.failure) return null
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
      } catch (error) {
        entry.failure = { reason: 'rebuild-failed', error }
        return null
      } finally {
        entry.syncing = null
      }
    }
    const native = entry.native as NativeIndex
    if (entry.needsPrepare) {
      entry.needsPrepare = false
      void native.prepare?.().catch(() => {})
    }
    return {
      normalize: entry.normalize,
      storage: entry.identity?.storage ?? DEFAULT_INDEX_STORAGE,
      revision: () => (entry.native === native ? entry.revision : -1),
      rows: () => (entry.native === native ? entry.rows : 0),
      search: (revision, query, k, allowlist, signal) =>
        searchAt(entry, native, revision, query, k, allowlist, signal)
    }
  }

  async function searchAt(
    entry: Entry,
    native: NativeIndex,
    revision: number,
    query: Float32Array,
    k: number,
    allowlist: BigUint64Array | null,
    signal?: AbortSignal
  ): Promise<NativeSearchResult | 'stale' | 'unavailable'> {
    // Check and call in one synchronous step, so no mutation slips between.
    if (entry.native !== native || entry.revision !== revision) return 'stale'
    const settled = entry.settled
    const options = signal ? { signal } : undefined
    let result: NativeSearchResult | 'stale'
    try {
      if (!allowlist) result = await native.search(query, k, options)
      else if (native.searchFiltered) {
        result = await native.searchFiltered(query, k, allowlist, options)
      } else {
        result = await searchAllowed(entry, native, revision, query, k, allowlist, options)
      }
    } catch (error) {
      throwIfAborted(signal)
      // Disposed by a rebuild or close while the call waited.
      if (entry.native !== native) return 'stale'
      entry.failure = { reason: 'search-failed', error }
      discard(entry)
      return 'unavailable'
    }
    if (result === 'stale' || !(await settled)) return 'stale'
    return result
  }

  // For a provider without `searchFiltered`: over-fetches by the share of rows
  // the allowlist covers, doubling until `k` allowed hits come back or the
  // index runs out of rows. The first call is issued synchronously.
  async function searchAllowed(
    entry: Entry,
    native: NativeIndex,
    revision: number,
    query: Float32Array,
    k: number,
    allowlist: BigUint64Array,
    options: { signal?: AbortSignal } | undefined
  ): Promise<NativeSearchResult | 'stale'> {
    const allowed = new Set(allowlist)
    const rows = entry.rows
    let want = Math.min(rows, Math.max(k, Math.ceil((k * rows) / allowlist.length)))
    for (let round = 0; ; round++) {
      // A later round must not see a mutation the first one didn't.
      if (round > 0 && (entry.native !== native || entry.revision !== revision)) return 'stale'
      const ids = new BigUint64Array(k).fill(PADDING_ID)
      const scores = new Float32Array(k)
      if (want === 0) return { scores, ids, k }
      const result = await native.search(query, want, options)
      let found = 0
      let returned = 0
      while (returned < result.k && result.ids[returned] !== PADDING_ID) {
        const id = result.ids[returned]
        if (found < k && allowed.has(id)) {
          ids[found] = id
          scores[found++] = result.scores[returned]
        }
        returned++
      }
      if (found === k || returned < want || want >= rows) return { scores, ids, k }
      want = Math.min(rows, want * 2)
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
    let stored: Awaited<ReturnType<SnapshotStore['read']>>
    try {
      stored = await entry.store.read(identity)
    } catch (error) {
      entry.snapshotError = { error }
      return
    }
    // A snapshot ahead of the database belongs to a state this store never
    // reached, so it can't be trusted.
    if (!stored || stored.revision > revision) return
    let native: NativeIndex
    try {
      if (!module.load) return
      native = await module.load(stored.path)
    } catch {
      return
    }
    const bitWidth = native.bitWidth ?? BIT_WIDTHS[identity.storage]
    if (native.dim !== identity.dimensions || bitWidth !== BIT_WIDTHS[identity.storage]) {
      retire(native)
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
    const native = entry.native as NativeIndex
    let expected = entry.revision + 1
    const stream = reader.find<MutationRecord>(MUTATIONS, {
      gte: { namespace, revision: expected },
      lte: { namespace, revision: target }
    })
    for await (const mutation of stream) {
      if (mutation.revision !== expected) return false
      const added = unpackNativeIds(mutation.added)
      const present = await Promise.all(added.map((id) => native.contains(id)))
      const ids: bigint[] = []
      const vectors: Float32Array[] = []
      for (let i = 0; i < added.length; i++) {
        if (present[i]) continue
        // Absent rows were removed by a later mutation in this range.
        const vector = await readVector(reader, namespace, added[i])
        if (vector) {
          ids.push(added[i])
          vectors.push(vector)
        }
      }
      const removed = unpackNativeIds(mutation.removed)
      await applyRows(entry, native, mutation.revision, removed, ids, concat(vectors, native.dim))
      if (entry.native !== native) return false
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
    const native = await module.create(identity.dimensions, identity.storage)
    try {
      const dims = identity.dimensions
      const vectors = new Float32Array(REBUILD_BATCH_SIZE * dims)
      const ids = new BigUint64Array(REBUILD_BATCH_SIZE)
      let rows = 0
      const flush = async () => {
        if (rows === 0) return
        const batch = vectors.subarray(0, rows * dims)
        if (entry.normalize) normalizeRows(batch, dims)
        await native.addWithIds(batch, ids.subarray(0, rows))
        rows = 0
      }
      const namespace = entry.namespace
      const stream = reader.find<ChunkRecord>(CHUNKS, { gte: { namespace }, lte: { namespace } })
      for await (const chunk of stream) {
        checkStoredVector(chunk, dims)
        decodeVectorInto(chunk.vector, vectors, rows * dims)
        ids[rows++] = decodeNativeId(chunk.nativeId)
        if (rows === REBUILD_BATCH_SIZE) await flush()
      }
      await flush()
    } catch (error) {
      retire(native)
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
      const native = entry.native
      try {
        rows ??= vectors()
        await applyRows(
          entry,
          native,
          revision,
          removed,
          added,
          entry.normalize ? rows.slice() : rows
        )
      } catch {
        // The commit is durable; the next search rebuilds from HyperDB.
        if (entry.native === native) discard(entry)
        continue
      }
      if (entry.native !== native) continue
      if (entry.revision - entry.persistedRevision >= entry.snapshotEvery) {
        await persist(entry).catch(() => {})
      }
    }
  }

  // Snapshot failures are not fatal: the mutations stay, and the next open
  // replays them.
  function persist(entry: Entry): Promise<void> {
    const next = entry.persisting.then(() => write(entry))
    entry.persisting = next.then(
      () => {
        entry.snapshotError = null
      },
      (error: unknown) => {
        entry.snapshotError = { error }
      }
    )
    return next
  }

  async function write(entry: Entry): Promise<void> {
    const { store, native, identity } = entry
    if (!store || !native || !identity) return
    if (entry.revision <= entry.persistedRevision) return
    const revision = await onDisk(entry.namespace, () =>
      store.write(identity, (pathFor) => {
        // A rebuild may swap the index while the store awaits the filesystem.
        if (entry.native !== native) throw new Error('index replaced during snapshot')
        const revision = entry.revision
        return { revision, written: writeSettled(native, pathFor(revision), entry.settled) }
      })
    )
    if (entry.native !== native || dropped.has(entry)) return
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

  // Entries leave the map before any await, so a namespace re-created while
  // an old snapshot write finishes gets a fresh entry, never the old index.
  async function drop(
    namespace: string,
    createdAt: number,
    config: IndexConfig,
    runtime: IndexRuntime
  ): Promise<void> {
    const detached: Entry[] = []
    for (const [key, entry] of entries) {
      if (entry.namespace !== namespace) continue
      entries.delete(key)
      dropped.add(entry)
      detached.push(entry)
    }
    prunable.delete(namespace)
    for (const entry of detached) {
      while (entry.syncing) await entry.syncing.catch(() => {})
      await entry.persisting
      discard(entry)
    }
    // Every directory an index of this namespace used, not only the caller's.
    const dirs = new Set([config.dir, ...detached.map((entry) => entry.dir)])
    dirs.delete(undefined)
    // Snapshots exist only where the addon and the file system loaded.
    const { files } = runtime
    if (dirs.size === 0 || !runtime.native.module || !files) return
    for (const dir of dirs as Set<string>) {
      const store = createSnapshotStore(dir, coreKey, files)
      await onDisk(namespace, () => store.remove(namespace, createdAt))
    }
  }

  async function close(): Promise<void> {
    closed = true
    for (const entry of entries.values()) {
      while (entry.syncing) await entry.syncing.catch(() => {})
      if (entry.store && entry.native) await persistAndPrune(entry)
      discard(entry)
    }
    entries.clear()
    await Promise.all(retiring)
  }

  async function withTransaction(run: (tx: HyperDBTransaction) => Promise<void>): Promise<void> {
    const tx = await db.exclusiveTransaction()
    try {
      await run(tx)
    } finally {
      await tx.close()
    }
  }

  function retire(native: NativeIndex): void {
    const done = native.dispose().catch(() => {})
    retiring.add(done)
    void done.then(() => retiring.delete(done))
  }

  // Swap before disposing, so a search never finds a disposed index.
  function install(entry: Entry, native: NativeIndex, revision: number): void {
    const previous = entry.native
    entry.native = native
    entry.revision = revision
    entry.rows = native.length
    entry.settled = SETTLED
    entry.tombstones = 0
    entry.needsPrepare = true
    if (previous && previous !== native) retire(previous)
  }

  function discard(entry: Entry): void {
    const previous = entry.native
    entry.native = null
    entry.revision = 0
    entry.rows = 0
    entry.settled = SETTLED
    entry.persistedRevision = 0
    entry.tombstones = 0
    if (previous) retire(previous)
  }

  function status(namespace: string, config: IndexConfig, runtime: IndexRuntime): IndexStatus {
    const { native } = runtime
    if (!native.module) {
      return native.error === undefined
        ? { mode: 'scan', reason: native.reason }
        : { mode: 'scan', reason: native.reason, error: native.error }
    }
    const entry = entries.get(keyOf(namespace, config, runtime))
    if (entry?.failure) return { mode: 'scan', ...entry.failure }
    if (!entry?.native) return { mode: 'unopened' }
    let snapshot: Extract<IndexStatus, { mode: 'index' }>['snapshot'] = 'off'
    if (entry.snapshotError) snapshot = { error: entry.snapshotError.error }
    else if (entry.store) snapshot = 'ok'
    return { mode: 'index', revision: entry.revision, snapshot }
  }

  return { open, status, prune, apply, drop, close }
}

const SETTLED = Promise.resolve(true)

// Issues `calls` in one synchronous step and moves the entry to `revision`,
// so a later search sees all of them and an earlier one none.
function issue(
  entry: Entry,
  native: NativeIndex,
  revision: number,
  calls: Array<() => Promise<unknown>>,
  adds = 0
): Promise<unknown[]> {
  const outcomes = Promise.allSettled(calls.map((call) => call()))
  if (entry.native === native) {
    entry.revision = revision
    entry.rows += adds
    const previous = entry.settled
    entry.settled = outcomes.then(
      async (results) => (await previous) && results.every((r) => r.status === 'fulfilled')
    )
  }
  return outcomes.then((results) =>
    results.map((result) => {
      if (result.status === 'rejected') throw result.reason
      return result.value
    })
  )
}

async function applyRows(
  entry: Entry,
  native: NativeIndex,
  revision: number,
  removed: bigint[],
  added: bigint[],
  vectors: Float32Array
): Promise<void> {
  const calls: Array<() => Promise<unknown>> = removed.map((id) => () => native.remove(id))
  if (added.length > 0) {
    if (entry.normalize) normalizeRows(vectors, native.dim)
    calls.push(() => native.addWithIds(vectors, BigUint64Array.from(added)))
  }
  const results = await issue(entry, native, revision, calls, added.length)
  if (entry.native !== native) return
  if (entry.revision === revision) entry.rows = native.length
  for (let i = 0; i < removed.length; i++) {
    if (results[i] === true) entry.tombstones++
  }
  if (calls.length > 0) entry.needsPrepare = true
  const compact = native.compact?.bind(native)
  if (!compact) return
  if (entry.tombstones === 0 || entry.tombstones < native.length * COMPACT_SHARE) return
  await issue(entry, native, entry.revision, [compact])
  if (entry.native !== native) return
  entry.tombstones = 0
  entry.needsPrepare = true
}

async function writeSettled(
  native: NativeIndex,
  path: string,
  settled: Promise<boolean>
): Promise<void> {
  if (!native.write) throw new Error('the index provider has no write()')
  await native.write(path)
  if (!(await settled)) throw new Error('a mutation before the snapshot failed')
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
