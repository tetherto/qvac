import type { LoadedDecisionInfo } from '@/schemas/index'

/** The capabilities a decision model's addon reports (DecisionEngine.info()). */
interface AddonDecisionInfo {
  decision_type: string
  noul: string
  score_levels: { min: number; max: number }
  max_input_tokens: number
}

const NOUL: Record<string, LoadedDecisionInfo['noul']> = {
  probability: 'probability',
  expected_rating: 'expectedRating'
}

/**
 * getLoadedModelInfo's `decision` field for a loaded decision model, from the
 * capabilities its addon reported at load. Undefined when the model has none.
 * A `noul` meaning this SDK does not know is reported as "unknown".
 */
export function describeDecisionModel(model: unknown): LoadedDecisionInfo | undefined {
  const info = (model as { info?: AddonDecisionInfo | null } | null)?.info
  if (!info) return undefined
  return {
    decisionType: info.decision_type,
    noul: NOUL[info.noul] ?? 'unknown',
    scoreLevels: { min: info.score_levels.min, max: info.score_levels.max },
    maxInputTokens: info.max_input_tokens
  }
}
