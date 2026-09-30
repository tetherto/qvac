import GGMLBert from './index.js'
import addon from './addon.js'

const { BertInterface, mapAddonEvent } = addon
const { assessFit, pickPrimaryGgufPath } = GGMLBert

const { IdMapIndex, IdMapIndexFilter } = GGMLBert

export default GGMLBert
export {
  assessFit,
  BertInterface,
  GGMLBert,
  IdMapIndex,
  IdMapIndexFilter,
  mapAddonEvent,
  pickPrimaryGgufPath
}
