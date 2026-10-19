import {
  assessFit,
  LayaDecisions,
  type EmbedFitResult,
  type LayaResult,
  type QvacResponse
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
