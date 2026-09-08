import GGMLBert from '@qvac/embed-llamacpp'
import IdMapIndex, {
  IdMapIndex as NamedIdMapIndex,
  IdMapIndexFilter
} from '@qvac/embed-llamacpp/idMapIndex'

const rootConstructor: typeof GGMLBert = GGMLBert
const sameConstructor: typeof NamedIdMapIndex = IdMapIndex
const filterConstructor: typeof IdMapIndexFilter = IdMapIndex.IdMapIndexFilter

void rootConstructor
void sameConstructor
void filterConstructor

export function getRootDefaultImport() {
  return GGMLBert
}

export function getDefaultImport() {
  return IdMapIndex
}
