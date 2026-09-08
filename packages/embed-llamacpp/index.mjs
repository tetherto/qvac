import GGMLBert from './index.js'
import addon from './addon.js'

const { BertInterface, mapAddonEvent } = addon
const { pickPrimaryGgufPath } = GGMLBert

const { IdMapIndex, IdMapIndexFilter } = GGMLBert

export default GGMLBert
export { BertInterface, GGMLBert, IdMapIndex, IdMapIndexFilter, mapAddonEvent, pickPrimaryGgufPath }
