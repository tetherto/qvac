import { z } from 'zod'
import type { NativeProbeVerdict } from '@/schemas/assess-model-fit'

/**
 * What the engine fitter's verdict does to a load. Only `does-not-fit` blocks
 * under `refuse`: `unknown` is what an engine with no fitter, an unresolved
 * companion set and a host reporting no memory all answer.
 */
export const modelFitPolicySchema = z.enum(['log', 'refuse', 'off'])

export type ModelFitPolicy = z.infer<typeof modelFitPolicySchema>

export const DEFAULT_MODEL_FIT_POLICY: ModelFitPolicy = 'log'

export function resolveModelFitPolicy(
  perCall: ModelFitPolicy | undefined,
  configured: ModelFitPolicy | undefined
): ModelFitPolicy {
  return perCall ?? configured ?? DEFAULT_MODEL_FIT_POLICY
}

export function runsProbe(policy: ModelFitPolicy): boolean {
  return policy !== 'off'
}

export function refusesLoad(
  policy: ModelFitPolicy,
  verdict: NativeProbeVerdict | undefined
): boolean {
  return policy === 'refuse' && verdict === 'does-not-fit'
}
