import GGMLBert from './index.js'
import addon from './addon.js'

const { BertInterface, mapAddonEvent } = addon
const { pickPrimaryGgufPath } = GGMLBert

function loadIdMapIndex() {
  return GGMLBert.IdMapIndex
}

class IdMapIndex {
  constructor(...args) {
    const ActualIdMapIndex = loadIdMapIndex()
    return new ActualIdMapIndex(...args)
  }

  static load(path) {
    return loadIdMapIndex().load(path)
  }

  static loadMmap(path) {
    return loadIdMapIndex().loadMmap(path)
  }

  static loadWithDelta(snapshotPath, deltaPath) {
    return loadIdMapIndex().loadWithDelta(snapshotPath, deltaPath)
  }

  static get Filter() {
    return IdMapIndexFilter
  }

  static get IdMapIndex() {
    return IdMapIndex
  }

  static get IdMapIndexFilter() {
    return IdMapIndexFilter
  }

  static [Symbol.hasInstance](instance) {
    return instance instanceof loadIdMapIndex()
  }
}

class IdMapIndexFilter {
  constructor(...args) {
    const ActualIdMapIndexFilter = loadIdMapIndex().IdMapIndexFilter
    return new ActualIdMapIndexFilter(...args)
  }

  static [Symbol.hasInstance](instance) {
    return instance instanceof loadIdMapIndex().IdMapIndexFilter
  }
}

export default GGMLBert
export { BertInterface, GGMLBert, IdMapIndex, IdMapIndexFilter, mapAddonEvent, pickPrimaryGgufPath }
