import GGMLBert from './index.js'
import addon from './addon.js'

const { BertInterface, mapAddonEvent } = addon
const {
  assessFit,
  validateModelPath,
  DecisionEngine,
  DecisionEngineInterface,
  mapDecisionEngineEvent,
  DECISION_INVALID_REQUEST,
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
  DECISION_INVALID_REQUEST,
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
