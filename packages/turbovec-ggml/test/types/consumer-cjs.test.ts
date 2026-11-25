import RootIdMapIndex from '@qvac/turbovec-ggml'
import IdMapIndex, {
  IdMapIndex as NamedIdMapIndex,
  IdMapIndexCallOptions,
  IdMapIndexFilter,
  IdMapIndexStorage,
  IdMapIndexWriteOptions
} from '@qvac/turbovec-ggml/idMapIndex'

const rootConstructor: typeof NamedIdMapIndex = RootIdMapIndex
const sameConstructor: typeof NamedIdMapIndex = IdMapIndex
const filterConstructor: typeof IdMapIndexFilter = IdMapIndex.IdMapIndexFilter

void rootConstructor
void sameConstructor
void filterConstructor

export function getRootDefaultImport() {
  return RootIdMapIndex
}

export function getDefaultImport() {
  return IdMapIndex
}

class SubIdMapIndex extends IdMapIndex {}

// Compile-time checks of the declared types; never called.
export async function checkAsyncTypes(index: IdMapIndex, query: Float32Array, ids: BigUint64Array) {
  const hits: { ids: BigUint64Array; scores: Float32Array; m: number; k: number } =
    await index.search(query, 1)
  const removed: boolean = await index.remove(1n)
  const present: boolean = await index.contains(1n)
  const filter: IdMapIndexFilter = await index.prepareFilter(ids)
  const filtered: { ids: BigUint64Array } = await filter.search(query, 1)
  const loaded: SubIdMapIndex = await SubIdMapIndex.load('index.tvim')
  const added: void = await index.addWithIds(query, ids)
  const built: void = await index.buildIvf(1)
  const staged: void = await index.setStagedSearch(true)
  const length: number = index.length
  const synced: void = await index.sync('index.tvim')
  const listed: BigUint64Array = await index.ids()
  const bytes: Uint8Array = await index.toBytes()
  const restored: SubIdMapIndex = await SubIdMapIndex.fromBytes(bytes)
  const threadsSet: void = await index.setThreads(4)
  const threads: number = index.threads
  const storage: IdMapIndexStorage = index.storage
  const legacy: boolean = index.legacy
  const writeOptions: IdMapIndexWriteOptions = { durability: 'fast' }
  const written: void = await index.write('index.tvim', writeOptions)
  const q3 = new IdMapIndex({ dim: 128, storage: 'turbovec-q3', threads: 2 })
  const q3ByWidth = new IdMapIndex({ dim: 128, bitWidth: 3 })
  const filterFreed: Promise<void> = filter.dispose()
  const freed: void = await index.dispose()
  return {
    hits,
    removed,
    present,
    filtered,
    loaded,
    added,
    built,
    staged,
    length,
    synced,
    listed,
    restored,
    threadsSet,
    threads,
    storage,
    legacy,
    written,
    q3,
    q3ByWidth,
    filterFreed,
    freed
  }
}

// The shape of an AbortSignal from bare-abort-controller, the DOM, or Node.
interface SignalLike {
  readonly aborted: boolean
  readonly reason: unknown
  addEventListener(
    type: 'abort',
    listener: (event: unknown) => void,
    options?: { once?: boolean }
  ): void
  removeEventListener(type: 'abort', listener: (event: unknown) => void): void
}

export async function checkSignalTypes(index: IdMapIndex, query: Float32Array, signal: SignalLike) {
  const options: IdMapIndexCallOptions = { signal }
  await index.search(query, 1, options)
  await index.buildIvf(4, 0, { signal })
  return IdMapIndex.load('index.tvim', { signal })
}
