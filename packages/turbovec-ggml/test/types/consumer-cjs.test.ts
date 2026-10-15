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
