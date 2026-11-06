import GGMLBert from './index.js'
import addon from './addon.js'

const { BertInterface, mapAddonEvent } = addon
const {
  assessFit,
  validateModelPath,
  DecisionEngine,
  DecisionEngineInterface,
  mapDecisionEngineEvent,
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
  DecisionEngine,
  DecisionEngineInterface,
  GGMLBert,
  LayaDecisions,
  LayaInterface,
  mapAddonEvent,
  mapDecisionEngineEvent,
  mapLayaEvent,
  mapRerankEvent,
  validateModelPath,
  RerankInterface,
  Reranker
}
