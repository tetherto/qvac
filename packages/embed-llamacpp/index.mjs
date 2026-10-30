import GGMLBert from './index.js'
import addon from './addon.js'

const { BertInterface, mapAddonEvent } = addon
const {
  assessFit,
  validateModelPath,
  LayaDecisions,
  LayaInterface,
  mapLayaEvent,
  Reranker,
  RerankInterface,
  mapRerankEvent
} = GGMLBert

export default GGMLBert
export {
  assessFit,
  BertInterface,
  GGMLBert,
  LayaDecisions,
  LayaInterface,
  mapAddonEvent,
  mapLayaEvent,
  mapRerankEvent,
  validateModelPath,
  RerankInterface,
  Reranker
}
