import {
  assessFit,
  LayaDecisions,
  type EmbedFitResult,
  Reranker,
  type GGMLConfig,
  type LayaResult,
  type QvacResponse,
  type RerankScores
} from '@qvac/embed-llamacpp'

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false

// run() resolves to one result for `state` and one per state for `states`.
export function layaRunTypes(laya: LayaDecisions) {
  const questions = { q: { type: 'noul' as const, instructions: 'It holds.' } }
  const single = laya.run({ state: 'text', questions })
  const batch = laya.run({ states: ['a', 'b'], questions })
  const singleTyped: Equal<Awaited<typeof single>, QvacResponse<LayaResult>> =
    true
  const batchTyped: Equal<Awaited<typeof batch>, QvacResponse<LayaResult[]>> =
    true
  return { singleTyped, batchTyped }
}

// assessFit returns a Promise of the projection.
export function fitTypes() {
  const fit = assessFit({ modelPath: '/abs/model.gguf' })
  const fitTyped: Equal<typeof fit, Promise<EmbedFitResult>> = true
  return fitTyped
}

// run() resolves to one score per document.
export function rerankRunTypes(reranker: Reranker) {
  const response = reranker.run({ query: 'q', documents: ['a', 'b'] })
  const typed: Equal<Awaited<typeof response>, QvacResponse<RerankScores>> =
    true
  const scores: Equal<RerankScores, number[]> = true
  return { typed, scores }
}

// GGMLBert has no rank pooling: it returns classifier scores, not embeddings.
// @ts-expect-error 'rank' is not an embedding pooling
export const rankPooling: GGMLConfig['pooling'] = 'rank'
