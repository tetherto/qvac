import RootIdMapIndex from '@qvac/turbovec-ggml'
import IdMapIndex, {
  IdMapIndex as NamedIdMapIndex,
  IdMapIndexFilter
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

// Compile-time checks of the async API's declared types; never called.
export async function checkAsyncTypes(index: IdMapIndex, query: Float32Array, ids: BigUint64Array) {
  const hits: { ids: BigUint64Array; scores: Float32Array; m: number; k: number } =
    await index.searchAsync(query, 1)
  const removed: boolean = await index.removeAsync(1n)
  const filter: IdMapIndexFilter = await index.prepareFilterAsync(ids)
  const filtered: { ids: BigUint64Array } = await filter.searchAsync(query, 1)
  const loaded: SubIdMapIndex = await SubIdMapIndex.loadAsync('index.tvim')
  const added: void = await index.addWithIdsAsync(query, ids)
  const built: void = await index.buildIvfAsync(1)
  await index.disposeAsync()
  return { hits, removed, filtered, loaded, added, built }
}
